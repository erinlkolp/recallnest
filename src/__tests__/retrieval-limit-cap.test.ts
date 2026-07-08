import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";
import { createRetriever } from "../retriever.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function createStore(): MemoryStore {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-limit-cap-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({
    dbPath,
    vectorDim: 3,
  });
}

describe("store search limits honor the advertised cap of 100", () => {
  it("vectorSearch returns more than 20 results when asked", async () => {
    const store = createStore();
    for (let i = 0; i < 25; i++) {
      await store.store({
        text: `deployment note number ${i}`,
        vector: [1, 0, 0],
        category: "entities",
        scope: "project:limits",
        importance: 0.5,
        metadata: "{}",
      });
    }

    const results = await store.vectorSearch([1, 0, 0], 25, 0.1, ["project:limits"]);

    expect(results).toHaveLength(25);
  });
});

describe("retriever limit honors the advertised cap of 100", () => {
  it("returns more than 20 results when the store has them", async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      entry: {
        id: `entry-${i}`,
        text: `deployment configuration detail ${i}`,
        vector: [1, 0, 0],
        category: "entities",
        scope: "project:limits",
        importance: 0.5,
        timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
        metadata: "{}",
      },
      score: 0.8,
    }));

    const retriever = createRetriever({
      hasFtsSupport: false,
      async vectorSearch() {
        return entries;
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

    const results = await retriever.retrieve({
      query: "deployment configuration details",
      limit: 25,
    });

    expect(results).toHaveLength(25);
  });
});
