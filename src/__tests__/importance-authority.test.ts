import { describe, expect, it } from "bun:test";

import { resolveTier, isDecayExempt } from "../decay-engine.js";

/**
 * #9 — importance column authority.
 *
 * The store `importance` column is authoritative. `metadata.importance` is a
 * legacy denormalized mirror that may be stale (e.g. after a column-only pin or
 * access-tracker write). Tier resolution must trust the column when the caller
 * has it, instead of the possibly-stale metadata copy.
 */
describe("resolveTier — column importance is authoritative", () => {
  it("uses the passed column importance when metadata has no importance", () => {
    // metadata carries no tier and no importance; column says 0.9 → working.
    expect(resolveTier(JSON.stringify({}), 0.9)).toBe("working");
    expect(resolveTier(JSON.stringify({}), 0.96)).toBe("core");
    expect(resolveTier(JSON.stringify({}), 0.1)).toBe("peripheral");
  });

  it("prefers the column importance over a stale metadata.importance", () => {
    // metadata says 0.1 (stale, low), but the authoritative column says 0.96.
    expect(resolveTier(JSON.stringify({ importance: 0.1 }), 0.96)).toBe("core");
    // metadata says 0.95 (stale, high), but the column has decayed to 0.2.
    expect(resolveTier(JSON.stringify({ importance: 0.95 }), 0.2)).toBe("peripheral");
  });

  it("still honors an explicit stored tier regardless of importance", () => {
    expect(resolveTier(JSON.stringify({ tier: "working" }), 0.99)).toBe("working");
    expect(resolveTier(JSON.stringify({ tier: "core" }), 0.1)).toBe("core");
  });

  it("falls back to metadata.importance when no column importance is passed (legacy)", () => {
    expect(resolveTier(JSON.stringify({ importance: 0.85 }))).toBe("working");
    expect(resolveTier(JSON.stringify({ importance: 0.96 }))).toBe("core");
  });
});

describe("isDecayExempt — core exemption honors column importance", () => {
  it("exempts a high-importance entry whose metadata lacks tier/importance", () => {
    // Column importance 0.96 with no stored tier → core via authoritative value,
    // so Rule 1 (core + importance >= 0.95) must fire.
    expect(isDecayExempt(JSON.stringify({}), 0.96)).toBe(true);
  });

  it("does not exempt a low-importance entry with a stale high metadata copy", () => {
    // Stale metadata.importance 0.99 must not resurrect exemption when the
    // authoritative column is 0.2.
    expect(isDecayExempt(JSON.stringify({ importance: 0.99 }), 0.2)).toBe(false);
  });
});
