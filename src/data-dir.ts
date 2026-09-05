/**
 * Sidecar data directory resolution.
 *
 * RecallNest writes a handful of small state files alongside the LanceDB store:
 * activity stats, the distill lock, the audit log and retention policies.
 * These used to default to a bare relative "data/", which resolves against
 * process.cwd() — and the MCP server inherits the cwd of whichever repo the
 * agent launched it from, so every project picked up a stray data/ directory.
 *
 * Two rules keep that from happening again:
 *  - the fallback is anchored to the install dir, never the cwd;
 *  - process.env is read on every call, so callers are not sensitive to
 *    whether loadDotEnv() has run yet (module-level consts import before
 *    mcp-server.ts gets to call it).
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { metaDir } from "./compat.js";

/** Repo/install root — one level up from src/. */
function installRoot(): string {
  return resolve(metaDir(import.meta), "..");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Absolute path to the sidecar data directory.
 *
 * Honors RECALLNEST_DATA_DIR (with `~` expansion); a relative value is
 * resolved against the install root rather than the cwd. Falls back to
 * `<install root>/data`.
 */
export function resolveDataDir(): string {
  const configured = process.env.RECALLNEST_DATA_DIR?.trim();
  if (!configured) return join(installRoot(), "data");

  const expanded = expandHome(configured);
  return isAbsolute(expanded) ? expanded : resolve(installRoot(), expanded);
}

/** Join path segments onto the resolved data directory. */
export function dataPath(...segments: string[]): string {
  return join(resolveDataDir(), ...segments);
}
