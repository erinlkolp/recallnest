import { describe, expect, it } from "bun:test";

import { collapseResults, type CollapseInput } from "../context-collapse-renderer.js";
import { MAX_COLLAPSED_ITEMS, ResumeContextResponseSchema } from "../session-schema.js";

/**
 * Regression: resume_context threw `too_big` on `collapsedItems` whenever the
 * recalled set exceeded the response schema's cap. The composer fed the deduped
 * union of five result sections (up to 5 * limitPerSection) into collapseResults
 * with no truncation, so limitPerSection >= 5 could produce more than
 * MAX_COLLAPSED_ITEMS entries and fail the tool's own output schema.
 */
function buildCollapseInputs(count: number): CollapseInput[] {
  return Array.from({ length: count }, (_, index) => ({
    entryId: `entry-${index}`,
    // Descending scores, all above the l0 threshold (0.50) so nothing is skipped.
    score: 0.99 - index * 0.01,
    text: `Durable continuity note number ${index} about the RecallNest resume path.`,
    timestamp: Date.parse("2026-07-25T00:00:00.000Z"),
  }));
}

function buildResumeResponse(collapsedItems: ReturnType<typeof collapseResults>) {
  return {
    generatedAt: "2026-07-25T00:00:00.000Z",
    summary: "Resume context summary",
    stableContext: ["Entity: RecallNest is the shared memory layer."],
    relevantPatterns: ["Workflow pattern: recall before repo exploration"],
    recentCases: ["Case: scope fallback cleanup"],
    collapsedItems,
  };
}

describe("resume_context collapsed item cap", () => {
  it("collapseResults can emit more than the response schema allows", () => {
    const collapsed = collapseResults(buildCollapseInputs(30));

    // Proves the failure is reachable: the renderer itself applies no such cap.
    expect(collapsed.length).toBeGreaterThan(MAX_COLLAPSED_ITEMS);
  });

  it("rejects an uncapped collapsed set (the original bug)", () => {
    const collapsed = collapseResults(buildCollapseInputs(30));
    const parsed = ResumeContextResponseSchema.safeParse(buildResumeResponse(collapsed));

    expect(parsed.success).toBe(false);
    // Assert the exact failure, so this cannot pass for an unrelated reason.
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ code: "too_big", path: ["collapsedItems"] }),
    ]);
  });

  it("accepts the collapsed set once truncated to the cap", () => {
    const collapsed = collapseResults(buildCollapseInputs(30)).slice(0, MAX_COLLAPSED_ITEMS);
    const parsed = ResumeContextResponseSchema.safeParse(buildResumeResponse(collapsed));

    expect(parsed.success).toBe(true);
    expect(collapsed).toHaveLength(MAX_COLLAPSED_ITEMS);
  });

  it("truncation keeps the highest-scoring items", () => {
    const collapsed = collapseResults(buildCollapseInputs(30)).slice(0, MAX_COLLAPSED_ITEMS);

    // collapseResults sorts by score descending, so the retained window must be
    // the top-scoring prefix — entry-0 stays, the lowest-scored entry drops.
    expect(collapsed[0]?.entryId).toBe("entry-0");
    expect(collapsed.map((item) => item.entryId)).not.toContain("entry-29");
  });

  it("leaves smaller collapsed sets untouched", () => {
    const collapsed = collapseResults(buildCollapseInputs(5));
    const parsed = ResumeContextResponseSchema.safeParse(buildResumeResponse(collapsed));

    expect(parsed.success).toBe(true);
    expect(collapsed.length).toBeLessThanOrEqual(MAX_COLLAPSED_ITEMS);
  });
});
