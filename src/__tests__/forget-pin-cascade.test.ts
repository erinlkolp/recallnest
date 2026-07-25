import { describe, expect, it } from "bun:test";

import { forgetMemory } from "../forget-engine.js";
import type { PinAsset } from "../memory-assets.js";
import type { MemoryEntry } from "../store.js";

/**
 * Regression: forgetting a memory left its pinned asset behind.
 *
 * forget-engine's own header documents step "5. Pin archive (mark related
 * pins as forgotten)", but the implementation jumped straight from KG
 * cleanup to cascade demote. The pin JSON file and its indexed `asset:*`
 * entry both survived, so a forgotten memory kept surfacing through
 * resume_context's pinned-context path.
 */

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "memory-pinned",
    text: "Duplicate id rows appear after a corrected re-store.",
    vector: [1, 0, 0],
    category: "cases",
    scope: "project:recallnest",
    importance: 0.84,
    timestamp: Date.parse("2026-07-25T00:00:00.000Z"),
    metadata: "{}",
    ...overrides,
  };
}

function makePin(memoryId: string, id = "pin-abc12345"): PinAsset & { path: string } {
  return {
    id,
    type: "pinned-memory",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    title: "Duplicate id case",
    summary: "Duplicate id rows appear after a corrected re-store.",
    tags: ["duplicate"],
    source: {
      memoryId,
      scope: "project:recallnest",
      timestamp: Date.parse("2026-07-25T00:00:00.000Z"),
      metadata: {},
    },
    snippet: "",
    path: `/tmp/pins/${id}.json`,
  };
}

function createStore(entry: MemoryEntry) {
  const bulkDeletedScopes: string[][] = [];
  const deleted: string[] = [];
  return {
    bulkDeletedScopes,
    deleted,
    async get() {
      return entry;
    },
    async update() {
      return entry;
    },
    async delete(id: string) {
      deleted.push(id);
      return true;
    },
    async vectorSearch() {
      return [];
    },
    async bulkDelete(scopeFilter: string[]) {
      bulkDeletedScopes.push(scopeFilter);
      return 1;
    },
  };
}

describe("forget cascades to pinned assets", () => {
  it("removes the pin asset file for the forgotten memory", async () => {
    const entry = makeEntry();
    const removedPaths: string[] = [];
    const pin = makePin(entry.id);

    const result = await forgetMemory({
      store: createStore(entry) as never,
      pinAssets: {
        list: () => [pin],
        remove: (path: string) => { removedPaths.push(path); },
      },
    }, { memoryId: entry.id, confirm: true, reason: "test" });

    expect(result.success).toBe(true);
    expect(removedPaths).toEqual([pin.path]);
    expect(result.pinsRemoved).toBe(1);
  });

  it("deletes the indexed asset entry for the removed pin", async () => {
    const entry = makeEntry();
    const store = createStore(entry);
    const pin = makePin(entry.id, "pin-abc12345");

    await forgetMemory({
      store: store as never,
      pinAssets: {
        list: () => [pin],
        remove: () => {},
      },
    }, { memoryId: entry.id, confirm: true });

    // indexAsset() files pinned assets under scope `asset:<first 8 of pin id>`
    expect(store.bulkDeletedScopes).toEqual([["asset:pin-abc1"]]);
  });

  it("leaves pins belonging to other memories untouched", async () => {
    const entry = makeEntry();
    const removedPaths: string[] = [];

    const result = await forgetMemory({
      store: createStore(entry) as never,
      pinAssets: {
        list: () => [makePin("some-other-memory")],
        remove: (path: string) => { removedPaths.push(path); },
      },
    }, { memoryId: entry.id, confirm: true });

    expect(removedPaths).toEqual([]);
    expect(result.pinsRemoved).toBe(0);
  });
});
