/**
 * Tests that the write paths upsert on `id` instead of blind-appending.
 *
 * Regression cover for duplicate-ID rows. capture-engine derives a row id from
 * (scope, canonicalKey) rather than from the text (capture-engine.ts:595), so a
 * corrected re-store arrives carrying an id that already exists. When store()
 * used table.add() that produced two rows sharing one id — a state nothing can
 * repair afterwards, because update() matches every copy and rewrites them all.
 *
 * Validates that:
 * 1. Re-storing an explicit id updates in place rather than duplicating
 * 2. A corrected text under the same id wins, and the stale text is gone
 * 3. Identical (scope, text) writes collapse via the deterministic id
 * 4. Duplicate ids inside one storeBatch payload fold to a single row
 * 5. storeBatch across calls upserts rather than appending
 * 6. importEntry is idempotent across reruns
 * 7. Distinct entries are still stored independently (no over-merging)
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, deterministicId, type MemoryEntry } from "../store.js";

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
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-dup-id-guard-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim: 3 });
}

/** Every row in the table — list() applies no limit to its underlying scan. */
async function allRows(store: MemoryStore): Promise<MemoryEntry[]> {
  return store.list(undefined, undefined, 1_000);
}

async function rowCount(store: MemoryStore): Promise<number> {
  return (await allRows(store)).length;
}

async function rowsWithId(store: MemoryStore, id: string): Promise<MemoryEntry[]> {
  return (await allRows(store)).filter(r => r.id === id);
}

describe("store() upserts on id", () => {
  it("does not duplicate when the same explicit id is stored twice", async () => {
    const store = createStore();
    const id = "6f18a13f-eff2-fbc5-4bd6-f7aad4c20081";

    await store.store({
      id,
      text: "dials comma encoding may break multi-dial API calls",
      vector: [1, 0, 0],
      category: "cases",
      scope: "project:test",
      importance: 0.9,
    });
    await store.store({
      id,
      text: "dials param must be semicolon-separated",
      vector: [0, 1, 0],
      category: "cases",
      scope: "project:test",
      importance: 0.92,
    });

    expect(await rowCount(store)).toBe(1);
  });

  it("keeps the corrected text and drops the superseded one", async () => {
    const store = createStore();
    const id = deterministicId("project:test", "dials-comma-encoding-bug");

    await store.store({
      id,
      text: "dials comma encoding may break multi-dial API calls",
      vector: [1, 0, 0],
      category: "cases",
      scope: "project:test",
      importance: 0.9,
    });
    await store.store({
      id,
      text: "dials param must be semicolon-separated",
      vector: [0, 1, 0],
      category: "cases",
      scope: "project:test",
      importance: 0.92,
    });

    const rows = await rowsWithId(store, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("dials param must be semicolon-separated");
    expect(rows[0]!.importance).toBeCloseTo(0.92, 5);
  });

  it("collapses identical scope+text writes via the deterministic id", async () => {
    const store = createStore();
    const entry = {
      text: "user prefers bun over npm",
      vector: [1, 0, 0],
      category: "preferences" as const,
      scope: "project:test",
      importance: 0.7,
    };

    const first = await store.store({ ...entry });
    const second = await store.store({ ...entry });

    expect(second.id).toBe(first.id);
    expect(await rowCount(store)).toBe(1);
  });

  it("still stores genuinely distinct entries separately", async () => {
    const store = createStore();

    await store.store({
      text: "first distinct memory",
      vector: [1, 0, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
    });
    await store.store({
      text: "second distinct memory",
      vector: [0, 1, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
    });

    expect(await rowCount(store)).toBe(2);
  });
});

describe("storeBatch() upserts on id", () => {
  it("folds duplicate ids inside a single payload, last write wins", async () => {
    const store = createStore();
    const shared = {
      vector: [1, 0, 0],
      category: "cases" as const,
      scope: "project:test",
      importance: 0.6,
    };

    // Same scope+text twice => same deterministic id in one payload.
    const stored = await store.storeBatch([
      { ...shared, text: "repeated line" },
      { ...shared, text: "repeated line" },
      { ...shared, text: "unique line" },
    ]);

    expect(stored).toBe(2);
    expect(await rowCount(store)).toBe(2);
  });

  it("updates rather than appends when a later batch repeats an id", async () => {
    const store = createStore();
    const shared = {
      vector: [1, 0, 0],
      category: "cases" as const,
      scope: "project:test",
      importance: 0.6,
    };

    await store.storeBatch([{ ...shared, text: "batch line a" }]);
    await store.storeBatch([{ ...shared, text: "batch line a" }]);

    expect(await rowCount(store)).toBe(1);
  });
});

describe("importEntry() upserts on id", () => {
  it("is idempotent when the same entry is imported twice", async () => {
    const store = createStore();
    const entry: MemoryEntry = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      text: "imported memory",
      vector: [1, 0, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      timestamp: 1_700_000_000_000,
      metadata: "{}",
      language: "en",
      fts_text: "imported memory",
    };

    await store.importEntry(entry);
    await store.importEntry({ ...entry, text: "imported memory, re-embedded" });

    const rows = await rowsWithId(store, entry.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("imported memory, re-embedded");
  });
});
