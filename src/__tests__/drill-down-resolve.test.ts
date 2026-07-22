import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";
import { drillDownMemory } from "../drill-down.js";

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
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-drilldown-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim: 3 });
}

describe("drillDownMemory", () => {
  it("resolves a memory by the 8-char id prefix that search/explain display", async () => {
    const store = createStore();
    const entry = await store.store({
      text: "drill down target content",
      vector: [1, 0, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      metadata: "{}",
    });

    // search_memory / explain_memory only ever surface the first 8 hex chars.
    const displayedId = entry.id.slice(0, 8);
    expect(entry.id.length).toBeGreaterThan(8);

    const out = await drillDownMemory(store, displayedId, "full");

    expect(out).toContain("drill down target content");
    expect(out).toContain(entry.id);
  });

  it("returns a not-found message for an unknown (but well-formed) id", async () => {
    const store = createStore();
    const out = await drillDownMemory(store, "deadbeef", "full");
    expect(out).toContain("No memory found");
  });

  it("returns the L1 overview when level is 'overview'", async () => {
    const store = createStore();
    const entry = await store.store({
      text: "full level two body",
      vector: [1, 0, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      metadata: JSON.stringify({ l1_overview: "the concise overview text" }),
    });

    const out = await drillDownMemory(store, entry.id, "overview");
    expect(out).toContain("the concise overview text");
    expect(out).toContain("L1 Overview");
  });
});
