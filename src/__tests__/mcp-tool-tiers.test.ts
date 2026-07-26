import { describe, expect, it } from "bun:test";

import {
  TOOL_TIERS,
  formatToolList,
  selectToolsForTier,
  shouldRegisterTool,
} from "../mcp-tool-tiers.js";

/**
 * Regression: list_tools advertised tools the running server had not registered.
 *
 * registerTool() records a description before the tier gate, then skips
 * registration for governance tools unless RECALLNEST_MCP_TIER=full. list_tools
 * walked TOOL_TIERS directly, so at the default "advanced" tier it listed all 11
 * governance tools as available. An agent that trusted the listing — including
 * one told by its own instructions to call workflow_observe — got a hard tool
 * error, because those tools do not exist on that server.
 *
 * Found by an MCP smoke test: list_tools(tier:"full") advertised 41 tools while
 * only 30 were callable.
 */

const GOVERNANCE_TOOL = "workflow_observe";

function descriptionsFor(names: string[]): Map<string, string> {
  return new Map(names.map((name) => [name, `Does the ${name} thing. Extra detail here.`]));
}

const ALL_DESCRIPTIONS = descriptionsFor(Object.keys(TOOL_TIERS));

describe("MCP tool tiers", () => {
  it("does not register governance tools at the default advanced tier", () => {
    expect(shouldRegisterTool(GOVERNANCE_TOOL, "advanced")).toBe(false);
  });

  it("registers governance tools at the full tier", () => {
    expect(shouldRegisterTool(GOVERNANCE_TOOL, "full")).toBe(true);
  });

  it("splits requested tools by whether the active tier registered them", () => {
    const { available, unavailable } = selectToolsForTier("full", "advanced");

    expect(unavailable).toContain(GOVERNANCE_TOOL);
    expect(available).not.toContain(GOVERNANCE_TOOL);
    expect(available).toContain("search_memory");
  });

  it("marks unregistered tools as uncallable instead of advertising them", () => {
    const output = formatToolList({
      requestedTier: "full",
      activeTier: "advanced",
      descriptions: ALL_DESCRIPTIONS,
    });

    // The tool is still discoverable...
    expect(output).toContain(GOVERNANCE_TOOL);
    // ...but never under the heading that implies it can be called.
    const availableBlock = output.split("Not registered")[0] ?? "";
    expect(availableBlock).not.toContain(GOVERNANCE_TOOL);
    expect(output).toContain("RECALLNEST_MCP_TIER=full");
  });

  it("lists every requested tool as available when the active tier is full", () => {
    const output = formatToolList({
      requestedTier: "full",
      activeTier: "full",
      descriptions: ALL_DESCRIPTIONS,
    });

    expect(output).not.toContain("Not registered");
    expect(output).toContain(GOVERNANCE_TOOL);
  });

  it("never lists a tool the active tier skipped as available", () => {
    const { available } = selectToolsForTier("full", "core");

    for (const toolName of available) {
      expect(shouldRegisterTool(toolName, "core")).toBe(true);
    }
    expect(available).toEqual(["resume_context", "search_memory", "store_memory",
      "checkpoint_session", "latest_checkpoint", "list_tools", "set_reminder"]);
  });
});
