/**
 * Drill-down resolution for the memory_drill_down MCP tool.
 *
 * Extracted from the MCP handler so the id-resolution contract is unit-testable
 * independently of the server. The tool documents "unique prefix (at least 8
 * hex chars)" and search/explain only ever display an 8-char id prefix, so the
 * resolver must accept a prefix — not just a full id.
 */

import type { MemoryStore } from "./store.js";

export async function drillDownMemory(
  store: Pick<MemoryStore, "get">,
  id: string,
  level: "overview" | "full" = "full",
): Promise<string> {
  // store.get() resolves both full ids and 8+ hex prefixes (the form search
  // and explain display); store.getById() is exact-match only.
  const entry = await store.get(id);
  if (!entry) {
    return `No memory found with ID: ${id}`;
  }

  // Parse metadata for L0/L1/L2 content
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(entry.metadata || "{}");
  } catch { /* malformed metadata, use raw text */ }

  // Support both legacy short names (l0/l1) and current long names (l0_abstract/l1_overview/l2_content)
  const l0 = typeof meta.l0_abstract === "string" ? meta.l0_abstract : typeof meta.l0 === "string" ? meta.l0 : null;
  const l1 = typeof meta.l1_overview === "string" ? meta.l1_overview : typeof meta.l1 === "string" ? meta.l1 : null;
  const l2 = typeof meta.l2_content === "string" ? meta.l2_content : entry.text;

  let content: string;
  if (level === "overview" && l1) {
    content = `## ${entry.category} (L1 Overview)\n\n${l1}`;
  } else {
    content = `## ${entry.category} (Full Content)\n\n${l2}`;
  }

  const header = [
    `**ID**: ${entry.id}`,
    `**Category**: ${entry.category}`,
    `**Scope**: ${entry.scope}`,
    `**Importance**: ${entry.importance}`,
    `**Created**: ${new Date(entry.timestamp).toISOString()}`,
    l0 ? `**Abstract**: ${l0}` : null,
  ].filter(Boolean).join("\n");

  return `${header}\n\n${content}`;
}
