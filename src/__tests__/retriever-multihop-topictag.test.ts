import { describe, expect, it } from "bun:test";

import { createRetriever } from "../retriever.js";
import { extractTopicTag } from "../topic-tag.js";

// Regression: multiHop + topicTag must not drop tagged matches.
//
// Three high-scoring UNTAGGED entries + five lower-scoring entries tagged
// "deploy". The tagged text carries a capitalized entity ("Kubernetes") that is
// NOT in the query, so multiHopExpand finds a novel entity and takes its
// merge+truncate path. Before the fix, that truncation sliced the merged pool
// back to the raw `limit` (3) BEFORE the topicTag filter ran, so only the three
// untagged entries survived and the tag filter returned nothing — even though
// five valid tagged matches existed within the over-fetch pool.
function buildEntries() {
  const entries: Array<{ entry: Record<string, unknown>; score: number }> = [];
  for (let i = 0; i < 3; i++) {
    entries.push({
      entry: {
        id: `untagged-${i}`,
        text: `general note ${i}`,
        vector: [1, 0, 0],
        category: "entities",
        scope: "project:tags",
        importance: 0.5,
        timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
        metadata: "{}",
      },
      score: 0.9,
    });
  }
  for (let i = 0; i < 5; i++) {
    entries.push({
      entry: {
        id: `deploy-${i}`,
        text: `Kubernetes deployment configuration detail ${i}`,
        vector: [1, 0, 0],
        category: "entities",
        scope: "project:tags",
        importance: 0.5,
        timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
        metadata: JSON.stringify({ topicTag: "deploy" }),
      },
      score: 0.7,
    });
  }
  return entries;
}

function makeRetriever() {
  const entries = buildEntries();
  return createRetriever({
    hasFtsSupport: false,
    async vectorSearch() {
      return entries;
    },
  } as never, {
    async embedQuery() { return [1, 0, 0]; },
    async embedPassage() { return [1, 0, 0]; },
  } as never, {
    mode: "vector",
    rerank: "none",
    filterNoise: false,
    hardMinScore: 0,
    minScore: 0,
    recencyWeight: 0,
    timeDecayHalfLifeDays: 0,
    multiHop: true,
  });
}

describe("multiHop + topicTag interaction", () => {
  it("keeps tagged matches when multiHop is enabled", async () => {
    const retriever = makeRetriever();

    const results = await retriever.retrieve({
      query: "deployment configuration details",
      limit: 3,
      topicTag: "deploy",
      multiHop: true,
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(extractTopicTag(r.entry.metadata)).toBe("deploy");
    }
  });
});
