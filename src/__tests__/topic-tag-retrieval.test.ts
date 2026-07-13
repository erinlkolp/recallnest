import { describe, expect, it } from "bun:test";

import { createRetriever } from "../retriever.js";
import { extractTopicTag } from "../topic-tag.js";

// Three high-scoring UNTAGGED entries + five lower-scoring entries tagged
// "deploy". By score alone the untagged entries fill the top-`limit`, so a
// topicTag filter applied after the limit-slice would wrongly return nothing.
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
        text: `deployment configuration detail ${i}`,
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
  });
}

describe("topicTag retrieval fills the limit from tagged matches", () => {
  it("returns limit tagged results even when higher-scoring untagged entries exist", async () => {
    const retriever = makeRetriever();

    const results = await retriever.retrieve({
      query: "deployment configuration details",
      limit: 3,
      topicTag: "deploy",
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(extractTopicTag(r.entry.metadata)).toBe("deploy");
    }
  });
});
