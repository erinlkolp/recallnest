import { describe, it, expect } from "bun:test";

import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../retriever.js";

function buildEntry(id: string, vector: number[], score: number, textLen: number) {
  return {
    entry: {
      id,
      text: "w ".repeat(Math.ceil(textLen / 2)).slice(0, textLen),
      vector,
      category: "cases",
      scope: "memory:agent",
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: JSON.stringify({ source: "agent" }),
    },
    score,
  };
}

function makeRetriever(entries: ReturnType<typeof buildEntry>[]) {
  return createRetriever({
    hasFtsSupport: true,
    async vectorSearch() { return entries; },
    async bm25Search() { return []; },
  } as any, {
    async embedQuery() { return [1, 0, 0, 0, 0]; },
    async embedPassage() { return [1, 0, 0, 0, 0]; },
  } as any, {
    mode: "hybrid",
    rerank: "lightweight",
    candidatePoolSize: 20,
    filterNoise: false,
    hardMinScore: 0,
    minScore: 0,
    recencyWeight: 0,
    timeDecayHalfLifeDays: 0,
  });
}

describe("length normalization anchor", () => {
  it("does not penalize a normal structured case memory", async () => {
    // store_case writes Problem/Solution records; in a real store the `cases`
    // category had p50=1147 and p90=1530 chars. At the old 500-char anchor that
    // median took a x0.625 cut — 81% of all rows were penalized — so a strong
    // direct match lost to shorter, weaker entries purely on length.
    const retriever = makeRetriever([
      buildEntry("case", [1, 0, 0, 0, 0], 0.90, 1150),
      buildEntry("shrt1", [0.6, 0.8, 0, 0, 0], 0.85, 300),
      buildEntry("shrt2", [0.6, 0, 0.8, 0, 0], 0.85, 300),
      buildEntry("shrt3", [0.6, 0, 0, 0.8, 0], 0.85, 300),
    ]);

    const results = await retriever.retrieve({ query: "the case memory", limit: 3 });
    expect(results[0]?.entry.id).toBe("case");
  });

  it("still damps genuinely sprawling entries", async () => {
    // The stage has a real job — keyword-dense sprawl should not dominate top-k.
    // Raising the anchor must not turn it into a no-op: an entry well past the
    // long tail (p99 was 2039) still loses to a normal-length closer match.
    const retriever = makeRetriever([
      buildEntry("sprawl", [1, 0, 0, 0, 0], 0.90, 3000),
      buildEntry("normal", [0.8, 0.6, 0, 0, 0], 0.88, 800),
    ]);

    const results = await retriever.retrieve({ query: "the memory", limit: 2 });
    expect(results[0]?.entry.id).toBe("normal");
  });

  it("documents the shipped anchor", () => {
    expect(DEFAULT_RETRIEVAL_CONFIG.lengthNormAnchor).toBe(1500);
  });
});
