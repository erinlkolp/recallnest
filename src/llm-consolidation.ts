/**
 * LLM-Driven Consolidation — Tier 3.7
 *
 * Enhances the base consolidation engine by using LLM to make semantic
 * merge decisions instead of relying solely on vector similarity thresholds.
 *
 * Flow:
 * 1. Base engine finds vector clusters (existing logic)
 * 2. For each cluster, LLM evaluates whether entries should truly be merged
 * 3. LLM can: merge (create version group), keep separate, or flag conflicts
 *
 * Enable: RECALLNEST_LLM_CONSOLIDATION=true environment variable.
 */

import type { LLMClient } from "./llm-client.js";
import type { MemoryEntry, MemoryStore } from "./store.js";
import { createVersionGroup } from "./version-manager.js";
import { logInfo, logWarn } from "./stderr-log.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Check if LLM-driven consolidation is enabled.
 */
export function isLLMConsolidationEnabled(): boolean {
  return process.env.RECALLNEST_LLM_CONSOLIDATION === "true";
}

// ============================================================================
// Types
// ============================================================================

export interface LLMConsolidationDecision {
  /** Which entries to merge together (by index in the cluster) */
  mergeGroups: number[][];
  /** Indices of entries to keep as-is */
  keepSeparate: number[];
  /** Reason for the decision */
  reasoning: string;
}

// ============================================================================
// Core
// ============================================================================

/**
 * Ask LLM to evaluate a cluster of similar memories and decide merge groups.
 *
 * @param llm       LLM client
 * @param entries   Cluster of similar memory entries
 * @returns Decision on which to merge and which to keep separate
 */
export async function evaluateCluster(
  llm: LLMClient,
  entries: MemoryEntry[],
): Promise<LLMConsolidationDecision> {
  if (entries.length < 2) {
    return { mergeGroups: [], keepSeparate: [0], reasoning: "single entry" };
  }

  const numbered = entries.map((e, i) =>
    `[${i}] (${e.category}, importance=${e.importance.toFixed(2)}): ${e.text.slice(0, 300)}`
  ).join("\n");

  try {
    const response = await llm.synthesizeFragments(
      [
        `以下是一组语义相似的记忆条目。请判断哪些应该合并（因为表达同一含义），哪些应该保持独立（虽然相似但含义不同）。`,
        `条目列表：\n${numbered}`,
        `输出 JSON：{"mergeGroups": [[0,1], [2,3]], "keepSeparate": [4], "reasoning": "简短理由"}`,
        `规则：\n- 含义相同/高度重复 → 合并\n- 相似但有独特信息 → 保持独立\n- 矛盾/冲突 → 保持独立并注明`,
      ],
      "consolidation decision",
      800,
    );

    if (!response) {
      return fallbackDecision(entries);
    }

    // Parse JSON from response
    const cleaned = response.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      return fallbackDecision(entries);
    }

    const parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));

    const mergeGroups = Array.isArray(parsed.mergeGroups)
      ? parsed.mergeGroups.filter((g: unknown) =>
          Array.isArray(g) && g.length >= 2 && g.every((i: unknown) => typeof i === "number" && i >= 0 && i < entries.length)
        )
      : [];

    const keepSeparate = Array.isArray(parsed.keepSeparate)
      ? parsed.keepSeparate.filter((i: unknown) => typeof i === "number" && i >= 0 && i < entries.length)
      : [];

    return {
      mergeGroups,
      keepSeparate,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "LLM decision",
    };
  } catch (err) {
    logWarn("LLM consolidation evaluation failed:", err);
    return fallbackDecision(entries);
  }
}

/**
 * Execute LLM consolidation decisions on a cluster.
 * Creates version groups for entries that should be merged.
 *
 * @param store   Memory store (for version group creation)
 * @param entries Cluster entries
 * @param decision LLM's decision
 * @param scope   Scope for store updates
 * @returns Number of merges performed
 */
export async function executeMergeDecisions(
  store: Parameters<typeof createVersionGroup>[0],
  entries: MemoryEntry[],
  decision: LLMConsolidationDecision,
  scope: string,
): Promise<number> {
  let mergeCount = 0;

  for (const group of decision.mergeGroups) {
    if (group.length < 2) continue;

    // Sort by importance descending — first is canonical
    const groupEntries = group
      .map(i => entries[i])
      .filter(Boolean)
      .sort((a, b) => b.importance - a.importance);

    const canonical = groupEntries[0];
    for (const member of groupEntries.slice(1)) {
      await createVersionGroup(store, canonical, member, scope);
      mergeCount++;
    }
  }

  if (mergeCount > 0) {
    logInfo(`[INFO] LLM consolidation: ${mergeCount} merges in cluster of ${entries.length} — ${decision.reasoning}`);
  }

  return mergeCount;
}

/**
 * Discover clusters the base engine linked (via `cluster_members` metadata) and
 * let the LLM decide which to merge into version groups. Extracted from the
 * former `maybeConsolidate` wrapper so the dream pipeline can invoke it directly
 * (see dream-pipeline consolidate phase). Clusters already merged into a
 * version group are skipped. Returns the number of merges performed; no-ops
 * (returns 0, never touches the LLM) when no unmerged clusters exist.
 */
export async function runLlmClusterMerges(params: {
  store: MemoryStore;
  scope: string;
  llm: LLMClient;
  /** Max entries to scan for linked clusters (default: 500) */
  maxEntries?: number;
}): Promise<number> {
  const { store, scope, llm, maxEntries = 500 } = params;

  const allEntries = await store.list([scope], undefined, maxEntries);
  const clusterMap = new Map<string, MemoryEntry[]>();

  for (const entry of allEntries) {
    try {
      const meta = JSON.parse(entry.metadata || "{}");
      const members = meta.cluster_members as string[] | undefined;
      if (Array.isArray(members) && members.length > 0 && !meta.version_group) {
        const cluster = [entry];
        for (const memberId of members) {
          const member = await store.getById(memberId);
          if (member) cluster.push(member);
        }
        if (cluster.length >= 2) clusterMap.set(entry.id, cluster);
      }
    } catch { /* skip malformed metadata */ }
  }

  let llmMerges = 0;
  for (const [, cluster] of clusterMap) {
    const decision = await evaluateCluster(llm, cluster);
    llmMerges += await executeMergeDecisions(store, cluster, decision, scope);
  }

  return llmMerges;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fallback when LLM fails: don't merge anything (conservative).
 */
function fallbackDecision(entries: MemoryEntry[]): LLMConsolidationDecision {
  return {
    mergeGroups: [],
    keepSeparate: entries.map((_, i) => i),
    reasoning: "LLM unavailable, keeping all entries separate",
  };
}
