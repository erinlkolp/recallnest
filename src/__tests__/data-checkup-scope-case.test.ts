import { describe, expect, it } from "bun:test";

import { checkScopeCaseCollisions } from "../data-checkup.js";
import type { MemoryEntry } from "../store.js";

/**
 * Regression: `project:VU-Server` (26 rows) and `project:vu-server` (8 rows)
 * coexisted for a week and no diagnostic noticed. scope-inventory reported zero
 * anomalies because both are structurally valid `project:<slug>` scopes, and
 * matchesScopeFilter kept them disjoint, so each was invisible to the other.
 *
 * Writes are canonicalized now, but rows written by an older client can still
 * carry a mixed-case scope, so the checkup has to surface the split.
 */

function entry(id: string, scope: string): MemoryEntry {
  return {
    id,
    text: `memory ${id}`,
    vector: [0.1],
    category: "events",
    scope,
    importance: 0.7,
    timestamp: Date.parse("2026-07-20T00:00:00.000Z"),
    metadata: "{}",
  } as MemoryEntry;
}

describe("data_checkup scope case collisions", () => {
  it("reports scopes that differ only by case", () => {
    const result = checkScopeCaseCollisions([
      entry("a", "project:VU-Server"),
      entry("b", "project:VU-Server"),
      entry("c", "project:vu-server"),
      entry("d", "project:recallnest"),
    ]);

    expect(result.status).toBe("warning");
    expect(result.detail).toContain("project:vu-server");
    // Both variants and their row counts should be visible enough to act on.
    expect(result.detail).toContain("2");
    expect(result.detail).toContain("1");
  });

  it("passes when every scope is already canonical", () => {
    const result = checkScopeCaseCollisions([
      entry("a", "project:vu-server"),
      entry("b", "project:vu-server"),
      entry("c", "project:recallnest"),
    ]);

    expect(result.status).toBe("ok");
  });

  it("does not flag genuinely distinct scopes", () => {
    const result = checkScopeCaseCollisions([
      entry("a", "project:vu-server"),
      entry("b", "project:vu-server-notes"),
      entry("c", "project:recallnest"),
    ]);

    expect(result.status).toBe("ok");
  });

  it("names the check so the report line is identifiable", () => {
    const result = checkScopeCaseCollisions([entry("a", "project:vu-server")]);

    expect(result.name).toBe("scope_case_collisions");
  });
});
