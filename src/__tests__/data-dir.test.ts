import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import { resolveDataDir, dataPath } from "../data-dir.js";
import { DEFAULT_ACTIVITY_CONFIG } from "../activity-counter.js";
import { DEFAULT_DISTILL_LOCK_CONFIG } from "../distill-lock.js";
import { DEFAULT_FREQUENCY_CONFIG } from "../frequency-tracker.js";

const INSTALL_DATA_DIR = resolve(import.meta.dir, "../..", "data");

describe("data-dir", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.RECALLNEST_DATA_DIR;
    delete process.env.RECALLNEST_DATA_DIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.RECALLNEST_DATA_DIR;
    else process.env.RECALLNEST_DATA_DIR = saved;
  });

  it("falls back to the install dir, not the process cwd", () => {
    expect(resolveDataDir()).toBe(INSTALL_DATA_DIR);
  });

  it("returns an absolute path even when RECALLNEST_DATA_DIR is unset", () => {
    expect(isAbsolute(resolveDataDir())).toBe(true);
  });

  it("honors RECALLNEST_DATA_DIR", () => {
    process.env.RECALLNEST_DATA_DIR = "/var/tmp/recallnest-data";
    expect(resolveDataDir()).toBe("/var/tmp/recallnest-data");
  });

  it("expands a leading ~ in RECALLNEST_DATA_DIR", () => {
    process.env.RECALLNEST_DATA_DIR = "~/.recallnest/data";
    expect(resolveDataDir()).toBe(join(homedir(), ".recallnest/data"));
  });

  it("resolves a relative RECALLNEST_DATA_DIR against the install dir", () => {
    process.env.RECALLNEST_DATA_DIR = "custom-data";
    expect(resolveDataDir()).toBe(resolve(import.meta.dir, "../..", "custom-data"));
  });

  it("ignores an empty or whitespace-only RECALLNEST_DATA_DIR", () => {
    process.env.RECALLNEST_DATA_DIR = "   ";
    expect(resolveDataDir()).toBe(INSTALL_DATA_DIR);
  });

  it("joins segments onto the resolved data dir", () => {
    process.env.RECALLNEST_DATA_DIR = "/var/tmp/recallnest-data";
    expect(dataPath("activity-stats.json")).toBe(
      "/var/tmp/recallnest-data/activity-stats.json",
    );
    expect(dataPath("retention", "scope.json")).toBe(
      "/var/tmp/recallnest-data/retention/scope.json",
    );
  });
});

describe("data-dir: late env binding (regression)", () => {
  // The original bug: these consts baked in a cwd-relative "data/" at module
  // import time, which runs before mcp-server.ts calls loadDotEnv(). A .env
  // value therefore had no effect and every repo got a stray data/ dir.
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.RECALLNEST_DATA_DIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.RECALLNEST_DATA_DIR;
    else process.env.RECALLNEST_DATA_DIR = saved;
  });

  it("picks up RECALLNEST_DATA_DIR set after the modules were imported", () => {
    process.env.RECALLNEST_DATA_DIR = "/var/tmp/late-bound";

    expect(DEFAULT_ACTIVITY_CONFIG.statsPath).toBe(
      "/var/tmp/late-bound/activity-stats.json",
    );
    expect(DEFAULT_DISTILL_LOCK_CONFIG.lockPath).toBe(
      "/var/tmp/late-bound/distill.lock",
    );
    expect(DEFAULT_FREQUENCY_CONFIG.filePath).toBe(
      "/var/tmp/late-bound/frequency-stats.json",
    );
  });

  it("survives object spread, which is how resolveConfig consumes the defaults", () => {
    process.env.RECALLNEST_DATA_DIR = "/var/tmp/spread-bound";

    expect({ ...DEFAULT_ACTIVITY_CONFIG }.statsPath).toBe(
      "/var/tmp/spread-bound/activity-stats.json",
    );
    expect({ ...DEFAULT_DISTILL_LOCK_CONFIG }.lockPath).toBe(
      "/var/tmp/spread-bound/distill.lock",
    );
    expect({ ...DEFAULT_FREQUENCY_CONFIG }.filePath).toBe(
      "/var/tmp/spread-bound/frequency-stats.json",
    );
  });

  it("never defaults to a cwd-relative path", () => {
    delete process.env.RECALLNEST_DATA_DIR;

    expect(isAbsolute(DEFAULT_ACTIVITY_CONFIG.statsPath)).toBe(true);
    expect(isAbsolute(DEFAULT_DISTILL_LOCK_CONFIG.lockPath)).toBe(true);
    expect(isAbsolute(DEFAULT_FREQUENCY_CONFIG.filePath)).toBe(true);
  });
});

describe("data-dir: no module resolves storage against the cwd", () => {
  // Guard for the whole bug class. The original fix missed frequency-tracker
  // and query-expander because the search was for RECALLNEST_DATA_DIR rather
  // than process.cwd(); this fails if a new one is introduced.
  const SRC = resolve(import.meta.dir, "..");
  const ALLOWED = new Set([
    // Resolves dbPath relative to the config file's location, falling back to
    // cwd only for an explicitly-passed config path. Not storage-on-disk.
    "doctor.ts",
    // Documents the bug in a comment.
    "data-dir.ts",
  ]);

  it("has no cwd-relative storage paths left in src/", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const offenders: string[] = [];

    for (const entry of readdirSync(SRC, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (ALLOWED.has(entry.name)) continue;
      const body = readFileSync(join(SRC, entry.name), "utf-8");
      if (body.includes("process.cwd()")) offenders.push(entry.name);
    }

    expect(offenders).toEqual([]);
  });
});
