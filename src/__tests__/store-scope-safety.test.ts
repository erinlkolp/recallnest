import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";
import { matchesScopeFilter } from "../scope-policy.js";

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
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-scope-safety-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({
    dbPath,
    vectorDim: 3,
  });
}

async function seed(store: MemoryStore, scope: string, text: string): Promise<string> {
  const entry = await store.store({
    text,
    vector: [1, 0, 0],
    category: "entities",
    scope,
    importance: 0.5,
    metadata: "{}",
  });
  return entry.id;
}

describe("matchesScopeFilter separator boundary", () => {
  it("does not treat a sibling scope family as a prefix match", () => {
    expect(matchesScopeFilter("recallnest-docs", ["recallnest"])).toBe(false);
    expect(matchesScopeFilter("recallnest2:x", ["recallnest"])).toBe(false);
    expect(matchesScopeFilter("ccx:session1", ["cc"])).toBe(false);
  });

  it("still matches exact scopes and ':'-separated children", () => {
    expect(matchesScopeFilter("recallnest", ["recallnest"])).toBe(true);
    expect(matchesScopeFilter("recallnest:sub", ["recallnest"])).toBe(true);
    expect(matchesScopeFilter("cc:session-123", ["cc"])).toBe(true);
    expect(matchesScopeFilter("project:recallnest", ["project:recallnest"])).toBe(true);
  });
});

describe("MemoryStore.bulkDelete scope safety", () => {
  it("does not treat '_' in a scope as a SQL LIKE wildcard", async () => {
    const store = createStore();
    await seed(store, "my_proj:a", "inside underscore scope");
    const outsideId = await seed(store, "myxproj:b", "outside scope that a wildcard would catch");

    const deleted = await store.bulkDelete(["my_proj"]);

    expect(deleted).toBe(1);
    expect(await store.get(outsideId, ["myxproj"])).not.toBeNull();
  });

  it("does not delete sibling scope families sharing a name prefix", async () => {
    const store = createStore();
    await seed(store, "recallnest", "exact scope row");
    await seed(store, "recallnest:sub", "child scope row");
    const siblingId = await seed(store, "recallnest-docs:x", "sibling family row");

    const deleted = await store.bulkDelete(["recallnest"]);

    expect(deleted).toBe(2);
    expect(await store.get(siblingId, ["recallnest-docs"])).not.toBeNull();
  });
});

describe("MemoryStore.list scope safety", () => {
  it("excludes sibling scope families from prefix-scope listings", async () => {
    const store = createStore();
    await seed(store, "recallnest:sub", "child scope row");
    await seed(store, "recallnest-docs:x", "sibling family row");

    const rows = await store.list(["recallnest"], undefined, 10);

    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("recallnest:sub");
  });

  it("does not treat '_' in a scope filter as a wildcard when listing", async () => {
    const store = createStore();
    await seed(store, "my_proj:a", "inside underscore scope");
    await seed(store, "myxproj:b", "outside scope");

    const rows = await store.list(["my_proj"], undefined, 10);

    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("my_proj:a");
  });
});

describe("MemoryStore.stats scope safety", () => {
  it("does not count sibling scope families in prefix-scope stats", async () => {
    const store = createStore();
    await seed(store, "my_proj:a", "inside underscore scope");
    await seed(store, "myxproj:b", "outside scope");
    await seed(store, "recallnest-docs:x", "sibling family row");
    await seed(store, "recallnest:sub", "child scope row");

    const underscoreStats = await store.stats(["my_proj"]);
    expect(underscoreStats.totalCount).toBe(1);
    expect(Object.keys(underscoreStats.scopeCounts)).toEqual(["my_proj:a"]);

    const prefixStats = await store.stats(["recallnest"]);
    expect(prefixStats.totalCount).toBe(1);
    expect(Object.keys(prefixStats.scopeCounts)).toEqual(["recallnest:sub"]);
  });
});
