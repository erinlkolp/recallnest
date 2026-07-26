/**
 * MCP tool tier configuration.
 *
 * Extracted from mcp-server.ts so the tier gate and the list_tools renderer
 * read from one table. Previously list_tools walked TOOL_TIERS directly while
 * registration walked shouldRegisterTool, so the two could disagree about which
 * tools a running server actually exposes.
 */

export type ToolTier = "core" | "advanced" | "governance";

/** The tier a server is configured to run at. */
export type ActiveTier = "core" | "advanced" | "full";

/** The tier a list_tools caller asked to see. */
export type RequestedTier = "core" | "advanced" | "full";

export const TOOL_TIERS: Record<string, ToolTier> = {
  // Core (always)
  resume_context: "core",
  search_memory: "core",
  store_memory: "core",
  checkpoint_session: "core",
  latest_checkpoint: "core",
  list_tools: "core",

  set_reminder: "core",

  // Advanced
  batch_store: "advanced",
  auto_capture: "advanced",
  store_case: "advanced",
  store_workflow_pattern: "advanced",
  promote_memory: "advanced",
  explain_memory: "advanced",
  distill_memory: "advanced",
  brief_memory: "advanced",
  pin_memory: "advanced",
  list_assets: "advanced",
  list_pins: "advanced",
  memory_stats: "advanced",
  data_checkup: "advanced",
  memory_lint: "advanced",
  export_graph: "advanced",
  dream: "advanced",
  memory_drill_down: "advanced",
  export_memory: "advanced",
  store_skill: "advanced",
  retrieve_skill: "advanced",
  import_conversations: "advanced",
  distill_session: "advanced",
  scan_skill_promotions: "governance",
  forget_memory: "advanced",

  // Governance (CLI-only, not in MCP by default)
  workflow_observe: "governance",
  workflow_health: "governance",
  workflow_evidence: "governance",
  list_conflicts: "governance",
  resolve_conflict: "governance",
  audit_conflicts: "governance",
  escalate_conflicts: "governance",
  list_dirty_briefs: "governance",
  clean_dirty_briefs: "governance",
  consolidate_memories: "governance",
};

export function resolveActiveTier(env: NodeJS.ProcessEnv = process.env): ActiveTier {
  return (env.RECALLNEST_MCP_TIER || "advanced") as ActiveTier;
}

/** Whether a tool is registered with the MCP server at the given active tier. */
export function shouldRegisterTool(toolName: string, activeTier: ActiveTier): boolean {
  const tier = TOOL_TIERS[toolName];
  if (!tier) return true; // unknown tools always register (backward compat)
  if (activeTier === "full") return true;
  if (activeTier === "advanced") return tier !== "governance";
  if (activeTier === "core") return tier === "core";
  return true;
}

const TIER_ORDER: Record<ToolTier, number> = { core: 0, advanced: 1, governance: 2 };

/** Tools visible at the requested tier, split by whether they are callable. */
export function selectToolsForTier(
  requestedTier: RequestedTier,
  activeTier: ActiveTier,
): { available: string[]; unavailable: string[] } {
  const maxOrder = requestedTier === "full" ? 2 : TIER_ORDER[requestedTier] ?? 1;

  const available: string[] = [];
  const unavailable: string[] = [];
  for (const [toolName, toolTier] of Object.entries(TOOL_TIERS)) {
    if ((TIER_ORDER[toolTier] ?? 999) > maxOrder) continue;
    if (shouldRegisterTool(toolName, activeTier)) available.push(toolName);
    else unavailable.push(toolName);
  }
  return { available, unavailable };
}

function oneLiner(description: string | undefined): string {
  if (!description) return "(no description)";
  return description.split(/[.!]\s/)[0]?.slice(0, 100) ?? description.slice(0, 100);
}

/**
 * Render the list_tools response.
 *
 * Tools the active tier skipped are still listed — they exist and are worth
 * discovering — but under a heading that says they are not callable here, so an
 * agent reading this cannot mistake them for usable tools.
 */
export function formatToolList(params: {
  requestedTier: RequestedTier;
  activeTier: ActiveTier;
  descriptions: Map<string, string>;
}): string {
  const { requestedTier, activeTier, descriptions } = params;
  const { available, unavailable } = selectToolsForTier(requestedTier, activeTier);

  const lines: string[] = [`Available tools (tier: ${requestedTier}):`];
  for (const toolName of available) {
    lines.push(`- ${toolName}: ${oneLiner(descriptions.get(toolName))}`);
  }

  if (unavailable.length > 0) {
    lines.push(
      "",
      `Not registered on this server (RECALLNEST_MCP_TIER=${activeTier}) — calling these will fail. `
        + "Set RECALLNEST_MCP_TIER=full to enable them, or use the CLI:",
    );
    for (const toolName of unavailable) {
      lines.push(`- ${toolName}: ${oneLiner(descriptions.get(toolName))}`);
    }
  }

  return lines.join("\n");
}
