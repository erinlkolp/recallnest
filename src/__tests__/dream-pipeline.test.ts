import { describe, expect, it, beforeEach } from "bun:test";
import { runDream, formatDreamResult, type DreamResult } from "../dream-pipeline.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { LLMClient } from "../llm-client.js";
import type { Embedder } from "../embedder.js";
import { resetWriteCount } from "../activity-counter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "test memory",
    vector: [1, 0, 0, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.5,
    timestamp: Date.now(),
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
        validFrom: Date.now(),
        validUntil: null,
      },
    }),
    ...overrides,
  };
}

function createMockStore(entries: MemoryEntry[]): MemoryStore {
  const stored: MemoryEntry[] = [...entries];
  let storeCounter = 0;

  return {
    async list() { return stored; },
    async stats() {
      return {
        totalCount: stored.length,
        scopeCounts: {},
        categoryCounts: {},
      };
    },
    async store(entry: Partial<MemoryEntry>) {
      const full = {
        id: entry.id || `dream-${storeCounter++}`,
        text: entry.text || "",
        vector: entry.vector || [],
        category: entry.category || "events",
        scope: entry.scope || "project:test",
        importance: entry.importance || 0.5,
        timestamp: Date.now(),
        metadata: entry.metadata || "{}",
      } as MemoryEntry;
      stored.push(full);
      return full;
    },
    async update(id: string, upd: Partial<MemoryEntry>) {
      const entry = stored.find(e => e.id === id);
      if (entry && upd.metadata) entry.metadata = upd.metadata;
      return entry || { id, text: "", vector: [], category: "events", scope: "project:test", importance: 0.5, timestamp: Date.now(), metadata: "{}" } as MemoryEntry;
    },
    async getById(id: string) {
      return stored.find(e => e.id === id) || null;
    },
    async vectorSearch(_vec: number[], limit: number, _threshold: number, _scopes?: string[]) {
      return stored.slice(0, limit).map(e => ({ entry: e, score: 0.85 }));
    },
  } as unknown as MemoryStore;
}

function createMockLLM(): LLMClient {
  return {
    async generateL0() { return "consolidated insight"; },
    async extractPattern() { return "discovered pattern"; },
  } as unknown as LLMClient;
}

function createMockEmbedder(): Pick<Embedder, "embedPassage"> {
  return {
    async embedPassage() { return [0.5, 0.5, 0, 0, 0]; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDream", () => {
  beforeEach(() => {
    // Reset activity counter between tests
    resetWriteCount();
  });

  it("skips when write count is below threshold", async () => {
    const store = createMockStore([makeEntry({ id: "a" })]);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      config: { minWritesForDream: 10 },
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("insufficient_writes");
    expect(result.phases.length).toBe(1);
    expect(result.phases[0].phase).toBe("orient");
  });

  it("runs when forced despite low write count", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    expect(result.phases.length).toBe(5);
    expect(result.phases.map(p => p.phase)).toEqual(["orient", "gather", "consolidate", "rebalance", "prune"]);
  });

  it("completes early with too few active entries", async () => {
    const store = createMockStore([
      makeEntry({ id: "a" }),
    ]);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
      config: { minClusterSize: 3 },
    });

    expect(result.ran).toBe(true);
    expect(result.reason).toBe("completed_early");
  });

  it("works without LLM (null) — only deterministic consolidation", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: null,
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    expect(result.stats.insightsGenerated).toBe(0); // No LLM = no insights
    expect(result.stats.patternsExtracted).toBe(0);
  });

  it("reports correct stats structure", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.stats.totalMemories).toBeGreaterThanOrEqual(0);
    expect(result.stats.activeMemories).toBeGreaterThanOrEqual(0);
    expect(typeof result.stats.clustersFound).toBe("number");
    expect(typeof result.stats.insightsGenerated).toBe("number");
    expect(typeof result.stats.patternsExtracted).toBe("number");
    expect(typeof result.stats.mergedCount).toBe("number");
    expect(typeof result.stats.archivedCount).toBe("number");
  });
});

describe("runDream rebalance phase", () => {
  beforeEach(() => {
    resetWriteCount();
  });

  it("rebalances tiers and importance for active entries", async () => {
    // Entry with accesses but no tier: gets a tier backfill + banded importance.
    const accessed = makeEntry({ id: "accessed" });
    accessed.importance = 0.2;
    accessed.metadata = JSON.stringify({
      accessCount: 4,
      evolution: {
        status: "active", version: 1, accessCount: 4, lastAccessedAt: Date.now(),
        supersededBy: null, consolidatedInto: null, contributedToPattern: null,
        sourceMemories: [], validFrom: Date.now(), validUntil: null,
      },
    });

    const entries = [accessed, makeEntry({ id: "b" }), makeEntry({ id: "c" }), makeEntry({ id: "d" })];
    const updates: Array<{ id: string; importance?: number; metadata?: string }> = [];
    const store = createMockStore(entries);
    const originalUpdate = store.update.bind(store);
    (store as any).update = async (id: string, upd: any) => {
      updates.push({ id, importance: upd.importance, metadata: upd.metadata });
      return originalUpdate(id, upd);
    };

    const result = await runDream({
      store,
      llm: null,
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    expect(result.phases.some(p => p.phase === "rebalance")).toBe(true);
    expect(result.stats.rebalancedCount).toBeGreaterThan(0);

    // The deterministic consolidation phase may write metadata-only updates to
    // "accessed" first (it wins canonical selection); the rebalance update is the
    // one that carries importance.
    const accessedUpdate = updates.find(u => u.id === "accessed" && u.importance !== undefined);
    expect(accessedUpdate).toBeDefined();
    // accessCount 4, no stored tier → "working" band [0.6, 0.8]
    expect(accessedUpdate!.importance).toBeGreaterThanOrEqual(0.6);
    expect(accessedUpdate!.importance).toBeLessThanOrEqual(0.8);
    expect(JSON.parse(accessedUpdate!.metadata!).tier).toBe("working");
  });

  it("skips entries that became non-active between gather and rebalance", async () => {
    const accessedMetadata = () => JSON.stringify({
      accessCount: 4,
      evolution: {
        status: "active", version: 1, accessCount: 4, lastAccessedAt: Date.now(),
        supersededBy: null, consolidatedInto: null, contributedToPattern: null,
        sourceMemories: [], validFrom: Date.now(), validUntil: null,
      },
    });
    const stale = makeEntry({ id: "stale", importance: 0.2, metadata: accessedMetadata() });
    const fresh = makeEntry({ id: "fresh", importance: 0.2, metadata: accessedMetadata() });

    const entries = [stale, fresh, makeEntry({ id: "b" }), makeEntry({ id: "c" })];
    const updates: Array<{ id: string; importance?: number; metadata?: string }> = [];
    const store = createMockStore(entries);
    const originalUpdate = store.update.bind(store);
    (store as any).update = async (id: string, upd: any) => {
      updates.push({ id, importance: upd.importance, metadata: upd.metadata });
      return originalUpdate(id, upd);
    };
    // Simulate consolidation having archived "stale" after the gather snapshot:
    // list still returned it as active, but a fresh getById sees it consolidated.
    const originalGetById = store.getById.bind(store);
    (store as any).getById = async (id: string) => {
      const entry = await originalGetById(id);
      if (!entry || id !== "stale") return entry;
      const md = JSON.parse(entry.metadata || "{}");
      md.evolution = { ...md.evolution, status: "consolidated" };
      return { ...entry, metadata: JSON.stringify(md) };
    };

    const result = await runDream({
      store,
      llm: null,
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    // "stale" must not receive a rebalance write (no update carrying importance).
    expect(updates.some(u => u.id === "stale" && u.importance !== undefined)).toBe(false);
    // The guard must not over-skip: "fresh" still gets its tier/importance.
    const freshUpdate = updates.find(u => u.id === "fresh" && u.importance !== undefined);
    expect(freshUpdate).toBeDefined();
    expect(freshUpdate!.importance).toBeGreaterThanOrEqual(0.6);
    expect(freshUpdate!.importance).toBeLessThanOrEqual(0.8);
    expect(JSON.parse(freshUpdate!.metadata!).tier).toBe("working");
    // All 4 plans changed, but "stale" was skipped at apply time.
    expect(result.stats.rebalancedCount).toBe(3);
  });
});

describe("formatDreamResult", () => {
  it("formats skipped dream", () => {
    const result: DreamResult = {
      ran: false,
      reason: "insufficient_writes (3/10)",
      phases: [{ phase: "orient", detail: "50 memories, 3 writes" }],
      stats: { totalMemories: 50, activeMemories: 0, writesSinceLastDream: 3, clustersFound: 0, insightsGenerated: 0, patternsExtracted: 0, mergedCount: 0, rebalancedCount: 0, archivedCount: 0 },
    };
    const output = formatDreamResult(result);
    expect(output).toContain("skipped");
    expect(output).toContain("insufficient_writes");
  });

  it("formats completed dream with all phases", () => {
    const result: DreamResult = {
      ran: true,
      phases: [
        { phase: "orient", detail: "100 memories, 15 writes" },
        { phase: "gather", detail: "80 active entries" },
        { phase: "consolidate", detail: "3 clusters, 1 merged, 2 insights, 1 pattern" },
        { phase: "rebalance", detail: "4 rebalanced (2 tier backfills, 1 dead-memory demotions)" },
        { phase: "prune", detail: "5 entries archived" },
      ],
      stats: { totalMemories: 100, activeMemories: 80, writesSinceLastDream: 15, clustersFound: 3, insightsGenerated: 2, patternsExtracted: 1, mergedCount: 1, rebalancedCount: 4, archivedCount: 5 },
    };
    const output = formatDreamResult(result);
    expect(output).toContain("Dream completed");
    expect(output).toContain("[orient]");
    expect(output).toContain("[consolidate]");
    expect(output).toContain("[prune]");
    expect(output).toContain("Patterns: 1");
  });
});
