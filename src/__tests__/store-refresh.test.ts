import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function createSharedDbPath(): string {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-refresh-"));
  cleanupPaths.push(dbPath);
  return dbPath;
}

describe("MemoryStore.refresh", () => {
  it("is a no-op when the table has not been initialized", async () => {
    const dbPath = createSharedDbPath();
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    await store.refresh();
    expect(true).toBe(true);
  });

  it("picks up rows written by a separate connection on the same dbPath", async () => {
    const dbPath = createSharedDbPath();
    const writer = new MemoryStore({ dbPath, vectorDim: 3 });
    const reader = new MemoryStore({ dbPath, vectorDim: 3 });

    await writer.store({
      text: "first entry",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:refresh-test",
      importance: 0.5,
      metadata: "{}",
    });

    const before = await reader.stats();
    expect(before.totalCount).toBe(1);

    await writer.store({
      text: "second entry written after the reader opened its handle",
      vector: [0, 1, 0],
      category: "entities",
      scope: "project:refresh-test",
      importance: 0.5,
      metadata: "{}",
    });

    const stale = await reader.stats();
    expect(stale.totalCount).toBe(1);

    await reader.refresh();

    const fresh = await reader.stats();
    expect(fresh.totalCount).toBe(2);
  });
});
