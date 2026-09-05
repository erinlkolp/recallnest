import { describe, expect, it } from "bun:test";

import { composeResumeContext } from "../context-composer.js";
import { selectStableResults } from "../context-composer-stable-selection.js";
import type { RetrievalResult } from "../retriever.js";

/**
 * Regression: resume_context rendered stable context belonging to other scopes.
 *
 * retrieveCandidates deliberately merges a scoped retrieval with an unscoped
 * "global" one (context-composer.ts), so the list handed to selectStableResults
 * always holds foreign-scope rows. selectStableResults applied its scope gate
 * only to `entities`, leaving `profile` and `preferences` ungated — so another
 * project's preferences rendered under a correctly-prefixed project scope.
 *
 * The `entities` gate had a second hole: it only enforced project-to-project
 * isolation when BOTH sides were "project:"-prefixed. Any other request scope
 * (a bare name, or session:/eval:) fell through to fuzzy cue-term matching, and
 * returned true outright when no cue terms could be derived — a scope-isolation
 * guard that failed open.
 *
 * Found by an MCP smoke test on 2026-09-05.
 */

const FOREIGN_SCOPE = "project:vu-server";
const OWN_SCOPE = "project:recallnest";

const FOREIGN_TEXT =
  "How Erin likes engineering work on VU-Server (and generally): TDD first, small commits, no scope creep.";
const OWN_TEXT =
  "Erin prefers RecallNest continuity work to start from resume_context before touching the repo.";

type StableCategory = "profile" | "preferences" | "entities";

function buildResult(
  id: string,
  category: StableCategory,
  text: string,
  scope: string,
  metadata = "{}",
): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category,
      scope,
      importance: 0.9,
      timestamp: Date.parse("2026-09-05T00:00:00.000Z"),
      metadata,
    },
    score: 0.95,
    sources: { fused: { score: 0.95 } },
  } as RetrievalResult;
}

function renderedText(lines: string[]): string {
  return lines.join("\n");
}

describe("selectStableResults scope isolation", () => {
  for (const category of ["profile", "preferences", "entities"] as const) {
    it(`drops foreign-scope ${category} when a project scope is requested`, () => {
      const lines = selectStableResults(
        category,
        [
          buildResult("foreign", category, FOREIGN_TEXT, FOREIGN_SCOPE),
          buildResult("own", category, OWN_TEXT, OWN_SCOPE),
        ],
        5,
        { scope: OWN_SCOPE, taskSeed: "engineering preferences and workflow" },
      );

      expect(renderedText(lines)).not.toContain("VU-Server");
    });
  }

  it("drops foreign-scope entities when a bare scope is requested", () => {
    // A bare scope took the cue-term branch, which matched "recallnest"
    // anywhere in the TEXT and so admitted rows from every other scope.
    const lines = selectStableResults(
      "entities",
      [
        buildResult(
          "foreign",
          "entities",
          "RecallNest is also referenced by the VU-Server dashboard integration.",
          FOREIGN_SCOPE,
        ),
      ],
      5,
      { scope: "recallnest", taskSeed: "recallnest continuity" },
    );

    expect(renderedText(lines)).not.toContain("VU-Server");
  });

  it("does not fail open when no cue terms can be derived from the scope", () => {
    // buildStableScopeCueTerms strips generic terms; a scope made only of
    // generic/short tokens yielded an empty cue list, which returned true.
    const lines = selectStableResults(
      "entities",
      [buildResult("foreign", "entities", FOREIGN_TEXT, FOREIGN_SCOPE)],
      5,
      { scope: "session:a1", taskSeed: undefined },
    );

    expect(renderedText(lines)).not.toContain("VU-Server");
  });

  it("keeps in-scope results when the scope matches", () => {
    const lines = selectStableResults(
      "preferences",
      [buildResult("own", "preferences", OWN_TEXT, OWN_SCOPE)],
      5,
      { scope: OWN_SCOPE, taskSeed: "continuity workflow" },
    );

    expect(renderedText(lines)).toContain("resume_context");
  });

  it("keeps durable pin/brief scopes that carry no project identity", () => {
    // memory:/asset: rows are cut from pins and briefs; they cannot be
    // attributed to a foreign project, so gating must not drop them.
    const lines = selectStableResults(
      "entities",
      [buildResult("pinned", "entities", OWN_TEXT, "asset:brief:3eb0e6b5")],
      5,
      { scope: OWN_SCOPE, taskSeed: "continuity workflow" },
    );

    expect(renderedText(lines)).toContain("resume_context");
  });

  it("lets a privacyTier:shared memory cross scopes", () => {
    const lines = selectStableResults(
      "preferences",
      [
        buildResult(
          "shared",
          "preferences",
          FOREIGN_TEXT,
          FOREIGN_SCOPE,
          JSON.stringify({ privacyTier: "shared" }),
        ),
      ],
      5,
      { scope: OWN_SCOPE, taskSeed: "engineering preferences and workflow" },
    );

    expect(renderedText(lines)).toContain("VU-Server");
  });

  it("still isolates a privacyTier:durable memory from another scope", () => {
    const lines = selectStableResults(
      "preferences",
      [
        buildResult(
          "durable",
          "preferences",
          FOREIGN_TEXT,
          FOREIGN_SCOPE,
          JSON.stringify({ privacyTier: "durable" }),
        ),
      ],
      5,
      { scope: OWN_SCOPE, taskSeed: "engineering preferences and workflow" },
    );

    expect(renderedText(lines)).not.toContain("VU-Server");
  });

  it("applies no scope gate when the caller requests no scope", () => {
    const lines = selectStableResults(
      "preferences",
      [buildResult("foreign", "preferences", FOREIGN_TEXT, FOREIGN_SCOPE)],
      5,
      { taskSeed: "engineering preferences and workflow" },
    );

    expect(renderedText(lines)).toContain("VU-Server");
  });
});

/**
 * privacyTier "shared" must mean the same thing everywhere in one response.
 *
 * selectStableResults honours it, but composeResumeContext filtered the
 * collapsed view, the recalled union and the pin list with a bare
 * matchesScopeFilter — so a shared memory reached "Stable context" and was
 * then dropped from "Collapsed context" and "Essential context" in the very
 * same payload.
 */
describe("privacyTier shared is honoured consistently across sections", () => {
  const SHARED_TEXT = "Erin's attribution rule applies to anything posted publicly under their name.";
  const FOREIGN_TEXT = "claude-memory-pro is the maintenance target for a different repository.";

  function buildRetriever() {
    return {
      async retrieve(context: { category?: string; scopeFilter?: string[] }) {
        if (context.category !== "entities") return [];
        const shared = buildResult(
          "entity-shared",
          "entities",
          SHARED_TEXT,
          "project:vu-server",
          JSON.stringify({ privacyTier: "shared" }),
        );
        const foreign = buildResult("entity-foreign", "entities", FOREIGN_TEXT, "project:other");
        // A scoped retrieval returns only in-scope rows; the unscoped one returns
        // everything. composeResumeContext merges both, then re-filters.
        if (context.scopeFilter?.includes("project:recallnest")) return [];
        return [shared, foreign];
      },
    };
  }

  async function compose() {
    return composeResumeContext({
      retriever: buildRetriever(),
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    } as never, {
      task: "attribution and publishing rules",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });
  }

  it("keeps a shared memory in the collapsed view", async () => {
    const response = await compose();
    const ids = (response.collapsedItems ?? []).map((item) => item.entryId);
    expect(ids).toContain("entity-shared");
  });

  it("still keeps a non-shared foreign memory out of the collapsed view", async () => {
    const response = await compose();
    const collapsed = (response.collapsedItems ?? []).map((item) => item.text).join(" ");
    expect(collapsed).not.toContain("claude-memory-pro");
  });
});
