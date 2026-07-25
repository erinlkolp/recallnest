/**
 * Correction Supersession Linking
 *
 * auto_capture's correction signal stores the correction as its own memory,
 * separate from the fact it corrects. Both then sit in the store as active,
 * equally-weighted entries, so retrieval can hand back the stale one.
 *
 * This links them: a correction marks the memory it contradicts as superseded
 * and records the bidirectional evolution link, the same shape persistMemory's
 * LLM-backed A-2 path produces. Zero LLM calls — reuses the negation heuristic
 * so auto_capture stays on its pure-heuristic budget.
 */

import { detectHeuristicContradiction } from "./consolidation-engine.js";
import {
  buildSupersedeMetadata,
  buildSupersedeMetadataForNew,
  isActiveMemory,
} from "./memory-evolution.js";
import type { MemoryEntry, MemoryStore } from "./store.js";

/** Max candidate entries scanned per correction (performance guard). */
const MAX_CANDIDATES = 200;

/**
 * Max memories a single correction may supersede. A correction normally
 * invalidates one prior fact; a higher count means the heuristic over-matched,
 * so cap the blast radius rather than mass-superseding a scope.
 */
const MAX_SUPERSEDED_PER_CORRECTION = 3;

export interface CorrectionCandidate {
  id: string;
  text: string;
}

export interface SupersessionLink {
  correctionId: string;
  supersededId: string;
}

export interface CorrectionSupersedeDeps {
  store: Pick<MemoryStore, "list" | "update">;
}

export interface CorrectionSupersedeParams {
  scope: string;
  corrections: CorrectionCandidate[];
}

/**
 * Link each correction to the active memories it contradicts within one scope.
 *
 * Returns the links that were written. Callers may surface them; nothing here
 * throws on a store miss, since a failed link must never fail the capture.
 */
export async function linkCorrectionSupersessions(
  deps: CorrectionSupersedeDeps,
  params: CorrectionSupersedeParams,
): Promise<SupersessionLink[]> {
  if (params.corrections.length === 0) return [];

  const entries = await deps.store.list([params.scope], undefined, MAX_CANDIDATES, 0);
  const correctionIds = new Set(params.corrections.map((item) => item.id));
  const links: SupersessionLink[] = [];

  // Entries superseded by an earlier correction in this same batch must not be
  // re-superseded by a later one, so track them as we go.
  const consumed = new Set<string>();

  for (const correction of params.corrections) {
    let supersededForThis = 0;

    for (const entry of entries) {
      if (supersededForThis >= MAX_SUPERSEDED_PER_CORRECTION) break;
      if (!isSupersedable(entry, correction, correctionIds, consumed)) continue;
      if (!detectHeuristicContradiction(correction.text, entry.text)) continue;

      const updatedOld = await deps.store.update(entry.id, {
        metadata: buildSupersedeMetadata(entry.metadata, correction.id),
      });
      if (!updatedOld) continue;

      entry.metadata = updatedOld.metadata;
      consumed.add(entry.id);
      supersededForThis += 1;
      links.push({ correctionId: correction.id, supersededId: entry.id });

      await linkForwardReference(deps, entries, correction.id, entry.id);
    }
  }

  return links;
}

function isSupersedable(
  entry: MemoryEntry,
  correction: CorrectionCandidate,
  correctionIds: Set<string>,
  consumed: Set<string>,
): boolean {
  if (entry.id === correction.id) return false;
  // A correction never supersedes another correction from the same turn.
  if (correctionIds.has(entry.id)) return false;
  if (consumed.has(entry.id)) return false;
  return isActiveMemory(entry.metadata);
}

/** Write the correction -> superseded backlink so the chain walks both ways. */
async function linkForwardReference(
  deps: CorrectionSupersedeDeps,
  entries: MemoryEntry[],
  correctionId: string,
  supersededId: string,
): Promise<void> {
  const correctionEntry = entries.find((candidate) => candidate.id === correctionId);
  const updated = await deps.store.update(correctionId, {
    metadata: buildSupersedeMetadataForNew(
      correctionEntry?.metadata,
      supersededId,
      "auto_capture: correction signal superseded a contradicted fact",
    ),
  });
  if (updated && correctionEntry) {
    correctionEntry.metadata = updated.metadata;
  }
}
