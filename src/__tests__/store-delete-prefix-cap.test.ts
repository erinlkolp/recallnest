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
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-delete-prefix-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim: 3 });
}

describe("MemoryStore.delete prefix resolution past 1000 rows", () => {
  // The prefix branch must scan the full table (like get()/update()) rather than
  // an arbitrary first-1000-row window; otherwise ambiguity detection and row
  // selection are silently wrong once the table exceeds 1000 rows.
  it("sees every matching row for an ambiguous prefix beyond 1000 rows", async () => {
    const store = createStore();
    const SHARED = "deadbeef"; // 8 hex chars → treated as a prefix by delete()
    const total = 1001;

    for (let i = 0; i < total; i++) {
      await store.store({
        id: `${SHARED}-0000-0000-0000-${i.toString(16).padStart(12, "0")}`,
        text: `entry number ${i}`,
        vector: [1, 0, 0],
        category: "entities",
        scope: "proj:x",
        importance: 0.5,
        metadata: "{}",
      });
    }

    // All 1001 rows share the prefix, so delete() must report the true total in
    // its ambiguity guard. A 1000-row scan cap would report 1000 and, worse,
    // could delete the wrong row when only one match lands inside the window.
    await expect(store.delete(SHARED)).rejects.toThrow(/matches 1001 memories/);
  }, 120_000);
});
