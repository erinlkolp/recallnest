import { describe, expect, it } from "bun:test";

import type { PinAsset } from "../memory-assets.js";
import { selectPinnedContext } from "../context-composer-pins.js";

function buildPinnedAsset(overrides: Partial<PinAsset> = {}): PinAsset & { path: string } {
  return {
    id: overrides.id || "pin-1",
    type: "pinned-memory",
    createdAt: overrides.createdAt || "2026-03-20T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-03-20T00:00:00.000Z",
    title: overrides.title || "Pinned continuity note",
    summary: overrides.summary || "Pinned continuity reminder",
    tags: overrides.tags || [],
    source: overrides.source || {
      memoryId: "memory-1",
      scope: "memory:project:recallnest",
      timestamp: Date.parse("2026-03-20T00:00:00.000Z"),
      metadata: {},
    },
    retrieval: overrides.retrieval,
    snippet: overrides.snippet || "",
    path: "/tmp/pin-1.json",
  };
}

describe("context composer pins", () => {
  it("keeps later task-specific cues from long maintenance prompts", () => {
    const taskSeed =
      "继续 RecallNest continuity helper boundary audit ranking scoring selection orchestration context composer stable query fallback profile forwarding gap runner isolation";

    const pinnedContext = selectPinnedContext([
      buildPinnedAsset({
        title: "Eval runner isolation note",
        summary: "Fresh-window replay still needs explicit runner isolation to avoid shared component skew.",
        tags: ["recallnest", "runner", "isolation"],
        snippet: "Runner isolation is the key safeguard when continuity previews diverge across fresh-window replay.",
      }),
    ], {
      taskSeed,
      limit: 1,
    });

    expect(pinnedContext).toHaveLength(1);
    expect(pinnedContext[0]).toContain("Pinned: Eval runner isolation note: Fresh-window replay still needs explicit runner isolation to avoid shared component skew.");
  });

  it("does not leak a pin from a sibling project scope into another project scope", () => {
    // Regression: isRelevantToScopedPinnedContext fell back to substring cue
    // matching whenever two *different* project scopes were compared. The cue
    // term for "project:recallnest" is "recallnest", which is a substring of
    // "project:recallnest-smoke" and of any pin text mentioning the project —
    // so a throwaway smoke-test pin surfaced as top stable context for the
    // real project.
    const pinnedContext = selectPinnedContext([
      buildPinnedAsset({
        id: "pin-smoke",
        title: "Smoke pin: deploy pipeline",
        summary: "RecallNest deploys run bun test, then tsc --noEmit, then publish to origin only.",
        tags: ["smoke", "deploy"],
        source: {
          memoryId: "memory-smoke",
          scope: "project:recallnest-smoke",
          timestamp: Date.parse("2026-07-25T00:00:00.000Z"),
          metadata: {},
        },
      }),
    ], {
      // A task seed is what gives the foreign pin a positive score: without
      // one every pin scores 0 and is dropped by the score filter, so the
      // scope check never runs.
      taskSeed: "RecallNest deploy pipeline check",
      scope: "project:recallnest",
      limit: 3,
    });

    expect(pinnedContext).toEqual([]);
  });

  it("still surfaces a pin whose scope matches the requested project scope", () => {
    const pinnedContext = selectPinnedContext([
      buildPinnedAsset({
        id: "pin-real",
        title: "Deploy pipeline",
        summary: "RecallNest deploys run bun test, then tsc --noEmit, then publish to origin only.",
        tags: ["deploy"],
        source: {
          memoryId: "memory-real",
          scope: "project:recallnest",
          timestamp: Date.parse("2026-07-25T00:00:00.000Z"),
          metadata: {},
        },
      }),
    ], {
      scope: "project:recallnest",
      limit: 3,
    });

    expect(pinnedContext).toHaveLength(1);
    expect(pinnedContext[0]).toContain("Deploy pipeline");
  });

  it("ignores conversational continuation filler for vague memory-layer prompts", () => {
    const pinnedContext = selectPinnedContext([
      buildPinnedAsset({
        id: "pin-visual",
        title: "用户视觉审美偏好",
        summary: "用户常用视觉风格是手绘涂鸦风加高对比撞色；在内容包装和配图生成时，应优先沿用这一审美方向。",
        tags: ["审美偏好", "手绘涂鸦", "高对比撞色", "给刚才写的文章生成配图"],
        snippet: "给刚才写的文章生成配图，风格：手绘涂鸦风+高对比撞色。",
      }),
    ], {
      taskSeed: "把刚才那个 memory layer 接回去",
      limit: 1,
    });

    expect(pinnedContext).toEqual([]);
  });
});
