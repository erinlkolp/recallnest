import type { RetrievalContext } from "./retriever.js";

function normalizeScopeValue(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return trimmed || undefined;
}

/**
 * Canonical scope form: whitespace-collapsed and lowercased.
 *
 * Scope case was never normalized, so the same project could accumulate two
 * disjoint buckets (`project:VU-Server` vs `project:vu-server`) that no query
 * could union. Canonicalizing the stored scope and the query filter through
 * this one function keeps exact matching correct, which matters because
 * buildScopeWhereClause in store.ts mirrors matchesScopeFilter's semantics in
 * SQL and would otherwise have to diverge.
 */
export function canonicalizeScope(value: string | undefined): string | undefined {
  return normalizeScopeValue(value)?.toLowerCase();
}

function envScopeCandidate(env: NodeJS.ProcessEnv): { scope?: string; inferredFrom?: string } {
  const explicitEnvKeys = [
    "RECALLNEST_DEFAULT_SCOPE",
    "RECALLNEST_SCOPE",
    "RECALLNEST_PROJECT_SCOPE",
  ] as const;

  for (const key of explicitEnvKeys) {
    const value = canonicalizeScope(env[key]);
    if (value) {
      return {
        scope: value,
        inferredFrom: key,
      };
    }
  }

  const sessionId = canonicalizeScope(env.RECALLNEST_SESSION_ID);
  if (sessionId) {
    return {
      scope: `session:${sessionId}`,
      inferredFrom: "RECALLNEST_SESSION_ID",
    };
  }

  return {};
}

export function resolveSessionScope(sessionId?: string): string | undefined {
  const normalized = canonicalizeScope(sessionId);
  return normalized ? `session:${normalized}` : undefined;
}

export function matchesScopeFilter(rowScope: string, scopeFilter?: string[]): boolean {
  if (!scopeFilter || scopeFilter.length === 0) return true;
  // Compare in canonical form so rows written before scope canonicalization
  // (and callers still typing the old capitalized form) still match.
  const row = canonicalizeScope(rowScope) ?? "";
  // Bare scopes match themselves or ":"-separated children only, so a filter
  // like "cc" never bleeds into sibling families such as "ccx:session1".
  return scopeFilter.some((rawScope) => {
    const scope = canonicalizeScope(rawScope) ?? "";
    return scope.includes(":")
      ? row === scope
      : row === scope || row.startsWith(scope + ":");
  });
}

export interface ScopeSelectionOptions {
  scope?: string;
  sessionId?: string;
  allScopes?: boolean;
  operation: string;
  env?: NodeJS.ProcessEnv;
  allowUnscoped?: boolean;
}

export interface ScopeSelection {
  allScopes: boolean;
  resolvedScope?: string;
  scopeFilter?: string[];
  inferredFrom?: string;
}

export function resolveScopeSelection(options: ScopeSelectionOptions): ScopeSelection {
  if (options.allScopes) {
    return {
      allScopes: true,
      scopeFilter: undefined,
      inferredFrom: "allScopes",
    };
  }

  const explicitScope = canonicalizeScope(options.scope);
  if (explicitScope) {
    return {
      allScopes: false,
      resolvedScope: explicitScope,
      scopeFilter: [explicitScope],
      inferredFrom: "scope",
    };
  }

  const sessionScope = resolveSessionScope(options.sessionId);
  if (sessionScope) {
    return {
      allScopes: false,
      resolvedScope: sessionScope,
      scopeFilter: [sessionScope],
      inferredFrom: "sessionId",
    };
  }

  const envSelection = envScopeCandidate(options.env || process.env);
  if (envSelection.scope) {
    return {
      allScopes: false,
      resolvedScope: envSelection.scope,
      scopeFilter: [envSelection.scope],
      inferredFrom: envSelection.inferredFrom,
    };
  }

  if (options.allowUnscoped) {
    return {
      allScopes: false,
      scopeFilter: undefined,
    };
  }

  throw new Error(
    `${options.operation} requires a scope. Pass scope explicitly, provide sessionId, or set ` +
    `RECALLNEST_DEFAULT_SCOPE / RECALLNEST_SCOPE / RECALLNEST_SESSION_ID. ` +
    `Use allScopes=true only for explicit cross-scope reads.`,
  );
}

/**
 * Resolve the scope filter to use for reminder side-effects (checkTriggers /
 * fireReminder) so they honor exactly the same scope / sessionId / allScopes /
 * env resolution as the search that surfaced them. Passing only the raw `scope`
 * arg let reminders read and mutate rows in every other scope whenever scoping
 * came from a session id or env default.
 */
export function resolveReminderScopeFilter(
  args: { scope?: string; sessionId?: string; allScopes?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  return resolveScopeSelection({
    scope: args.scope,
    sessionId: args.sessionId,
    allScopes: args.allScopes,
    operation: "search_memory reminders",
    env,
  }).scopeFilter;
}

export function buildRetrievalContext(
  base: Omit<RetrievalContext, "scopeFilter"> & {
    scope?: string;
    sessionId?: string;
    allScopes?: boolean;
  },
  options: Pick<ScopeSelectionOptions, "operation" | "env" | "allowUnscoped">,
): RetrievalContext {
  const selection = resolveScopeSelection({
    scope: base.scope,
    sessionId: base.sessionId,
    allScopes: base.allScopes,
    operation: options.operation,
    env: options.env,
    allowUnscoped: options.allowUnscoped,
  });

  return {
    query: base.query,
    limit: base.limit,
    category: base.category,
    source: base.source,
    includeArchived: base.includeArchived,
    trace: base.trace,
    graph: base.graph,
    topicTag: base.topicTag,
    reconstruct: base.reconstruct,
    validAt: base.validAt,
    includeExpired: base.includeExpired,
    scopeFilter: selection.scopeFilter,
  };
}
