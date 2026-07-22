import { describe, expect, it } from "bun:test";

import { Embedder } from "../embedder.js";

describe("Embedder transient retry", () => {
  it("retries a transient single-embedding connection error", async () => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    let calls = 0;
    (embedder as any).client = {
      embeddings: {
        create: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("Connection error. ECONNRESET");
          }
          return {
            data: [{ embedding: [1, 2, 3] }],
          };
        },
      },
    };

    await expect(embedder.embedPassage("hello")).resolves.toEqual([1, 2, 3]);
    expect(calls).toBe(2);
  });

  it("retries a transient batch embedding connection error", async () => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    let calls = 0;
    (embedder as any).client = {
      embeddings: {
        create: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("The socket connection was closed unexpectedly. ECONNRESET");
          }
          return {
            data: [
              { embedding: [1, 2, 3] },
              { embedding: [4, 5, 6] },
            ],
          };
        },
      },
    };

    await expect(embedder.embedBatchPassage(["a", "b"])).resolves.toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(calls).toBe(2);
  });

  it("does not retry non-transient embedding errors", async () => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    let calls = 0;
    (embedder as any).client = {
      embeddings: {
        create: async () => {
          calls += 1;
          throw new Error("Authentication failed");
        },
      },
    };

    await expect(embedder.embedPassage("hello")).rejects.toThrow("Failed to generate embedding: Authentication failed");
    expect(calls).toBe(1);
  });

  it("limits concurrent embedding requests", async () => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    (embedder as any)._maxConcurrentRequests = 1;

    let inFlight = 0;
    let maxInFlight = 0;
    (embedder as any).client = {
      embeddings: {
        create: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return {
            data: [{ embedding: [1, 2, 3] }],
          };
        },
      },
    };

    await Promise.all([
      embedder.embedPassage("first"),
      embedder.embedPassage("second"),
      embedder.embedPassage("third"),
    ]);

    expect(maxInFlight).toBe(1);
  });
});

describe("Embedder chunking recursion guard", () => {
  it("fails cleanly instead of recursing when chunks still exceed the context limit", async () => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    let calls = 0;
    (embedder as any).client = {
      embeddings: {
        create: async () => {
          calls += 1;
          throw new Error("This model's maximum context length has been exceeded");
        },
      },
    };

    // Long enough that smartChunk splits it; every chunk also "exceeds" the limit.
    const text = "word ".repeat(3000);

    await expect(embedder.embedPassage(text)).rejects.toThrow(/Failed to generate embedding/);
    // 1 original attempt + one attempt per first-level chunk; must not grow unbounded.
    expect(calls).toBeLessThan(20);
  }, 10_000);
});

describe("Embedder batch response integrity", () => {
  it("throws instead of silently dropping chunks when the provider under-returns", async () => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
      chunking: false, // don't route the mismatch through the auto-chunk path
    });

    (embedder as any).client = {
      embeddings: {
        // Sent 3 inputs, provider returns only 2 embeddings (trailing drop).
        create: async () => ({
          data: [
            { index: 0, embedding: [1, 1, 1] },
            { index: 1, embedding: [2, 2, 2] },
          ],
        }),
      },
    };

    await expect(embedder.embedBatchPassage(["aaa", "bbb", "ccc"])).rejects.toThrow(/count mismatch/i);
  });

  it("maps embeddings by the provider index, not response position (no misalignment)", async () => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
      chunking: false,
    });

    (embedder as any).client = {
      embeddings: {
        // Correct count but OUT OF ORDER; index field is authoritative.
        create: async () => ({
          data: [
            { index: 2, embedding: [3, 3, 3] },
            { index: 0, embedding: [1, 1, 1] },
            { index: 1, embedding: [2, 2, 2] },
          ],
        }),
      },
    };

    await expect(embedder.embedBatchPassage(["aaa", "bbb", "ccc"])).resolves.toEqual([
      [1, 1, 1],
      [2, 2, 2],
      [3, 3, 3],
    ]);
  });
});
