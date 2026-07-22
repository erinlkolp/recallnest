import { describe, expect, it } from "bun:test";

import { createRetriever } from "../retriever.js";

function buildEntry(
  id: string,
  vector: number[],
  score: number,
  metadata: Record<string, unknown>,
) {
  return {
    entry: {
      id,
      text: `memory ${id}`,
      vector,
      category: "events",
      scope: "memory:agent",
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: JSON.stringify(metadata),
    },
    score,
  };
}

describe("retriever anchor/multi-vector boost vs rerank-pool truncation", () => {
  it("keeps a boosted candidate that was fused-ranked below the rerank pool", async () => {
    // Five candidates. The anchored one ("boosted") is deliberately placed LAST
    // by initial fused score, i.e. below the rerank pool of limit*2 = 4. Its
    // anchor matches the query, so the anchor-boost stage lifts its score above
    // the others. If the rerank pool is sliced by the stale fused order (before
    // re-sorting on the boosted score), this candidate is dropped before rerank
    // and never surfaces — even though its boosted score belongs in the top-2.
    const retriever = createRetriever({
      hasFtsSupport: true,
      async vectorSearch() {
        return [
          buildEntry("a", [0, 1, 0], 0.90, { source: "agent" }),
          buildEntry("b", [0, 1, 0], 0.89, { source: "agent" }),
          buildEntry("c", [0, 1, 0], 0.88, { source: "agent" }),
          buildEntry("d", [0, 1, 0], 0.87, { source: "agent" }),
          buildEntry("boosted", [1, 0, 0], 0.86, {
            source: "agent",
            anchor: "zebrafish quokka anchor",
          }),
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
      rerank: "lightweight",
      candidatePoolSize: 20,
      filterNoise: false,
      hardMinScore: 0,
      minScore: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
    });

    const results = await retriever.retrieve({
      query: "zebrafish quokka anchor",
      limit: 2,
    });

    const ids = results.map(r => r.entry.id);
    expect(ids).toContain("boosted");
  });
});
