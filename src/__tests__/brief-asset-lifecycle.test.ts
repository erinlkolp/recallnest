import { describe, expect, it } from "bun:test";

import { forgetMemory } from "../forget-engine.js";
import { assetSummaryLine, buildBriefAsset, type BriefAsset } from "../memory-assets.js";
import type { DistilledSummary } from "../memory-output.js";

/**
 * Regression: a brief was write-only once created.
 *
 * 1. list_assets printed the brief's *sources* ("agent, manual") in the column
 *    headed "Scope", even though BriefAsset carries a real `scope`.
 * 2. forget_memory only ever looked in the memories table, so passing a brief's
 *    own asset id returned "not found" — and because a brief is indexed under
 *    `asset:brief:<id>` rather than its originating scope, a scoped
 *    search_memory could not surface it either. The only way to remove one was
 *    to forget a source memory it happened to cite.
 */

function makeSummary(scope = "project:recallnest"): DistilledSummary {
  return {
    query: "scope isolation",
    profile: "writing",
    hits: 1,
    sources: [{ source: "agent", hits: 1, newest: "2026-07-26", files: [] }],
    takeaways: ["agent: Scoped recall must not union unscoped rows."],
    evidence: [{
      memoryId: "memory-source",
      source: "agent",
      scope,
      date: "2026-07-26",
      retrievalPath: "vector",
      snippet: "Scoped recall must not union unscoped rows.",
    }],
    reusableCandidates: ["Scoped recall must not union unscoped rows."],
  };
}

function makeBrief(id = "brief-abc12345"): BriefAsset & { path: string } {
  const asset = buildBriefAsset(makeSummary(), {
    title: "Scope isolation brief",
    scope: "project:recallnest",
  });
  return { ...asset, id, path: `/tmp/assets/${id}.json` };
}

function createEmptyStore() {
  const bulkDeletedScopes: string[][] = [];
  return {
    bulkDeletedScopes,
    async get() {
      return null;
    },
    async update() {
      return null;
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

describe("brief assets report their own scope", () => {
  it("prints the originating scope, not the source list", () => {
    const line = assetSummaryLine(makeBrief());

    expect(line).toContain("project:recallnest");
    expect(line).not.toContain("agent");
  });

  it("falls back to a placeholder when the brief has no scope", () => {
    const asset = buildBriefAsset(makeSummary(), { title: "Unscoped brief" });
    const line = assetSummaryLine({ ...asset, scope: undefined });

    expect(line).toContain("brief");
  });
});

describe("forget resolves brief assets by their own id", () => {
  it("removes the brief file when the id is not a memory", async () => {
    const removedPaths: string[] = [];
    const brief = makeBrief();

    const result = await forgetMemory({
      store: createEmptyStore() as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: {
        list: () => [brief],
        remove: (path: string) => { removedPaths.push(path); },
      },
    }, { memoryId: brief.id, confirm: true, reason: "cleanup" });

    expect(result.success).toBe(true);
    expect(result.assetType).toBe("brief");
    expect(removedPaths).toEqual([brief.path]);
    expect(result.briefsRemoved).toBe(1);
  });

  it("deletes the indexed asset entry for the brief", async () => {
    const store = createEmptyStore();
    const brief = makeBrief("brief-abc12345");

    await forgetMemory({
      store: store as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: { list: () => [brief], remove: () => {} },
    }, { memoryId: brief.id, confirm: true });

    expect(store.bulkDeletedScopes).toEqual([["asset:brief:brief-ab"]]);
  });

  it("accepts an 8-character id prefix", async () => {
    const removedPaths: string[] = [];
    const brief = makeBrief("brief-abc12345");

    const result = await forgetMemory({
      store: createEmptyStore() as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: {
        list: () => [brief],
        remove: (path: string) => { removedPaths.push(path); },
      },
    }, { memoryId: "brief-ab", confirm: true });

    expect(result.success).toBe(true);
    expect(removedPaths).toEqual([brief.path]);
  });

  it("still reports not found when nothing matches", async () => {
    const result = await forgetMemory({
      store: createEmptyStore() as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: { list: () => [], remove: () => {} },
    }, { memoryId: "does-not-exist", confirm: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("requires confirm before deleting a brief", async () => {
    const removedPaths: string[] = [];
    const brief = makeBrief();

    const result = await forgetMemory({
      store: createEmptyStore() as never,
      pinAssets: { list: () => [], remove: () => {} },
      briefAssets: {
        list: () => [brief],
        remove: (path: string) => { removedPaths.push(path); },
      },
    }, { memoryId: brief.id, confirm: false });

    expect(result.success).toBe(false);
    expect(removedPaths).toEqual([]);
  });
});
