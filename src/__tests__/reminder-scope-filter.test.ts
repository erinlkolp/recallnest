import { describe, expect, it } from "bun:test";

import { resolveReminderScopeFilter } from "../scope-policy.js";

// Reminder side-effects (checkTriggers / fireReminder) must resolve scope the
// same way the search itself does. The old glue used `scope ? [scope] : undefined`,
// which ignored sessionId/env and let reminders match — and mutate — rows in
// every other scope whenever scoping came from a session id.
describe("resolveReminderScopeFilter", () => {
  it("scopes to the session when scoping comes from sessionId (no explicit scope)", () => {
    expect(resolveReminderScopeFilter({ sessionId: "abc" }, {})).toEqual(["session:abc"]);
  });

  it("uses the explicit scope when provided", () => {
    expect(resolveReminderScopeFilter({ scope: "project:x" }, {})).toEqual(["project:x"]);
  });

  it("returns undefined (cross-scope) only when allScopes is explicitly requested", () => {
    expect(resolveReminderScopeFilter({ allScopes: true }, {})).toBeUndefined();
  });

  it("honors an env default scope instead of scanning globally", () => {
    expect(
      resolveReminderScopeFilter({}, { RECALLNEST_DEFAULT_SCOPE: "project:env" } as NodeJS.ProcessEnv),
    ).toEqual(["project:env"]);
  });

  it("refuses to silently go global when nothing resolves a scope", () => {
    expect(() => resolveReminderScopeFilter({}, {})).toThrow();
  });
});
