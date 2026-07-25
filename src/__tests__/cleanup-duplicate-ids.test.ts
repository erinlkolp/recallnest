/**
 * Tests for scripts/cleanup-duplicate-ids.ts planning logic.
 *
 * Validates that:
 * 1. Unique ids are never touched
 * 2. Same-id groups keep the NEWEST row by default (the correction), which is
 *    the opposite of the text-dedup in cleanup-step1-exact-dups.ts
 * 3. --keep=oldest / --keep=access select the intended row
 * 4. Ties fall through to accessCount then to the longer (less truncated) text
 * 5. Keeper selection is stable across reruns on unchanged data
 * 6. normalizeRow fills every column the table re-add requires
 */
import { describe, expect, it } from "bun:test";
import {
  normalizeRow,
  orderGroup,
  planDedup,
  type MemoryRow,
  type RawMemoryRow,
} from "../../scripts/cleanup-duplicate-ids.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(id: string, overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id,
    text: `text for ${id}`,
    vector: [0.1, 0.2],
    category: "cases",
    scope: "project:recallnest",
    importance: 0.7,
    timestamp: 1_000,
    metadata: "{}",
    language: "en",
    fts_text: `text for ${id}`,
    ...overrides,
  };
}

function withAccessCount(count: number): string {
  return JSON.stringify({ accessCount: count });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("planDedup", () => {
  it("returns nothing when every id is unique", () => {
    const rows = [makeRow("a"), makeRow("b"), makeRow("c")];
    expect(planDedup(rows, "newest")).toEqual([]);
  });

  it("keeps the newest row by default so a correction is not reverted", () => {
    const stale = makeRow("dup", { timestamp: 100, text: "dials use comma encoding" });
    const corrected = makeRow("dup", { timestamp: 200, text: "dials must be semicolon-separated" });

    const groups = planDedup([stale, corrected], "newest");

    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("dup");
    expect(groups[0]!.keeper.text).toBe("dials must be semicolon-separated");
    expect(groups[0]!.discarded.map((r) => r.text)).toEqual(["dials use comma encoding"]);
  });

  it("keeps the oldest row under --keep=oldest", () => {
    const older = makeRow("dup", { timestamp: 100 });
    const newer = makeRow("dup", { timestamp: 200 });

    const groups = planDedup([newer, older], "oldest");

    expect(groups[0]!.keeper.timestamp).toBe(100);
    expect(groups[0]!.discarded).toHaveLength(1);
  });

  it("keeps the most-accessed row under --keep=access, ignoring recency", () => {
    const popularButOld = makeRow("dup", { timestamp: 100, metadata: withAccessCount(9) });
    const freshButUnused = makeRow("dup", { timestamp: 900, metadata: withAccessCount(0) });

    const groups = planDedup([freshButUnused, popularButOld], "access");

    expect(groups[0]!.keeper.timestamp).toBe(100);
  });

  it("collapses a group of more than two rows down to one keeper", () => {
    const rows = [
      makeRow("dup", { timestamp: 100 }),
      makeRow("dup", { timestamp: 300 }),
      makeRow("dup", { timestamp: 200 }),
    ];

    const groups = planDedup(rows, "newest");

    expect(groups[0]!.keeper.timestamp).toBe(300);
    expect(groups[0]!.discarded).toHaveLength(2);
  });

  it("separates duplicate ids from unique ones in a mixed table", () => {
    const rows = [
      makeRow("unique-1"),
      makeRow("dup-a", { timestamp: 100 }),
      makeRow("dup-a", { timestamp: 200 }),
      makeRow("unique-2"),
      makeRow("dup-b", { timestamp: 100 }),
      makeRow("dup-b", { timestamp: 200 }),
      makeRow("dup-b", { timestamp: 300 }),
    ];

    const groups = planDedup(rows, "newest");
    const excess = groups.reduce((sum, g) => sum + g.discarded.length, 0);

    expect(groups).toHaveLength(2);
    expect(excess).toBe(3);
    // Largest group first, so the preview surfaces the worst offender.
    expect(groups[0]!.id).toBe("dup-b");
  });
});

describe("orderGroup tie-breaking", () => {
  it("prefers the more-accessed row when timestamps are equal", () => {
    const rows = [
      makeRow("dup", { timestamp: 500, metadata: withAccessCount(1), text: "quiet" }),
      makeRow("dup", { timestamp: 500, metadata: withAccessCount(7), text: "busy" }),
    ];

    expect(orderGroup(rows, "newest")[0]!.text).toBe("busy");
  });

  it("prefers the longer text when timestamp and accessCount are equal", () => {
    const rows = [
      makeRow("dup", { timestamp: 500, text: "truncated" }),
      makeRow("dup", { timestamp: 500, text: "the complete untruncated body" }),
    ];

    expect(orderGroup(rows, "newest")[0]!.text).toBe("the complete untruncated body");
  });

  it("tolerates unparseable metadata instead of throwing", () => {
    const rows = [
      makeRow("dup", { timestamp: 500, metadata: "not json", text: "a" }),
      makeRow("dup", { timestamp: 500, metadata: withAccessCount(3), text: "b" }),
    ];

    expect(() => orderGroup(rows, "newest")).not.toThrow();
    expect(orderGroup(rows, "newest")[0]!.text).toBe("b");
  });

  it("picks the same keeper on a rerun over unchanged data", () => {
    const rows = [
      makeRow("dup", { timestamp: 500, text: "alpha" }),
      makeRow("dup", { timestamp: 500, text: "gamma" }),
      makeRow("dup", { timestamp: 500, text: "beta" }),
    ];

    const first = planDedup(rows, "newest")[0]!.keeper.text;
    const second = planDedup([...rows].reverse(), "newest")[0]!.keeper.text;

    expect(second).toBe(first);
  });
});

describe("normalizeRow", () => {
  it("materializes the vector and fills defaults for the re-add", () => {
    const raw: RawMemoryRow = {
      id: "row-1",
      text: "hello",
      vector: new Float32Array([0.5, 0.25]),
      category: "cases",
      scope: "project:recallnest",
      importance: 0.7,
      timestamp: 1_700_000_000_000,
      // metadata, language, fts_text intentionally absent
    };

    const row = normalizeRow(raw);

    expect(Array.isArray(row.vector)).toBe(true);
    expect(row.vector).toEqual([0.5, 0.25]);
    expect(row.metadata).toBe("{}");
    expect(row.language).toBe("en");
    // fts_text must fall back to text, or full-text search loses the row.
    expect(row.fts_text).toBe("hello");
  });

  it("widens bigint importance and timestamp to numbers", () => {
    const raw: RawMemoryRow = {
      id: "row-2",
      text: "hello",
      vector: [0.1],
      category: "cases",
      scope: "project:recallnest",
      importance: 1n as unknown as bigint,
      timestamp: 1_700_000_000_000n as unknown as bigint,
    };

    const row = normalizeRow(raw);

    expect(typeof row.importance).toBe("number");
    expect(typeof row.timestamp).toBe("number");
    expect(row.timestamp).toBe(1_700_000_000_000);
  });
});
