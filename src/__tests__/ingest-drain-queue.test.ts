import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { drainPendingQueue, PENDING_EXTRACTION_FILE } from "../ingest.js";
import type { Embedder } from "../embedder.js";
import type { LLMClient } from "../llm-client.js";
import type { MemoryStore } from "../store.js";

// drainPendingQueue reads/writes the real (gitignored) queue file. Snapshot and
// restore it so this test never clobbers a developer's pending queue.
let backup: string | null = null;

beforeEach(() => {
  backup = existsSync(PENDING_EXTRACTION_FILE)
    ? readFileSync(PENDING_EXTRACTION_FILE, "utf-8")
    : null;
});

afterEach(() => {
  if (backup === null) {
    rmSync(PENDING_EXTRACTION_FILE, { force: true });
  } else {
    writeFileSync(PENDING_EXTRACTION_FILE, backup);
  }
});

// LLM that always throws → smartExtractBatch falls back to heuristic extraction.
const throwingLlm = {
  async smartExtractBatch(): Promise<never> { throw new Error("no llm"); },
} as unknown as LLMClient;

// Orthogonal vectors so batch-internal dedup keeps every item.
const orthogonalEmbedder = {
  async embedBatchPassage(texts: string[]) {
    return texts.map((_, i) => {
      const v = [0, 0, 0];
      v[i % 3] = 1;
      return v;
    });
  },
} as unknown as Embedder;

describe("drainPendingQueue failure handling", () => {
  it("re-queues items that fail to store instead of dropping them", async () => {
    writeFileSync(PENDING_EXTRACTION_FILE, JSON.stringify([
      { text: "alpha durable memory content", scope: "cc:ok1", queuedAt: "2024-01-01T00:00:00Z" },
      { text: "beta durable memory content", scope: "cc:failme", queuedAt: "2024-01-01T00:00:01Z" },
      { text: "gamma durable memory content", scope: "cc:ok2", queuedAt: "2024-01-01T00:00:02Z" },
    ]));

    const store = {
      async store(entry: { scope: string }) {
        if (entry.scope === "cc:failme") throw new Error("transient store failure");
        return {} as never;
      },
    } as unknown as MemoryStore;

    const result = await drainPendingQueue(store, orthogonalEmbedder, throwingLlm);

    expect(result.processed).toBe(2);
    expect(result.errors).toBe(1);

    // The one failed item must survive in the queue for a later retry.
    const remaining = JSON.parse(readFileSync(PENDING_EXTRACTION_FILE, "utf-8"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].scope).toBe("cc:failme");
  });

  it("empties the queue when every item stores successfully", async () => {
    writeFileSync(PENDING_EXTRACTION_FILE, JSON.stringify([
      { text: "alpha durable memory content", scope: "cc:ok1", queuedAt: "2024-01-01T00:00:00Z" },
      { text: "beta durable memory content", scope: "cc:ok2", queuedAt: "2024-01-01T00:00:01Z" },
    ]));

    const store = {
      async store() { return {} as never; },
    } as unknown as MemoryStore;

    const result = await drainPendingQueue(store, orthogonalEmbedder, throwingLlm);

    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0);
    expect(JSON.parse(readFileSync(PENDING_EXTRACTION_FILE, "utf-8"))).toEqual([]);
  });
});
