import { beforeEach, describe, expect, it } from "bun:test";

import { maybeRunGc, resetGcTimestamp, DEFAULT_AUTO_GC_CONFIG } from "../auto-gc.js";
import type { MemoryEntry, MemoryStore } from "../store.js";

function makeEntry(i: number): MemoryEntry {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    text: `memory ${i}`,
    vector: [],
    category: "events",
    scope: "project:test",
    importance: 0.4,
    timestamp: Date.now() - 60 * 86_400_000, // 60 days old
    metadata: JSON.stringify({
      evolution: {
        status: "active",
        version: 1,
        accessCount: 0,
        lastAccessedAt: null,
        supersededBy: null,
        consolidatedInto: null,
        contributedToPattern: null,
        sourceMemories: [],
        validFrom: Date.now() - 60 * 86_400_000,
        validUntil: null,
      },
    }),
  };
}

function createAccurateMockStore(entries: MemoryEntry[]): MemoryStore {
  return {
    // Matches the REAL store surface: stats has totalCount (no `total`),
    // list is positional with a default limit of 20.
    async stats() {
      return { totalCount: entries.length, scopeCounts: {}, categoryCounts: {} };
    },
    async list(_scopeFilter?: string[], _category?: string, limit = 20, offset = 0) {
      return entries.slice(offset, offset + limit);
    },
    async update(id: string, updates: Partial<MemoryEntry>) {
      const entry = entries.find(e => e.id === id);
      if (entry && updates.metadata) entry.metadata = updates.metadata;
      return entry ?? null;
    },
  } as unknown as MemoryStore;
}

describe("maybeRunGc store-signature compatibility", () => {
  beforeEach(() => {
    resetGcTimestamp();
  });

  it("triggers when the store holds at least minMemoryCount memories", async () => {
    const entries = Array.from({ length: 1200 }, (_, i) => makeEntry(i));
    const result = await maybeRunGc(createAccurateMockStore(entries), DEFAULT_AUTO_GC_CONFIG);

    expect(result.triggered).toBe(true);
    expect(result.totalChecked).toBe(1200);
  });
});
