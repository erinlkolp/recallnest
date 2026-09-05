import { dedupeText } from "./context-composer-text.js";
import { matchesScopeFilter } from "./scope-policy.js";
import { parsePrivacyTier } from "./memory-schema.js";
import {
  GENERIC_SCOPE_TERMS,
  buildTaskHintTerms,
  extractTerms,
  normalizeText,
} from "./term-registry.js";

export function normalizeScopedValue(scope: string): string {
  const normalized = normalizeText(scope);
  if (normalized.startsWith("memory:")) return normalized.slice("memory:".length);
  if (normalized.startsWith("asset:")) return normalized.slice("asset:".length);
  return normalized;
}

/**
 * A pin or brief carries the scope of the asset it was cut from and so cannot
 * be attributed to a foreign project.
 */
export function isDurableStableScope(scope: string): boolean {
  return scope.startsWith("memory:") || scope.startsWith("asset:");
}

/**
 * Single source of truth for "may this row appear under the requested scope?".
 *
 * Every section of a resume_context response must answer this the same way,
 * otherwise a memory renders in one block and vanishes from the next.
 */
export function isScopeAllowedForRecall(
  entryScope: string,
  metadata: string | undefined,
  requestScope?: string,
): boolean {
  if (!requestScope) return true;
  if (isDurableStableScope(entryScope)) return true;
  // privacyTier "shared" is the supported cross-scope escape hatch.
  if (parsePrivacyTier(metadata) === "shared") return true;
  return matchesScopeFilter(entryScope, [requestScope]);
}

function buildScopeIdentityTerms(scope?: string): string[] {
  if (!scope) return [];

  const normalizedScope = normalizeScopedValue(scope);
  const identity = normalizedScope.includes(":")
    ? normalizedScope.slice(normalizedScope.indexOf(":") + 1)
    : normalizedScope;
  if (!identity) return [];

  const spaced = identity.replace(/[-_/.:]+/g, " ");
  return dedupeText([
    identity,
    spaced,
    ...extractTerms(identity),
    ...extractTerms(spaced),
  ], 12)
    .map((term) => normalizeText(term))
    .filter((term) =>
      term.length >= 2 &&
      !GENERIC_SCOPE_TERMS.has(term),
    );
}

export function buildProjectScopeCueTerms(scope?: string): string[] {
  if (!scope) return [];
  return dedupeText(extractTerms(scope), 8)
    .map((term) => normalizeText(term))
    .filter((term) =>
      term.length >= 2 &&
      !GENERIC_SCOPE_TERMS.has(term),
    );
}

export function taskMentionsScopeIdentity(taskSeed: string | undefined, scope?: string): boolean {
  if (!taskSeed) return false;
  const identityTerms = buildScopeIdentityTerms(scope);
  if (identityTerms.length === 0) return false;

  const haystack = normalizeText(`${taskSeed} ${buildTaskHintTerms(taskSeed).join(" ")}`);
  return identityTerms.some((term) => haystack.includes(term));
}
