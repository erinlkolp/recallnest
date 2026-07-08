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
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-update-atomicity-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({
    dbPath,
    vectorDim: 3,
  });
}

describe("MemoryStore.update atomicity", () => {
  it("keeps the original row when the raw write fails mid-update", async () => {
    const store = createStore();
    const entry = await store.store({
      text: "original text that must survive a failed update",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:atomicity",
      importance: 0.5,
      metadata: "{}",
    });

    // Fault injection: a delete-then-add implementation loses the row when
    // the raw add() fails after the delete; an atomic upsert must not.
    const table = (store as unknown as { table: { add: (rows: unknown[]) => Promise<void> } }).table;
    const originalAdd = table.add.bind(table);
    table.add = async () => {
      throw new Error("injected write failure");
    };
    try {
      await store.update(entry.id, { text: "attempted new text" }).catch(() => undefined);
    } finally {
      table.add = originalAdd;
    }

    const survivor = await store.get(entry.id);
    expect(survivor).not.toBeNull();
  });

  it("leaves exactly one row for the id after a successful update", async () => {
    const store = createStore();
    const entry = await store.store({
      text: "before update",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:atomicity",
      importance: 0.5,
      metadata: "{}",
    });

    const updated = await store.update(entry.id, { text: "after update" });
    expect(updated?.text).toBe("after update");

    const rows = await store.list(["project:atomicity"], undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("after update");
  });
});
