import { describe, expect, it } from "bun:test";
import { buildTimeline } from "../timeline-aggregator.js";
import type { MemoryEntry } from "../store.js";
import type { SessionCheckpointRecord } from "../session-schema.js";
import type { TimelineOptions } from "../types/timeline.js";

const T = (iso: string) => Date.parse(iso);

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "e1",
    text: "hello world",
    vector: [],
    category: "events",
    scope: "project:x",
    importance: 1,
    timestamp: T("2026-07-20T12:00:00.000Z"),
    metadata: "{}",
    ...over,
  };
}

function checkpoint(over: Partial<SessionCheckpointRecord>): SessionCheckpointRecord {
  return {
    checkpointId: "c1",
    sessionId: "s1",
    scope: "project:x",
    summary: "did stuff",
    decisions: ["decided A"],
    openLoops: ["loop B"],
    nextActions: ["do C"],
    updatedAt: "2026-07-21T09:00:00.000Z",
    ...over,
  } as SessionCheckpointRecord;
}

const OPTS: TimelineOptions = {
  fromMs: T("2026-07-01T00:00:00.000Z"),
  toMs: T("2026-07-31T00:00:00.000Z"),
  bucket: "day",
  lanes: ["checkpoints", "events", "memories"],
};

describe("buildTimeline", () => {
  it("routes categories to the correct lanes", () => {
    const res = buildTimeline(
      [],
      [
        entry({ id: "ev", category: "events" }),
        entry({ id: "pr", category: "profile" }),
        entry({ id: "pf", category: "preferences" }),
        entry({ id: "en", category: "entities" }),
      ],
      OPTS,
    );
    const byId = (lane: string) =>
      res.lanes.find((l) => l.id === lane)!.items.map((i) => i.id);
    expect(byId("events")).toEqual(["ev"]);
    expect(byId("memories").sort()).toEqual(["en", "pf", "pr"]);
  });

  it("places checkpoints on the checkpoints lane with ISO->ms conversion and inlined detail", () => {
    const res = buildTimeline([checkpoint({})], [], OPTS);
    const lane = res.lanes.find((l) => l.id === "checkpoints")!;
    expect(lane.items).toHaveLength(1);
    expect(lane.items[0].ts).toBe(T("2026-07-21T09:00:00.000Z"));
    expect(lane.items[0].subtitle).toBe("next: do C");
    expect(lane.items[0].detail).toEqual({
      summary: "did stuff",
      decisions: ["decided A"],
      openLoops: ["loop B"],
      nextActions: ["do C"],
    });
  });

  it("excludes cases/patterns unless the lane is requested", () => {
    const items = [entry({ id: "ca", category: "cases" }), entry({ id: "pa", category: "patterns" })];
    const without = buildTimeline([], items, OPTS);
    expect(without.lanes.some((l) => l.id === "cases-patterns")).toBe(false);

    const withLane = buildTimeline([], items, { ...OPTS, lanes: [...OPTS.lanes, "cases-patterns"] });
    const lane = withLane.lanes.find((l) => l.id === "cases-patterns")!;
    expect(lane.items.map((i) => i.id).sort()).toEqual(["ca", "pa"]);
  });

  it("drops items outside the window", () => {
    const res = buildTimeline(
      [],
      [
        entry({ id: "in", timestamp: T("2026-07-15T00:00:00.000Z") }),
        entry({ id: "before", timestamp: T("2026-06-01T00:00:00.000Z") }),
        entry({ id: "after", timestamp: T("2026-09-01T00:00:00.000Z") }),
      ],
      OPTS,
    );
    const events = res.lanes.find((l) => l.id === "events")!;
    expect(events.items.map((i) => i.id)).toEqual(["in"]);
  });

  it("counts items with an unparseable timestamp in `skipped` instead of throwing", () => {
    const res = buildTimeline(
      [checkpoint({ updatedAt: "not-a-date" })],
      [entry({ id: "bad", timestamp: NaN }), entry({ id: "ok" })],
      OPTS,
    );
    expect(res.skipped).toBe(2);
    expect(res.lanes.find((l) => l.id === "events")!.items.map((i) => i.id)).toEqual(["ok"]);
  });

  it("sorts each lane ascending by ts", () => {
    const res = buildTimeline(
      [],
      [
        entry({ id: "late", timestamp: T("2026-07-25T00:00:00.000Z") }),
        entry({ id: "early", timestamp: T("2026-07-05T00:00:00.000Z") }),
      ],
      OPTS,
    );
    expect(res.lanes.find((l) => l.id === "events")!.items.map((i) => i.id)).toEqual(["early", "late"]);
  });

  it("returns lanes in the requested order and echoes the window", () => {
    const res = buildTimeline([], [], OPTS);
    expect(res.lanes.map((l) => l.id)).toEqual(["checkpoints", "events", "memories"]);
    expect(res.window).toEqual({
      from: new Date(OPTS.fromMs).toISOString(),
      to: new Date(OPTS.toMs).toISOString(),
      bucket: "day",
    });
  });

  it("handles empty input", () => {
    const res = buildTimeline([], [], OPTS);
    expect(res.skipped).toBe(0);
    expect(res.lanes.every((l) => l.items.length === 0)).toBe(true);
  });
});
