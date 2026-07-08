/**
 * AD-1: Unified Dream Pipeline
 *
 * Inspired by Claude Code's Auto Dream — a four-phase consolidation pipeline
 * that orchestrates existing RecallNest components into a coherent "dream" cycle.
 *
 * Phases:
 * 1. Orient  — scan memory state, get latest checkpoint, assess activity
 * 2. Gather  — collect recent signals (new writes since last dream)
 * 3. Consolidate — cluster, merge, extract patterns, generate insights
 * 4. Prune   — archive low-value memories, enforce storage hygiene
 *
 * Unlike Auto Dream's grep-only approach, RecallNest uses vector search +
 * LLM-driven consolidation for semantic-level maintenance.
 */

import type { MemoryStore } from "./store.js";
import type { LLMClient } from "./llm-client.js";
import type { Embedder } from "./embedder.js";
import { ConsolidationEngine, clusterAndConsolidate, DEFAULT_CONSOLIDATION_CONFIG } from "./consolidation-engine.js";
import { maybeRunGc, type GcResult, type AutoGcConfig, DEFAULT_AUTO_GC_CONFIG } from "./auto-gc.js";
import { getWriteCount, resetWriteCount } from "./activity-counter.js";
import { isActiveMemory } from "./memory-evolution.js";
import {
  buildMemoryHealthRebalancePlan,
  summarizeMemoryHealthPlans,
  parseMemoryHealthMetadata,
  getMemoryHealthAccessCount,
} from "./memory-health-rebalance.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DreamConfig {
  /** Minimum writes since last dream to justify running (default: 10) */
  minWritesForDream: number;
  /** Consolidation cluster threshold (default: 0.82) */
  clusterThreshold: number;
  /** Minimum cluster size for insight/pattern generation (default: 3) */
  minClusterSize: number;
  /** Enable cross-memory pattern extraction in consolidation (default: true) */
  extractPatterns: boolean;
  /** Max entries to scan per consolidation run (default: 500) */
  maxEntriesPerRun: number;
  /** Max entries to rebalance (tier/importance) per dream run (default: 200) */
  maxRebalancePerRun: number;
  /** GC config for prune phase */
  gc: AutoGcConfig;
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  minWritesForDream: 10,
  clusterThreshold: 0.82,
  minClusterSize: 3,
  extractPatterns: true,
  maxEntriesPerRun: 500,
  maxRebalancePerRun: 200,
  gc: DEFAULT_AUTO_GC_CONFIG,
};

export interface DreamPhaseResult {
  phase: "orient" | "gather" | "consolidate" | "rebalance" | "prune";
  detail: string;
}

export interface DreamResult {
  ran: boolean;
  reason?: string;
  phases: DreamPhaseResult[];
  stats: {
    totalMemories: number;
    activeMemories: number;
    writesSinceLastDream: number;
    clustersFound: number;
    insightsGenerated: number;
    patternsExtracted: number;
    mergedCount: number;
    rebalancedCount: number;
    archivedCount: number;
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runDream(params: {
  store: MemoryStore;
  llm: LLMClient | null;
  embedder: Pick<Embedder, "embedPassage">;
  scope: string;
  config?: Partial<DreamConfig>;
  /** Skip the minimum-writes gate (force run) */
  force?: boolean;
}): Promise<DreamResult> {
  const { store, llm, embedder, scope, force = false } = params;
  const config = { ...DEFAULT_DREAM_CONFIG, ...params.config };
  const phases: DreamPhaseResult[] = [];

  const stats = {
    totalMemories: 0,
    activeMemories: 0,
    writesSinceLastDream: 0,
    clustersFound: 0,
    insightsGenerated: 0,
    patternsExtracted: 0,
    mergedCount: 0,
    rebalancedCount: 0,
    archivedCount: 0,
  };

  // =========================================================================
  // Phase 1: Orient — assess current memory state
  // =========================================================================
  const writeCount = getWriteCount();
  stats.writesSinceLastDream = writeCount;

  const storeStats = await store.stats([scope]);
  stats.totalMemories = storeStats.totalCount ?? 0;

  if (!force && writeCount < config.minWritesForDream) {
    return {
      ran: false,
      reason: `insufficient_writes (${writeCount}/${config.minWritesForDream})`,
      phases: [{
        phase: "orient",
        detail: `${stats.totalMemories} memories, ${writeCount} writes since last dream — below threshold`,
      }],
      stats,
    };
  }

  phases.push({
    phase: "orient",
    detail: `${stats.totalMemories} memories, ${writeCount} writes since last dream`,
  });

  // =========================================================================
  // Phase 2: Gather — collect active entries for consolidation
  // =========================================================================
  const entries = await store.list([scope], undefined, config.maxEntriesPerRun, 0);
  const active = entries.filter(e => isActiveMemory(e.metadata));
  stats.activeMemories = active.length;

  phases.push({
    phase: "gather",
    detail: `${active.length} active entries gathered from ${entries.length} total`,
  });

  if (active.length < config.minClusterSize) {
    phases.push({ phase: "consolidate", detail: "skipped — too few active entries" });
    phases.push({ phase: "rebalance", detail: "skipped — too few active entries" });
    phases.push({ phase: "prune", detail: "skipped — too few entries for GC" });
    resetWriteCount();
    return { ran: true, reason: "completed_early", phases, stats };
  }

  // =========================================================================
  // Phase 3: Consolidate — cluster, merge, generate insights + patterns
  // =========================================================================

  // 3a: Deterministic consolidation (merge near-duplicates, link clusters)
  const engine = new ConsolidationEngine(store, {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    clusterThreshold: config.clusterThreshold,
    maxEntriesPerRun: config.maxEntriesPerRun,
  });
  const consolidation = await engine.run(scope);
  stats.clustersFound += consolidation.clustersFound;
  stats.mergedCount += consolidation.mergedCount;

  // 3b: LLM-driven cluster consolidation (insights + patterns) — requires LLM
  if (llm) {
    const clusterResult = await clusterAndConsolidate({
      entries: active,
      embedder,
      llm,
      store,
      scope,
      minClusterSize: config.minClusterSize,
      clusterThreshold: config.clusterThreshold - 0.07, // slightly lower for semantic clustering
      extractPatterns: config.extractPatterns,
    });
    stats.clustersFound += clusterResult.clustersFound;
    stats.insightsGenerated = clusterResult.insightsGenerated;
    stats.patternsExtracted = clusterResult.patternsExtracted;
  }

  phases.push({
    phase: "consolidate",
    detail: `${stats.clustersFound} clusters, ${stats.mergedCount} merged, ${stats.insightsGenerated} insights, ${stats.patternsExtracted} patterns`,
  });

  // =========================================================================
  // Phase 3.5: Rebalance — recompute tiers/importance from access patterns
  // =========================================================================
  let maxAccessCount = 0;
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;
  for (const entry of active) {
    const md = parseMemoryHealthMetadata(entry.metadata);
    maxAccessCount = Math.max(maxAccessCount, getMemoryHealthAccessCount(md));
    minTimestamp = Math.min(minTimestamp, entry.timestamp);
    maxTimestamp = Math.max(maxTimestamp, entry.timestamp);
  }

  const plans = active.map(entry => buildMemoryHealthRebalancePlan(
    { id: entry.id, importance: entry.importance, timestamp: entry.timestamp, metadata: entry.metadata },
    { maxAccessCount, minTimestamp, maxTimestamp },
  ));
  const changedPlans = plans.filter(p => p.changed).slice(0, config.maxRebalancePerRun);

  let appliedCount = 0;
  for (const plan of changedPlans) {
    // Freshness guard: consolidation (phase 3) may have archived/merged this
    // entry since the gather snapshot. Re-read and apply the plan's tier and
    // importance on top of the CURRENT metadata so we never resurrect a
    // non-active entry or clobber evolution writes made after gather.
    const current = await store.getById(plan.id);
    if (!current || !isActiveMemory(current.metadata)) continue;

    const nextMetadata: Record<string, unknown> = {
      ...parseMemoryHealthMetadata(current.metadata),
      tier: plan.targetTier,
      importance: plan.nextImportance,
    };
    await store.update(plan.id, {
      importance: plan.nextImportance,
      metadata: JSON.stringify(nextMetadata),
    });
    appliedCount++;
  }
  stats.rebalancedCount = appliedCount;

  const rebalanceSummary = summarizeMemoryHealthPlans(plans);
  phases.push({
    phase: "rebalance",
    detail: `${appliedCount} rebalanced (${rebalanceSummary.tierBackfills} tier backfills, ${rebalanceSummary.deadMemoryDemotions} dead-memory demotions)`,
  });

  // =========================================================================
  // Phase 4: Prune — archive low-value memories
  // =========================================================================
  const gcResult = await maybeRunGc(store, config.gc);
  stats.archivedCount = gcResult.archivedCount;

  phases.push({
    phase: "prune",
    detail: gcResult.triggered
      ? `${gcResult.archivedCount} entries archived`
      : `skipped — ${gcResult.reason}`,
  });

  // Reset activity counter after successful dream
  resetWriteCount();

  return { ran: true, phases, stats };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDreamResult(result: DreamResult): string {
  if (!result.ran) {
    return `Dream skipped: ${result.reason}\n${result.phases[0]?.detail ?? ""}`;
  }

  const lines = [
    "Dream completed",
    "",
    ...result.phases.map(p => `[${p.phase}] ${p.detail}`),
    "",
    "Stats:",
    `  Total memories: ${result.stats.totalMemories}`,
    `  Active: ${result.stats.activeMemories}`,
    `  Clusters: ${result.stats.clustersFound}`,
    `  Insights: ${result.stats.insightsGenerated}`,
    `  Patterns: ${result.stats.patternsExtracted}`,
    `  Merged: ${result.stats.mergedCount}`,
    `  Rebalanced: ${result.stats.rebalancedCount}`,
    `  Archived: ${result.stats.archivedCount}`,
  ];

  return lines.join("\n");
}
