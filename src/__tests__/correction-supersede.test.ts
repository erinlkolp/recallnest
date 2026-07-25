/**
 * Tests for correction supersession linking.
 *
 * auto_capture extracts a corrected fact and the correction that invalidates it
 * as two separate memories. Without a supersession link both stay active and
 * retrieval can surface the stale one.
 */
import { describe, expect, it } from "bun:test";

import { linkCorrectionSupersessions } from "../correction-supersede.js";
import { parseEvolution } from "../memory-evolution.js";
import type { MemoryEntry } from "../store.js";

const SCOPE = "project:test";

function createStore(entries: Array<Partial<MemoryEntry> & { id: string; text: string }>) {
  const data = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    data.set(entry.id, {
      vector: [1, 0, 0],
      category: "events",
      scope: SCOPE,
      importance: 0.85,
      timestamp: Date.now(),
      metadata: "{}",
      ...entry,
    } as MemoryEntry);
  }

  return {
    data,
    async list(scopeFilter?: string[]) {
      return [...data.values()].filter(
        (entry) => !scopeFilter || scopeFilter.includes(entry.scope),
      );
    },
    async update(id: string, updates: Partial<MemoryEntry>) {
      const existing = data.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...updates };
      data.set(id, merged);
      return merged;
    },
  };
}

describe("linkCorrectionSupersessions", () => {
  it("supersedes the fact a correction invalidates", async () => {
    const store = createStore([
      { id: "old-1", text: "Remember that the deploy window is Tuesdays" },
      { id: "fix-1", text: "Correction - Thursdays, not Tuesdays for the deploy window" },
    ]);

    const links = await linkCorrectionSupersessions(
      { store: store as never },
      { scope: SCOPE, corrections: [{ id: "fix-1", text: store.data.get("fix-1")!.text }] },
    );

    expect(links).toEqual([{ correctionId: "fix-1", supersededId: "old-1" }]);

    const oldEvo = parseEvolution(store.data.get("old-1")!.metadata, 0);
    expect(oldEvo.status).toBe("superseded");
    expect(oldEvo.supersededBy).toBe("fix-1");

    const newEvo = parseEvolution(store.data.get("fix-1")!.metadata, 0);
    expect(newEvo.supersedes).toBe("old-1");
  });

  it("leaves unrelated memories untouched", async () => {
    const store = createStore([
      { id: "other-1", text: "The staging cluster lives in eu-west-1" },
      { id: "fix-1", text: "Correction - Thursdays, not Tuesdays for the deploy window" },
    ]);

    const links = await linkCorrectionSupersessions(
      { store: store as never },
      { scope: SCOPE, corrections: [{ id: "fix-1", text: store.data.get("fix-1")!.text }] },
    );

    expect(links).toEqual([]);
    expect(parseEvolution(store.data.get("other-1")!.metadata, 0).status).toBe("active");
  });

  it("never supersedes the correction itself", async () => {
    const store = createStore([
      { id: "fix-1", text: "Correction - Thursdays, not Tuesdays for the deploy window" },
    ]);

    const links = await linkCorrectionSupersessions(
      { store: store as never },
      { scope: SCOPE, corrections: [{ id: "fix-1", text: store.data.get("fix-1")!.text }] },
    );

    expect(links).toEqual([]);
    expect(parseEvolution(store.data.get("fix-1")!.metadata, 0).status).toBe("active");
  });

  it("skips memories that are already superseded", async () => {
    const store = createStore([
      {
        id: "old-1",
        text: "Remember that the deploy window is Tuesdays",
        metadata: JSON.stringify({ evolution: { status: "superseded", supersededBy: "earlier-fix" } }),
      },
      { id: "fix-1", text: "Correction - Thursdays, not Tuesdays for the deploy window" },
    ]);

    const links = await linkCorrectionSupersessions(
      { store: store as never },
      { scope: SCOPE, corrections: [{ id: "fix-1", text: store.data.get("fix-1")!.text }] },
    );

    expect(links).toEqual([]);
    expect(parseEvolution(store.data.get("old-1")!.metadata, 0).supersededBy).toBe("earlier-fix");
  });
});
