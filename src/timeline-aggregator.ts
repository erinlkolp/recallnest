import type { MemoryEntry } from "./store.js";
import type { SessionCheckpointRecord } from "./session-schema.js";
import type {
  Bucket,
  LaneId,
  TimelineItem,
  TimelineLane,
  TimelineOptions,
  TimelineResponse,
} from "./types/timeline.js";

const LANE_LABELS: Record<LaneId, string> = {
  checkpoints: "Checkpoints",
  events: "Events",
  memories: "Memories",
  "cases-patterns": "Cases & Patterns",
};

/** Maps a memory `category` to the lane it belongs on. */
const CATEGORY_TO_LANE: Record<string, LaneId> = {
  events: "events",
  profile: "memories",
  preferences: "memories",
  entities: "memories",
  cases: "cases-patterns",
  patterns: "cases-patterns",
};

function firstLine(text: string, max = 80): string {
  const line = (text ?? "").split("\n")[0]?.trim() ?? "";
  if (!line) return "(untitled)";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function safeParseMetadata(raw: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function buildTimeline(
  checkpoints: SessionCheckpointRecord[],
  entries: MemoryEntry[],
  opts: TimelineOptions,
): TimelineResponse {
  const requested = new Set<LaneId>(opts.lanes);
  const laneItems: Record<LaneId, TimelineItem[]> = {
    checkpoints: [],
    events: [],
    memories: [],
    "cases-patterns": [],
  };
  let skipped = 0;

  const inWindow = (ts: number): boolean => ts >= opts.fromMs && ts <= opts.toMs;

  if (requested.has("checkpoints")) {
    for (const cp of checkpoints) {
      const ts = Date.parse(cp.updatedAt);
      if (Number.isNaN(ts)) {
        skipped++;
        continue;
      }
      if (!inWindow(ts)) continue;
      laneItems.checkpoints.push({
        id: cp.checkpointId,
        ts,
        title: `Checkpoint · ${cp.sessionId}`,
        subtitle: cp.nextActions[0] ? `next: ${cp.nextActions[0]}` : cp.summary,
        scope: cp.resolvedScope ?? cp.scope ?? "",
        detail: {
          summary: cp.summary,
          decisions: cp.decisions,
          openLoops: cp.openLoops,
          nextActions: cp.nextActions,
        },
      });
    }
  }

  for (const e of entries) {
    const lane = CATEGORY_TO_LANE[e.category] ?? "memories";
    if (!requested.has(lane)) continue;
    const ts = Number(e.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) {
      skipped++;
      continue;
    }
    if (!inWindow(ts)) continue;
    laneItems[lane].push({
      id: e.id,
      ts,
      title: firstLine(e.text),
      scope: e.scope,
      category: e.category,
      detail: {
        text: e.text,
        importance: e.importance,
        metadata: safeParseMetadata(e.metadata),
      },
    });
  }

  for (const key of Object.keys(laneItems) as LaneId[]) {
    laneItems[key].sort((a, b) => a.ts - b.ts);
  }

  const lanes: TimelineLane[] = opts.lanes.map((id) => ({
    id,
    label: LANE_LABELS[id],
    items: laneItems[id],
  }));

  const window: { from: string; to: string; bucket: Bucket } = {
    from: new Date(opts.fromMs).toISOString(),
    to: new Date(opts.toMs).toISOString(),
    bucket: opts.bucket,
  };

  return { window, lanes, skipped };
}
