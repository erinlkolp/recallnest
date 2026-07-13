import { beforeEach, describe, expect, it } from "bun:test";

import { maybeRunGc, resetGcTimestamp, DEFAULT_AUTO_GC_CONFIG } from "../auto-gc.js";
import type { MemoryEntry, MemoryStore } from "../store.js";

const ACTIVE_META = JSON.stringify({
  evolution: {
    status: "active",
    version: 1,
    accessCount: 0,
    lastAccessedAt: null,
    supersededBy: null,
    consolidatedInto: null,
    contributedToPattern: null,
    sourceMemories: [],
    validFrom: null,
    validUntil: null,
  },
});

function makeEntry(opts: { id: string; scope: string; ageDays: number }): MemoryEntry {
  const now = Date.now();
  return {
    id: opts.id,
    text: `memory ${opts.id}`,
    vector: [],
    category: "events",
    scope: opts.scope,
    importance: 0.3,
    timestamp: now - opts.ageDays * 86_400_000,
    metadata: ACTIVE_META,
  };
}

/**
 * Faithful in-memory store: replicates the REAL MemoryStore.list contract —
 * scope filtering, timestamp ordering (desc default / asc opt-in), then slice.
 * This is what lets us observe the scan-window direction and scope-propagation
 * behavior that the mocks in auto-gc.test.ts / trusted-memory.test.ts ignore.
 */
function makeFaithfulStore(entries: MemoryEntry[]) {
  const data = [...entries];
  const listCalls: Array<{ scopeFilter?: string[]; order?: string }> = [];
  const store = {
    async stats() {
      return { totalCount: data.length, scopeCounts: {}, categoryCounts: {} };
    },
    async list(
      scopeFilter?: string[],
      _category?: string,
      limit = 20,
      offset = 0,
      order: "asc" | "desc" = "desc",
    ): Promise<MemoryEntry[]> {
      listCalls.push({ scopeFilter, order });
      let rows = scopeFilter
        ? data.filter((e) => scopeFilter.includes(e.scope ?? ""))
        : [...data];
      rows = rows.sort((a, b) =>
        order === "asc" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp,
      );
      return rows.slice(offset, offset + limit);
    },
    async update(id: string, updates: Partial<MemoryEntry>) {
      const entry = data.find((e) => e.id === id);
      if (entry && updates.metadata) entry.metadata = updates.metadata;
      return entry ?? null;
    },
  };
  return { store: store as unknown as MemoryStore, data, listCalls };
}

describe("maybeRunGc — bug #5: scope semantics", () => {
  beforeEach(() => resetGcTimestamp());

  it("only archives memories in the requested scope, never other scopes", async () => {
    // 5 old archivable entries in each of two scopes. minMemoryCount met globally.
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 5; i++) entries.push(makeEntry({ id: `a-${i}`, scope: "project:A", ageDays: 90 }));
    for (let i = 0; i < 5; i++) entries.push(makeEntry({ id: `b-${i}`, scope: "project:B", ageDays: 90 }));

    const { store, data, listCalls } = makeFaithfulStore(entries);
    const config = {
      ...DEFAULT_AUTO_GC_CONFIG,
      minMemoryCount: 1,
      minHoursSinceLastGc: 0,
      decayScoreThreshold: 2.0, // above max possible score → any past-age entry archives
      minAgeDays: 30,
    };

    const result = await maybeRunGc(store, config, undefined, undefined, "project:A");

    expect(result.triggered).toBe(true);
    // The scan must have been scoped to project:A.
    expect(listCalls[0]?.scopeFilter).toEqual(["project:A"]);
    // Every project:B entry must remain active; only project:A entries archived.
    const parseStatus = (m: string) => JSON.parse(m).evolution.status;
    const bStillActive = data.filter((e) => e.scope === "project:B").every((e) => parseStatus(e.metadata) === "active");
    const aArchived = data.filter((e) => e.scope === "project:A").filter((e) => parseStatus(e.metadata) !== "active");
    expect(bStillActive).toBe(true);
    expect(aArchived.length).toBe(5);
  });
});

describe("maybeRunGc — bug #4: scan window direction", () => {
  beforeEach(() => resetGcTimestamp());

  it("scans oldest-first so old archive candidates beyond the scan window are found", async () => {
    // 3 recent (not archivable) + 2 old (archivable). Scan window = 3.
    // Newest-first (buggy) sees only the 3 recent → 0 archived.
    // Oldest-first (fixed) sees the 2 old + 1 recent → 2 archived.
    const entries: MemoryEntry[] = [
      makeEntry({ id: "recent-1", scope: "project:X", ageDays: 1 }),
      makeEntry({ id: "recent-2", scope: "project:X", ageDays: 2 }),
      makeEntry({ id: "recent-3", scope: "project:X", ageDays: 3 }),
      makeEntry({ id: "old-1", scope: "project:X", ageDays: 40 }),
      makeEntry({ id: "old-2", scope: "project:X", ageDays: 50 }),
    ];

    const { store, listCalls } = makeFaithfulStore(entries);
    const config = {
      ...DEFAULT_AUTO_GC_CONFIG,
      minMemoryCount: 1,
      minHoursSinceLastGc: 0,
      decayScoreThreshold: 2.0,
      minAgeDays: 30,
      maxScanPerRun: 3, // force the window smaller than the dataset
    };

    const result = await maybeRunGc(store, config, undefined, undefined, "project:X");

    expect(result.triggered).toBe(true);
    expect(listCalls[0]?.order).toBe("asc");
    expect(result.totalChecked).toBe(3); // window honored
    expect(result.archivedCount).toBe(2); // both old ones found & archived
  });
});
