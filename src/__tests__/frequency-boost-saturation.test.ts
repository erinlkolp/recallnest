import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

import { FrequencyTracker } from "../frequency-tracker.js";
import { createRetriever } from "../retriever.js";

const TEST_DIR = join(import.meta.dir, "../../.test-data");
const TEST_FILE = join(TEST_DIR, "freq-saturation-test.json");

function cleanup() {
  try { if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE); } catch {}
}

function hit(tracker: FrequencyTracker, id: string, times: number) {
  for (let i = 0; i < times; i++) tracker.recordHits([id]);
}

function buildEntry(id: string, vector: number[], score: number) {
  return {
    entry: {
      id,
      text: `memory ${id}`,
      vector,
      category: "events",
      scope: "memory:agent",
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: JSON.stringify({ source: "agent" }),
    },
    score,
  };
}

describe("frequency boost saturation", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    cleanup();
  });
  afterEach(cleanup);

  it("caps the boost multiplier regardless of hit count", () => {
    const tracker = new FrequencyTracker({ filePath: TEST_FILE });

    // Real production stores reach these counts: the live frequency-stats.json
    // had entries at 135 hits, which produced an uncapped x2.06 multiplier.
    hit(tracker, "hot", 135);
    expect(tracker.getBoostMultiplier("hot")).toBeLessThanOrEqual(1.15);

    // And it stays bounded as the count keeps climbing — the tracker is fed by
    // every retrieval, so a popular memory's count only ever grows.
    hit(tracker, "hotter", 5000);
    expect(tracker.getBoostMultiplier("hotter")).toBeLessThanOrEqual(1.15);

    // Still a real signal below the cap, not flattened to a no-op.
    hit(tracker, "warm", 3);
    const warm = tracker.getBoostMultiplier("warm");
    expect(warm).toBeGreaterThan(1.0);
    expect(warm).toBeLessThan(1.15);

    tracker.dispose();
  });

  it("does not let frequently-retrieved memories evict a stronger direct match", async () => {
    const tracker = new FrequencyTracker({ filePath: TEST_FILE });
    // Four popular-but-weaker memories, one never-retrieved exact match.
    for (const id of ["po1", "po2", "po3", "po4"]) hit(tracker, id, 135);

    const retriever = createRetriever({
      hasFtsSupport: true,
      async vectorSearch() {
        return [
          // The direct match: highest similarity, zero retrieval history.
          buildEntry("tgt", [1, 0, 0, 0, 0], 0.98),
          // Weaker matches that have been returned hundreds of times.
          buildEntry("po1", [0.6, 0.8, 0, 0, 0], 0.75),
          buildEntry("po2", [0.6, 0, 0.8, 0, 0], 0.75),
          buildEntry("po3", [0.6, 0, 0, 0.8, 0], 0.75),
          buildEntry("po4", [0.6, 0, 0, 0, 0.8], 0.75),
        ];
      },
      async bm25Search() {
        return [];
      },
    } as any, {
      async embedQuery() {
        return [1, 0, 0, 0, 0];
      },
      async embedPassage() {
        return [1, 0, 0, 0, 0];
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
    retriever.setFrequencyTracker(tracker);

    const results = await retriever.retrieve({ query: "memory tgt", limit: 3 });

    expect(results[0]?.entry.id).toBe("tgt");

    // Scores must stay below the 1.0 clamp: an uncapped multiplier pushed every
    // popular memory past it, collapsing them into a tie that made the sort a
    // no-op and truncated the true best match out of the result window.
    const clamped = results.filter(r => r.score >= 1.0);
    expect(clamped.length).toBeLessThanOrEqual(1);

    tracker.dispose();
  });
});
