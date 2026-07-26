import { describe, expect, it } from "bun:test";

import {
  canonicalizeScope,
  matchesScopeFilter,
  resolveScopeSelection,
  resolveSessionScope,
} from "../scope-policy.js";

/**
 * Regression: the same project accumulated two scopes differing only by case.
 *
 * Nothing normalized scope case on write and nothing detected the split, so
 * `project:VU-Server` (26 memory rows, matching the repo name) and
 * `project:vu-server` (8 rows, matching the lowercase slug convention every
 * other scope uses) coexisted for a week. matchesScopeFilter does exact
 * equality for ":"-containing filters, so the two buckets never unioned and
 * each was invisible to the other's queries.
 *
 * Canonical form is lowercase. Normalizing both the stored scope and the query
 * filter keeps exact matching correct without touching the SQL pre-filter in
 * store.ts, which mirrors matchesScopeFilter's semantics.
 */

describe("scope case canonicalization", () => {
  it("lowercases a mixed-case scope", () => {
    expect(canonicalizeScope("project:VU-Server")).toBe("project:vu-server");
  });

  it("leaves an already-canonical scope untouched", () => {
    expect(canonicalizeScope("project:recallnest")).toBe("project:recallnest");
  });

  it("still collapses whitespace", () => {
    expect(canonicalizeScope("  project:VU  Server  ")).toBe("project:vu server");
  });

  it("returns undefined for an empty scope", () => {
    expect(canonicalizeScope("   ")).toBeUndefined();
    expect(canonicalizeScope(undefined)).toBeUndefined();
  });

  it("canonicalizes the resolved scope and its filter together", () => {
    const selection = resolveScopeSelection({ scope: "project:VU-Server", operation: "search" });

    expect(selection.resolvedScope).toBe("project:vu-server");
    expect(selection.scopeFilter).toEqual(["project:vu-server"]);
  });

  it("canonicalizes session scopes", () => {
    expect(resolveSessionScope("ABC-123")).toBe("session:abc-123");
  });

  it("matches a canonical row against a mixed-case filter", () => {
    // Both sides are canonicalized before comparison, so a caller that types
    // the old capitalized form still reaches the migrated rows.
    expect(matchesScopeFilter("project:vu-server", ["project:VU-Server"])).toBe(true);
  });

  it("matches a legacy mixed-case row against a canonical filter", () => {
    // Protects rows written before the migration ran.
    expect(matchesScopeFilter("project:VU-Server", ["project:vu-server"])).toBe(true);
  });

  it("still keeps genuinely different scopes disjoint", () => {
    expect(matchesScopeFilter("project:vu-server", ["project:recallnest"])).toBe(false);
    expect(matchesScopeFilter("project:vu-server-notes", ["project:vu-server"])).toBe(false);
  });

  it("still prefix-matches bare scopes without bleeding into siblings", () => {
    expect(matchesScopeFilter("cc:session1", ["cc"])).toBe(true);
    expect(matchesScopeFilter("ccx:session1", ["cc"])).toBe(false);
  });
});
