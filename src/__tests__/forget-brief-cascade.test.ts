import { describe, expect, it } from "bun:test";

import { indexAsset } from "../asset-sync.js";
import { forgetMemory } from "../forget-engine.js";
import { buildBriefAsset, type BriefAsset } from "../memory-assets.js";
import type { DistilledSummary } from "../memory-output.js";
import type { MemoryEntry } from "../store.js";

/**
 * Regression: forgetting a memory left every brief derived from it behind.
 *
 * forget-engine cascaded to pinned assets but not to memory briefs, and
 * indexAsset() filed briefs under `asset:brief:<id>` without recording the
 * scope they were built from. A brief embeds its sources' text verbatim in
 * summary/takeaways/evidence, so forgetting every source memory in a scope
 * still left that text searchable through the brief — the exact leak the pin
 * cascade already guards against.
 */

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "memory-briefed",
    text: "Deploys publish to origin only, never upstream.",
    vector: [1, 0, 0],
    category: "cases",
    scope: "project:recallnest",
    importance: 0.8,
    timestamp: Date.parse("2026-07-25T00:00:00.000Z"),
    metadata: "{}",
    ...overrides,
  };
}

function makeSummary(memoryIds: string[], scope = "project:recallnest"): DistilledSummary {
  return {
    query: "deploy pipeline",
    profile: "writing",
    hits: memoryIds.length,
    sources: [{ source: "agent", hits: memoryIds.length, newest: "2026-07-25", files: [] }],
    takeaways: ["agent: Deploys publish to origin only, never upstream."],
    evidence: memoryIds.map((memoryId) => ({
      memoryId,
      source: "agent",
      scope,
      date: "2026-07-25",
      retrievalPath: "vector",
      snippet: "Deploys publish to origin only, never upstream.",
    })),
    reusableCandidates: ["Deploys publish to origin only, never upstream."],
  };
}

function makeBrief(memoryIds: string[], id = "brief-abc12345"): BriefAsset & { path: string } {
  const asset = buildBriefAsset(makeSummary(memoryIds), {
    title: "Deploy pipeline brief",
    scope: "project:recallnest",
  });
  return { ...asset, id, path: `/tmp/assets/${id}.json` };
}

function createStore(entry: MemoryEntry) {
  const bulkDeletedScopes: string[][] = [];
  return {
    bulkDeletedScopes,
    async get() {
      return entry;
    },
    async update() {
      return entry;
    },
    async delete() {
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

describe("brief assets record the scope they were built from", () => {
  it("persists the originating scope on the brief asset", () => {
    const asset = buildBriefAsset(makeSummary(["memory-briefed"]), {
      title: "Deploy pipeline brief",
      scope: "project:recallnest",
    });

    expect(asset.scope).toBe("project:recallnest");
  });

  it("indexes the brief with originalScope metadata like a pin", async () => {
    const stored: Array<{ scope: string; metadata: string }> = [];
    const store = {
      async store(record: { scope: string; metadata: string }) {
        stored.push(record);
      },
    };
    const embedder = { async embedPassage() { return [1, 0, 0]; } };
    const asset = buildBriefAsset(makeSummary(["memory-briefed"]), {
      title: "Deploy pipeline brief",
      scope: "project:recallnest",
    });

    await indexAsset(store as never, embedder as never, asset);

    expect(stored).toHaveLength(1);
    const metadata = JSON.parse(stored[0]!.metadata) as { originalScope?: string };
    expect(metadata.originalScope).toBe("project:recallnest");
  });
});

describe("forget cascades to brief assets", () => {
  it("removes the brief asset file for the forgotten memory", async () => {
    const entry = makeEntry();
    const removedPaths: string[] = [];
    const brief = makeBrief([entry.id]);

    const result = await forgetMemory({
      store: createStore(entry) as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: {
        list: () => [brief],
        remove: (path: string) => { removedPaths.push(path); },
      },
    }, { memoryId: entry.id, confirm: true, reason: "test" });

    expect(result.success).toBe(true);
    expect(removedPaths).toEqual([brief.path]);
    expect(result.briefsRemoved).toBe(1);
  });

  it("deletes the indexed asset entry for the removed brief", async () => {
    const entry = makeEntry();
    const store = createStore(entry);
    const brief = makeBrief([entry.id], "brief-abc12345");

    await forgetMemory({
      store: store as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: { list: () => [brief], remove: () => {} },
    }, { memoryId: entry.id, confirm: true });

    // indexAsset() files briefs under scope `asset:brief:<first 8 of brief id>`
    expect(store.bulkDeletedScopes).toEqual([["asset:brief:brief-ab"]]);
  });

  it("leaves briefs that do not cite the forgotten memory untouched", async () => {
    const entry = makeEntry();
    const removedPaths: string[] = [];

    const result = await forgetMemory({
      store: createStore(entry) as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: {
        list: () => [makeBrief(["some-other-memory"])],
        remove: (path: string) => { removedPaths.push(path); },
      },
    }, { memoryId: entry.id, confirm: true });

    expect(removedPaths).toEqual([]);
    expect(result.briefsRemoved).toBe(0);
  });

  it("removes a multi-source brief when any one of its sources is forgotten", async () => {
    const entry = makeEntry();
    const removedPaths: string[] = [];
    const brief = makeBrief(["another-memory", entry.id, "third-memory"]);

    const result = await forgetMemory({
      store: createStore(entry) as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: {
        list: () => [brief],
        remove: (path: string) => { removedPaths.push(path); },
      },
    }, { memoryId: entry.id, confirm: true });

    expect(removedPaths).toEqual([brief.path]);
    expect(result.briefsRemoved).toBe(1);
  });
});
