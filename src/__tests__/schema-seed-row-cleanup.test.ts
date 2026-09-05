import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";
import { KGStore } from "../kg-store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function freshDbPath(prefix: string): string {
  const dbPath = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(dbPath);
  return dbPath;
}

// Both stores create their table by writing a throwaway "__schema__" row and
// deleting it again. The delete predicate must use single quotes: LanceDB's SQL
// parser reads a double-quoted token as a column identifier, so `id = "__schema__"`
// fails with "No field named __schema__" and leaves the seed row behind.
describe("table creation removes the __schema__ seed row", () => {
  it("leaves a freshly created memory table empty", async () => {
    const store = new MemoryStore({ dbPath: freshDbPath("recallnest-seed-mem-"), vectorDim: 3 });

    const stats = await store.stats();

    expect(stats.totalCount).toBe(0);
    expect(Object.keys(stats.scopeCounts)).not.toContain("__schema__");
  });

  it("leaves a freshly created KG table empty", async () => {
    const store = new KGStore({ dbPath: freshDbPath("recallnest-seed-kg-") });

    expect(await store.countTriples()).toBe(0);
    expect(await store.getAllEntities()).toEqual([]);
  });

  it("does not leak the seed row into real memory data", async () => {
    const store = new MemoryStore({ dbPath: freshDbPath("recallnest-seed-mix-"), vectorDim: 3 });

    await store.store({
      text: "first real entry",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:seed-test",
      importance: 0.5,
      metadata: "{}",
      language: "en",
      fts_text: "first real entry",
    });

    const stats = await store.stats();

    expect(stats.totalCount).toBe(1);
    expect(stats.scopeCounts["project:seed-test"]).toBe(1);
    expect(stats.scopeCounts["__schema__"]).toBeUndefined();
  });
});
