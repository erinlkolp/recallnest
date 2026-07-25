import { describe, expect, it } from "bun:test";

import { createRetriever } from "../retriever.js";

/**
 * Regression: an explicit search_memory call with a short query returned
 * "No results found".
 *
 * Retriever.retrieve() applied shouldSkipRetrieval() to every call. That
 * heuristic exists to stop *passive auto-recall* from burning an embedding
 * call on filler like "ok" / "thanks", and it skips any non-CJK query under
 * 15 characters. Applied to a deliberate tool call it silently swallowed
 * ordinary keyword searches ("LanceDB", "checkpoint", "duplicate rows") and
 * reported them as an empty memory store.
 */

const ENTRY = {
  id: "entry-lancedb",
  text: "LanceDB stores vectors at dimension 1024 using Jina v5 embeddings.",
  vector: [1, 0, 0],
  category: "entities",
  scope: "project:recallnest",
  importance: 0.5,
  timestamp: Date.parse("2026-07-25T00:00:00.000Z"),
  metadata: "{}",
};

function buildRetriever() {
  return createRetriever({
    hasFtsSupport: false,
    async vectorSearch() {
      return [{ entry: ENTRY, score: 0.9 }];
    },
  } as never, {
    async embedQuery() {
      return [1, 0, 0];
    },
    async embedPassage() {
      return [1, 0, 0];
    },
  } as never, {
    mode: "vector",
    rerank: "none",
    filterNoise: false,
    hardMinScore: 0,
    minScore: 0,
    recencyWeight: 0,
    timeDecayHalfLifeDays: 0,
  });
}

describe("explicit retrieval is not gated by the trivial-query heuristic", () => {
  it("returns results for a single-word explicit query", async () => {
    const results = await buildRetriever().retrieve({
      query: "LanceDB",
      limit: 5,
    });

    expect(results).toHaveLength(1);
  });

  it("returns results for a 14-character explicit query", async () => {
    // 14 chars — one below the old 15-char auto-recall threshold.
    const results = await buildRetriever().retrieve({
      query: "duplicate rows",
      limit: 5,
    });

    expect(results).toHaveLength(1);
  });

  it("still skips a trivial query for passive auto-recall", async () => {
    const results = await buildRetriever().retrieve({
      query: "ok",
      limit: 5,
      source: "auto-recall",
    });

    expect(results).toEqual([]);
  });

  it("still skips a short non-question query for passive auto-recall", async () => {
    const results = await buildRetriever().retrieve({
      query: "LanceDB",
      limit: 5,
      source: "auto-recall",
    });

    expect(results).toEqual([]);
  });
});
