/**
 * Forget Engine — Ethics-aware memory deletion with full cascade.
 *
 * Philosophy: "The right to forget" — memories can be explicitly removed,
 * but the process must be auditable, reversible (via evidence export),
 * and propagated to all derived artifacts (KG triples, pins, evolution chains).
 *
 * Sequence:
 * 1. Fetch target memory
 * 2. Privacy tier check (durable requires explicit confirm)
 * 3. Evidence export (snapshot before deletion for audit trail)
 * 4. KG triple cleanup (via KGStore.deleteBySource)
 * 5. Pin cascade (delete derived pin assets and their indexed entries)
 * 5b. Brief cascade (delete derived brief assets and their indexed entries)
 * 6. Cascade demote (related memories via cascade-forget.ts)
 * 7. Evolution breadcrumb (mark status before delete)
 * 8. Primary delete (remove from LanceDB)
 * 9. Audit log (record the forget operation)
 */

import { rmSync } from "node:fs";

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { KGStore } from "./kg-store.js";
import type { AuditLogger } from "./audit-log.js";
import { parsePrivacyTier, type PrivacyTier } from "./memory-schema.js";
import { parseEvolution, patchEvolution } from "./memory-evolution.js";
import { cascadeForget, type CascadeForgetConfig, DEFAULT_CASCADE_FORGET_CONFIG } from "./cascade-forget.js";
import { listBriefAssets, listPinAssets, type BriefAsset, type PinAsset } from "./memory-assets.js";

/** Upper bound on pin files scanned when looking for derived pins to remove. */
const PIN_SCAN_LIMIT = 500;

/** Upper bound on brief files scanned when looking for derived briefs to remove. */
const BRIEF_SCAN_LIMIT = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForgetRequest {
  /** Memory ID to forget (full UUID or 8+ hex prefix) */
  memoryId: string;
  /** Explicit confirmation — required for "durable" tier memories */
  confirm: boolean;
  /** Reason for forgetting (audit trail) */
  reason?: string;
  /** Scope filter for permission check */
  scopeFilter?: string[];
}

export interface ForgetEvidence {
  /** Snapshot of the memory before deletion */
  entry: MemoryEntry;
  /** Privacy tier at time of deletion */
  privacyTier: PrivacyTier;
  /** Evolution chain snapshot */
  evolution: ReturnType<typeof parseEvolution>;
  /** Timestamp of forget operation */
  forgottenAt: string;
  /** Reason provided */
  reason?: string;
}

export interface ForgetResult {
  /** Whether the memory was successfully forgotten */
  success: boolean;
  /** ID of the forgotten memory */
  memoryId: string;
  /** Evidence snapshot (for audit/undo) */
  evidence?: ForgetEvidence;
  /** Number of KG triples removed */
  kgTriplesRemoved: boolean;
  /** Cascade demote results */
  cascadeResult: { demotedCount: number; demotedIds: string[] };
  /** Number of derived pin assets removed */
  pinsRemoved: number;
  /** Number of derived brief assets removed */
  briefsRemoved: number;
  /** Set when the id resolved to a standalone asset rather than a memory row */
  assetType?: "pin" | "brief";
  /** Error message if failed */
  error?: string;
}

/** Pin asset access, injectable so the cascade can be tested without disk I/O. */
export interface PinAssetAccess {
  list: (limit?: number) => Array<PinAsset & { path: string }>;
  remove: (path: string) => void;
}

const DISK_PIN_ASSETS: PinAssetAccess = {
  list: (limit = PIN_SCAN_LIMIT) => listPinAssets(limit),
  remove: (path: string) => rmSync(path, { force: true }),
};

/** Brief asset access, injectable so the cascade can be tested without disk I/O. */
export interface BriefAssetAccess {
  list: (limit?: number) => Array<BriefAsset & { path: string }>;
  remove: (path: string) => void;
}

const DISK_BRIEF_ASSETS: BriefAssetAccess = {
  list: (limit = BRIEF_SCAN_LIMIT) => listBriefAssets(limit),
  remove: (path: string) => rmSync(path, { force: true }),
};

export interface ForgetByIdDeps {
  store: MemoryStore;
  kgStore?: KGStore | null;
  auditLogger?: AuditLogger | null;
  cascadeConfig?: CascadeForgetConfig;
  /** Defaults to the on-disk pin store. */
  pinAssets?: PinAssetAccess;
  /** Defaults to the on-disk brief store. */
  briefAssets?: BriefAssetAccess;
}

// ---------------------------------------------------------------------------
// Fallback: Forget a standalone asset (brief or pin) by its own id
// ---------------------------------------------------------------------------

/** Shortest id prefix accepted, matching the memory-id prefix rule. */
const MIN_ASSET_ID_PREFIX = 8;

function assetIdMatches(assetId: string, query: string): boolean {
  if (assetId === query) return true;
  return query.length >= MIN_ASSET_ID_PREFIX && assetId.startsWith(query);
}

function emptyAssetResult(memoryId: string, error?: string): ForgetResult {
  return {
    success: false,
    memoryId,
    kgTriplesRemoved: false,
    cascadeResult: { demotedCount: 0, demotedIds: [] },
    pinsRemoved: 0,
    briefsRemoved: 0,
    ...(error ? { error } : {}),
  };
}

async function forgetAssetById(
  deps: {
    store: MemoryStore;
    pinAssets: PinAssetAccess;
    briefAssets: BriefAssetAccess;
    auditLogger?: AuditLogger | null;
  },
  request: { memoryId: string; confirm: boolean; reason?: string },
): Promise<ForgetResult> {
  const { store, pinAssets, briefAssets, auditLogger } = deps;
  const { memoryId, confirm, reason } = request;

  const brief = briefAssets.list(BRIEF_SCAN_LIMIT).find((asset) => assetIdMatches(asset.id, memoryId));
  const pin = brief
    ? undefined
    : pinAssets.list(PIN_SCAN_LIMIT).find((asset) => assetIdMatches(asset.id, memoryId));

  if (!brief && !pin) {
    return emptyAssetResult(memoryId, `Memory ${memoryId} not found`);
  }

  const assetType = brief ? "brief" : "pin";
  const asset = brief ?? pin!;

  // Assets embed their sources' text verbatim, so deleting one is as
  // destructive as forgetting a memory — hold it to the same confirmation bar.
  if (!confirm) {
    return {
      ...emptyAssetResult(asset.id, `Asset ${asset.id} is a ${assetType} — set confirm=true to proceed`),
      assetType,
    };
  }

  // indexAsset() files briefs under `asset:brief:<first 8>` and pins under `asset:<first 8>`
  const indexedScope = brief
    ? `asset:brief:${asset.id.slice(0, 8)}`
    : `asset:${asset.id.slice(0, 8)}`;

  try {
    await store.bulkDelete([indexedScope]);
  } catch (err) {
    return {
      ...emptyAssetResult(asset.id, `Asset index delete failed: ${err instanceof Error ? err.message : String(err)}`),
      assetType,
    };
  }

  try {
    if (brief) briefAssets.remove(brief.path);
    else pinAssets.remove(pin!.path);
  } catch (err) {
    return {
      ...emptyAssetResult(asset.id, `Asset file delete failed: ${err instanceof Error ? err.message : String(err)}`),
      assetType,
    };
  }

  try {
    auditLogger?.log({
      operation: "forget",
      scope: indexedScope,
      memoryId: asset.id,
      actor: "system",
      details: `asset=${assetType} reason=${reason || "none"}`,
    });
  } catch (err) {
    console.error("[recallnest] Audit log failed during asset forget:", err instanceof Error ? err.message : String(err));
  }

  return {
    success: true,
    memoryId: asset.id,
    kgTriplesRemoved: false,
    cascadeResult: { demotedCount: 0, demotedIds: [] },
    pinsRemoved: pin ? 1 : 0,
    briefsRemoved: brief ? 1 : 0,
    assetType,
  };
}

// ---------------------------------------------------------------------------
// Core: Forget a single memory
// ---------------------------------------------------------------------------

export async function forgetMemory(
  deps: ForgetByIdDeps,
  request: ForgetRequest,
): Promise<ForgetResult> {
  const { store, kgStore, auditLogger, cascadeConfig } = deps;
  const pinAssets = deps.pinAssets ?? DISK_PIN_ASSETS;
  const briefAssets = deps.briefAssets ?? DISK_BRIEF_ASSETS;
  const { memoryId, confirm, reason, scopeFilter } = request;

  // 1. Fetch target
  const entry = await store.get(memoryId, scopeFilter);
  if (!entry) {
    // Assets are not memory rows: a brief lives on disk and is indexed under
    // `asset:brief:<id>`, so its own id never resolves here. Without this
    // fallback a brief could only be removed as collateral from forgetting one
    // of its sources, leaving no way to delete it directly.
    return forgetAssetById({ store, pinAssets, briefAssets, auditLogger }, { memoryId, confirm, reason });
  }

  // 2. Privacy tier check
  const privacyTier = parsePrivacyTier(entry.metadata);
  if (privacyTier === "durable" && !confirm) {
    return {
      success: false,
      memoryId: entry.id,
      kgTriplesRemoved: false,
      cascadeResult: { demotedCount: 0, demotedIds: [] },
      pinsRemoved: 0,
      briefsRemoved: 0,
      error: `Memory ${entry.id} has privacy tier "durable" — set confirm=true to proceed`,
    };
  }

  // 3. Evidence export (snapshot before deletion)
  const evolution = parseEvolution(entry.metadata, entry.timestamp);
  const evidence: ForgetEvidence = {
    entry: { ...entry },
    privacyTier,
    evolution,
    forgottenAt: new Date().toISOString(),
    reason,
  };

  // 4. KG triple cleanup
  let kgTriplesRemoved = false;
  if (kgStore) {
    try {
      await kgStore.deleteBySource(entry.id);
      kgTriplesRemoved = true;
    } catch (err) {
      console.error("[recallnest] KG cleanup failed during forget:", err instanceof Error ? err.message : String(err));
    }
  }

  // 5. Pin cascade — a pin is a derived copy of the memory. Leaving it behind
  // keeps the forgotten text surfacing through the pinned-context path, so
  // remove both the asset file and the `asset:*` entry that indexes it.
  let pinsRemoved = 0;
  try {
    const derivedPins = pinAssets.list(PIN_SCAN_LIMIT)
      .filter((pin) => pin.source.memoryId === entry.id);
    for (const pin of derivedPins) {
      // indexAsset() files pinned assets under scope `asset:<first 8 of pin id>`
      await store.bulkDelete([`asset:${pin.id.slice(0, 8)}`]);
      pinAssets.remove(pin.path);
      pinsRemoved++;
    }
  } catch (err) {
    console.error("[recallnest] Pin cascade failed during forget:", err instanceof Error ? err.message : String(err));
  }

  // 5b. Brief cascade — a brief quotes its sources verbatim in summary,
  // takeaways, and evidence. One forgotten source is enough to leave that text
  // searchable through the brief, so drop any brief citing this memory along
  // with the `asset:brief:*` entry that indexes it.
  let briefsRemoved = 0;
  try {
    const derivedBriefs = briefAssets.list(BRIEF_SCAN_LIMIT)
      .filter((brief) => brief.evidence.some((item) => item.memoryId === entry.id));
    for (const brief of derivedBriefs) {
      // indexAsset() files briefs under scope `asset:brief:<first 8 of brief id>`
      await store.bulkDelete([`asset:brief:${brief.id.slice(0, 8)}`]);
      briefAssets.remove(brief.path);
      briefsRemoved++;
    }
  } catch (err) {
    console.error("[recallnest] Brief cascade failed during forget:", err instanceof Error ? err.message : String(err));
  }

  // 6. Cascade demote (related memories get importance reduction)
  let cascadeResult = { demotedCount: 0, demotedIds: [] as string[] };
  try {
    cascadeResult = await cascadeForget(
      store,
      { id: entry.id, vector: entry.vector, scope: entry.scope },
      cascadeConfig ?? DEFAULT_CASCADE_FORGET_CONFIG,
    );
  } catch (err) {
    console.error("[recallnest] Cascade demote failed during forget:", err instanceof Error ? err.message : String(err));
  }

  // 7. Mark evolution status as "forgotten" before delete (audit breadcrumb)
  try {
    const patchedMetadata = patchEvolution(entry.metadata, {
      status: "archived" as any,
      evolutionNote: `forgotten: ${reason || "user request"}`,
    });
    await store.update(entry.id, { metadata: patchedMetadata }, scopeFilter);
  } catch (err) {
    console.error("[recallnest] Evolution patch failed during forget:", err instanceof Error ? err.message : String(err));
  }

  // 8. Primary delete
  try {
    await store.delete(entry.id, scopeFilter);
  } catch (err) {
    return {
      success: false,
      memoryId: entry.id,
      evidence,
      kgTriplesRemoved,
      cascadeResult,
      pinsRemoved,
      briefsRemoved,
      error: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 9. Audit log
  try {
    auditLogger?.log({
      operation: "forget",
      scope: entry.scope,
      memoryId: entry.id,
      actor: "system",
      details: `tier=${privacyTier} reason=${reason || "none"} cascade=${cascadeResult.demotedCount}`,
    });
    if (cascadeResult.demotedCount > 0) {
      auditLogger?.log({
        operation: "cascade_forget",
        scope: entry.scope,
        memoryId: entry.id,
        actor: "system",
        details: `demoted ${cascadeResult.demotedCount} related memories: ${cascadeResult.demotedIds.map(id => id.slice(0, 8)).join(",")}`,
      });
    }
  } catch (err) {
    console.error("[recallnest] Audit log failed during forget:", err instanceof Error ? err.message : String(err));
  }

  return {
    success: true,
    memoryId: entry.id,
    evidence,
    kgTriplesRemoved,
    cascadeResult,
    pinsRemoved,
    briefsRemoved,
  };
}

// ---------------------------------------------------------------------------
// Bulk: Forget all memories in a scope
// ---------------------------------------------------------------------------

export interface ForgetByScopeResult {
  forgottenCount: number;
  failedCount: number;
  kgScopeCleared: boolean;
  totalCascadeDemoted: number;
}

export async function forgetByScope(
  deps: ForgetByIdDeps,
  scope: string,
  confirm: boolean,
  reason?: string,
): Promise<ForgetByScopeResult> {
  if (!confirm) {
    return { forgottenCount: 0, failedCount: 0, kgScopeCleared: false, totalCascadeDemoted: 0 };
  }

  const { store, kgStore, auditLogger } = deps;
  let forgottenCount = 0;
  let failedCount = 0;
  let totalCascadeDemoted = 0;

  // Fetch all entries in scope
  const entries = await store.list([scope], undefined, 5000);

  for (const entry of entries) {
    const result = await forgetMemory(deps, {
      memoryId: entry.id,
      confirm: true,
      reason: reason || `scope-level forget: ${scope}`,
      scopeFilter: [scope],
    });

    if (result.success) {
      forgottenCount++;
      totalCascadeDemoted += result.cascadeResult.demotedCount;
    } else {
      failedCount++;
    }
  }

  // Bulk KG scope cleanup
  let kgScopeCleared = false;
  if (kgStore) {
    try {
      await kgStore.deleteByScope(scope);
      kgScopeCleared = true;
    } catch (err) {
      console.error("[recallnest] KG scope cleanup failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // Audit the bulk operation
  try {
    auditLogger?.log({
      operation: "forget",
      scope,
      actor: "system",
      details: `scope-forget: ${forgottenCount} deleted, ${failedCount} failed, ${totalCascadeDemoted} cascade-demoted`,
    });
  } catch (err) {
    console.error("[recallnest] Audit log failed during scope forget:", err instanceof Error ? err.message : String(err));
  }

  return { forgottenCount, failedCount, kgScopeCleared, totalCascadeDemoted };
}
