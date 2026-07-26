import { describe, expect, it } from "bun:test";

import { composeResumeContext } from "../context-composer.js";
import type { RetrievalContext, RetrievalResult } from "../retriever.js";

/**
 * Regression: resume_context rendered memories belonging to other scopes.
 *
 * retrieveCandidates fires a scoped retrieval and an unscoped "global" one in
 * parallel and merges both. buildStableContextSections re-filters that merged
 * list by scope, but the CC-7 collapsed view consumed the raw union, so foreign
 * scopes leaked into the rendered "Collapsed context" block even though the
 * caller asked for a single scope.
 *
 * Found by an MCP smoke test: resume_context scoped to project:smoke-2026-07-26
 * surfaced entries owned by project:erinlkolp.github.io, project:telegram-bridge
 * and project:VU-Server.
 */

const FOREIGN_TEXT = "claude-memory-pro is the maintenance target for a different repository.";
const SCOPED_TEXT = "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.";

function buildResult(
  id: string,
  category: "profile" | "preferences" | "entities" | "patterns" | "cases",
  text: string,
  scope: string,
): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category,
      scope,
      importance: 0.8,
      timestamp: Date.parse("2026-07-26T00:00:00.000Z"),
      metadata: "{}",
    },
    score: 0.9,
    sources: { fused: { score: 0.9 } },
  };
}

/**
 * Mirrors the real retriever contract: a scoped call returns only in-scope rows,
 * an unscoped call returns everything. The composer's own merge is what leaks.
 */
function buildLeakyRetriever(scope: string) {
  return {
    async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
      if (context.category !== "entities") return [];

      const scoped = buildResult("entity-in-scope", "entities", SCOPED_TEXT, scope);
      if (context.scopeFilter?.includes(scope)) return [scoped];

      return [scoped, buildResult("entity-foreign", "entities", FOREIGN_TEXT, "project:other")];
    },
  };
}

async function composeForScope(scope: string) {
  return composeResumeContext({
    retriever: buildLeakyRetriever(scope),
    checkpointStore: { async getLatest() { return null; } },
    listPins: () => [],
  }, {
    task: "continue the project",
    scope,
    includeLatestCheckpoint: false,
    limitPerSection: 3,
  });
}

describe("resume_context scope isolation", () => {
  it("keeps foreign-scope memories out of the collapsed view", async () => {
    const response = await composeForScope("project:recallnest");

    const collapsedText = (response.collapsedItems ?? []).map((item) => item.text).join(" ");
    expect(collapsedText).not.toContain("claude-memory-pro");
  });

  it("still collapses the in-scope memory", async () => {
    const response = await composeForScope("project:recallnest");

    const collapsedIds = (response.collapsedItems ?? []).map((item) => item.entryId);
    expect(collapsedIds).toContain("entity-in-scope");
  });

  it("keeps foreign-scope memories out of stable context", async () => {
    const response = await composeForScope("project:recallnest");

    expect(response.stableContext.join(" ")).not.toContain("claude-memory-pro");
  });

  it("still recalls globally when the caller specifies no scope", async () => {
    const response = await composeResumeContext({
      retriever: buildLeakyRetriever("project:recallnest"),
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    }, {
      task: "continue the project",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    // With no scope requested there is nothing to isolate, so the unscoped
    // union must still reach the collapsed view.
    const collapsedIds = (response.collapsedItems ?? []).map((item) => item.entryId);
    expect(collapsedIds).toContain("entity-foreign");
  });
});
