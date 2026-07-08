import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";

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
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-canonical-lookup-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim: 3 });
}

function durableMetadata(canonicalKey: string): string {
  return JSON.stringify({ canonicalKey, boundary: { layer: "durable" } });
}

describe("MemoryStore.listByCanonicalKey", () => {
  it("finds entries by canonical key regardless of recency", async () => {
    const store = createStore();
    const old = await store.store({
      text: "user prefers bun over npm",
      vector: [1, 0, 0],
      category: "preferences",
      scope: "project:test",
      importance: 0.7,
      metadata: durableMetadata("preferences:tooling:bun"),
    });
    await store.store({
      text: "unrelated memory",
      vector: [0, 1, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata("events:unrelated"),
    });

    const matches = await store.listByCanonicalKey("preferences:tooling:bun");
    expect(matches.map(m => m.id)).toEqual([old.id]);
    expect(matches[0].text).toBe("user prefers bun over npm");
  });

  it("does not treat LIKE wildcards in keys as wildcards", async () => {
    const store = createStore();
    await store.store({
      text: "underscore key entry",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata("entities:a_b"),
    });
    await store.store({
      text: "would match a naive wildcard",
      vector: [0, 1, 0],
      category: "entities",
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata("entities:aXb"),
    });

    const matches = await store.listByCanonicalKey("entities:a_b");
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("underscore key entry");
  });

  it("finds an entry older than the previous 1000-row scan window", async () => {
    const store = createStore();

    // Target entry is stored FIRST so it is the oldest row in the table.
    const target = await store.store({
      text: "oldest durable preference",
      vector: [1, 0, 0],
      category: "preferences",
      scope: "project:test",
      importance: 0.9,
      metadata: durableMetadata("preferences:oldest-durable"),
    });

    // Bury it under more rows than the old CANONICAL_SCAN_LIMIT (1000)
    // recency window could ever surface.
    const FILLER_COUNT = 1005;
    const filler = Array.from({ length: FILLER_COUNT }, (_, i) => ({
      text: `filler durable entry ${i}`,
      vector: [0, 1, 0],
      category: "events" as const,
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata(`events:filler-${i}`),
    }));
    expect(await store.storeBatch(filler)).toBe(FILLER_COUNT);

    const matches = await store.listByCanonicalKey("preferences:oldest-durable");
    expect(matches.map(m => m.id)).toEqual([target.id]);
    expect(matches[0].text).toBe("oldest durable preference");
  });

  it("returns an empty array for an unknown key", async () => {
    const store = createStore();
    await store.store({
      text: "something",
      vector: [1, 0, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata("events:something"),
    });
    expect(await store.listByCanonicalKey("events:missing")).toEqual([]);
  });
});
