import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import { resolveDataDir, dataPath } from "../data-dir.js";
import { DEFAULT_ACTIVITY_CONFIG } from "../activity-counter.js";
import { DEFAULT_DISTILL_LOCK_CONFIG } from "../distill-lock.js";

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
  });

  it("survives object spread, which is how resolveConfig consumes the defaults", () => {
    process.env.RECALLNEST_DATA_DIR = "/var/tmp/spread-bound";

    expect({ ...DEFAULT_ACTIVITY_CONFIG }.statsPath).toBe(
      "/var/tmp/spread-bound/activity-stats.json",
    );
    expect({ ...DEFAULT_DISTILL_LOCK_CONFIG }.lockPath).toBe(
      "/var/tmp/spread-bound/distill.lock",
    );
  });

  it("never defaults to a cwd-relative path", () => {
    delete process.env.RECALLNEST_DATA_DIR;

    expect(isAbsolute(DEFAULT_ACTIVITY_CONFIG.statsPath)).toBe(true);
    expect(isAbsolute(DEFAULT_DISTILL_LOCK_CONFIG.lockPath)).toBe(true);
  });
});
