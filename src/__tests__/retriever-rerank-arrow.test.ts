import { describe, expect, it } from "bun:test";

import { createRetriever } from "../retriever.js";

/**
 * Mimic a LanceDB Arrow Vector: it exposes `.length` and is iterable, but does
 * NOT support numeric bracket indexing (`v[i]` is undefined). Real retrieval
 * results carry vectors of this shape; mock stores using plain arrays hide it.
 */
function arrowVector(values: number[]): number[] {
  return {
    length: values.length,
    [Symbol.iterator]() {
      return values[Symbol.iterator]();
    },
  } as unknown as number[];
}

function buildEntry(id: string, vector: number[], score: number) {
  return {
    entry: {
      id,
      text: `memory ${id}`,
      vector: arrowVector(vector),
      category: "events",
      scope: "memory:agent",
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: JSON.stringify({ source: "agent" }),
    },
    score,
  };
}

describe("retriever cosine rerank fallback with Arrow vectors", () => {
  it("produces finite reranked scores instead of NaN", async () => {
    const retriever = createRetriever({
      hasFtsSupport: true,
      async vectorSearch() {
        return [
          buildEntry("a", [1, 0, 0], 0.9),
          buildEntry("b", [0, 1, 0], 0.85),
        ];
      },
      async bm25Search() {
        return [];
      },
    } as any, {
      async embedQuery() {
        return [1, 0, 0];
      },
      async embedPassage() {
        return [1, 0, 0];
      },
    } as any, {
      mode: "hybrid",
      rerank: "lightweight", // → cosine fallback path (no API key needed)
      candidatePoolSize: 20,
      filterNoise: false,
      hardMinScore: 0,
      minScore: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
    });

    const results = await retriever.retrieve({
      query: "some query text",
      limit: 5,
    });

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      // The rerank stage must record a real cosine score, not NaN.
      const rerankScore = r.sources?.reranked?.score;
      expect(rerankScore).toBeDefined();
      expect(Number.isFinite(rerankScore as number)).toBe(true);
    }
  });
});
