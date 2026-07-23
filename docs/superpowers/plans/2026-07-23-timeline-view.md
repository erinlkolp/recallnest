# Timeline View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a horizontal, swimlane-based Timeline view to the RecallNest workbench UI that plots checkpoints, events, and durable memories over time.

**Architecture:** A pure aggregation module (`timeline-aggregator.ts`) turns existing checkpoint records + memory entries into a lane/item structure. One read-only endpoint (`GET /api/timeline`) fetches from the existing stores and delegates to the aggregator. A vanilla-JS view in `app.js` renders lanes as CSS-positioned dots along a time axis, with click-to-detail and window/lane controls. No new dependencies, no new storage.

**Tech Stack:** Bun, TypeScript (strict), `bun:test`. Frontend is framework-free vanilla JS/CSS (matching existing `assets/ui/app.js`).

**Spec:** `docs/superpowers/specs/2026-07-23-timeline-view-design.md`

**Baseline:** 1553 tests / 0 fail. This plan only adds tests; the baseline must not drop. Run `bun test` green before every commit.

**Reference — verified data shapes (do not re-derive):**
- `MemoryEntry` (exported from `src/store.ts`): `{ id: string; text: string; vector: number[]; category: string; scope: string; importance: number; timestamp: number /* epoch ms */; metadata: string /* JSON */ }`. Returned by `store.list(scopeFilter?: string[], category?, limit, offset, order)`.
- `SessionCheckpointRecord` (exported from `src/session-schema.ts`, `z.infer`): includes `checkpointId: string`, `sessionId: string`, `scope?: string`, `resolvedScope?: string`, `summary: string`, `decisions: string[]`, `openLoops: string[]`, `nextActions: string[]`, `updatedAt: string /* ISO */`. Enumerated by `checkpointStore.listRecent({ scope?, sessionId?, limit? })`.
- `SessionCheckpointStore` (from `src/session-store.ts`) is constructed with no args: `new SessionCheckpointStore()`.
- In `ui-server.ts`, `getComponents()` returns `{ retriever, profile, store, embedder }`.
- Test import style: `import { describe, expect, it } from "bun:test";` and local imports use the `.js` extension (e.g. `../store.js`).

---

## Task 1: Timeline types

**Files:**
- Create: `src/types/timeline.ts`

- [ ] **Step 1: Create the types file**

```ts
// src/types/timeline.ts

/** The four lanes a timeline can display. */
export type LaneId = "checkpoints" | "events" | "memories" | "cases-patterns";

/** Zoom granularity hint echoed back to the UI for axis ticks. */
export type Bucket = "day" | "week" | "month";

/** A single plotted item on a lane. */
export interface TimelineItem {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  title: string;
  subtitle?: string;
  scope: string;
  /** Present for memory-derived items (the source category). */
  category?: string;
  /** Inlined detail shown in the side panel on click. */
  detail: Record<string, unknown>;
}

export interface TimelineLane {
  id: LaneId;
  label: string;
  items: TimelineItem[];
}

export interface TimelineWindow {
  /** ISO datetime. */
  from: string;
  /** ISO datetime. */
  to: string;
  bucket: Bucket;
}

export interface TimelineResponse {
  window: TimelineWindow;
  lanes: TimelineLane[];
  /** Items dropped for an unparseable/missing timestamp (never silently lost). */
  skipped: number;
}

/** Already-validated options passed to the pure aggregator. */
export interface TimelineOptions {
  fromMs: number;
  toMs: number;
  bucket: Bucket;
  lanes: LaneId[];
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: no errors (exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/types/timeline.ts
git commit -m "feat(timeline): add timeline view types"
```

---

## Task 2: Pure aggregator

**Files:**
- Create: `src/timeline-aggregator.ts`
- Test: `src/__tests__/timeline-aggregator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/timeline-aggregator.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/timeline-aggregator.test.ts`
Expected: FAIL — `Cannot find module "../timeline-aggregator.js"` / `buildTimeline is not a function`.

- [ ] **Step 3: Write the aggregator**

```ts
// src/timeline-aggregator.ts
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

function safeParseMetadata(raw: string): Record<string, unknown> {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/timeline-aggregator.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/timeline-aggregator.ts src/__tests__/timeline-aggregator.test.ts
git commit -m "feat(timeline): pure timeline aggregator with tests"
```

---

## Task 3: `GET /api/timeline` endpoint

**Files:**
- Modify: `src/ui-server.ts` (add import, module-level checkpoint store, exported handler, route)
- Test: `src/__tests__/ui-server-timeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-server-timeline.test.ts
import { describe, expect, it } from "bun:test";
import { handleTimelineRequest } from "../ui-server.js";
import type { MemoryEntry } from "../store.js";
import type { SessionCheckpointRecord } from "../session-schema.js";

const T = (iso: string) => Date.parse(iso);

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "e1", text: "note", vector: [], category: "events",
    scope: "project:x", importance: 1,
    timestamp: T("2026-07-20T12:00:00.000Z"), metadata: "{}", ...over,
  };
}

const storeStub = (entries: MemoryEntry[]) => ({
  refresh: async () => {},
  list: async () => entries,
});

const checkpointStub = (records: SessionCheckpointRecord[]) => ({
  listRecent: async () => records,
});

describe("handleTimelineRequest", () => {
  it("returns 200 with the timeline shape", async () => {
    const url = new URL("http://x/api/timeline?from=2026-07-01&to=2026-07-31");
    const res = await handleTimelineRequest(
      url,
      storeStub([entry({ id: "ev" })]) as any,
      checkpointStub([]) as any,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window.bucket).toBe("day");
    expect(body.lanes.map((l: any) => l.id)).toEqual(["checkpoints", "events", "memories"]);
    expect(body.lanes.find((l: any) => l.id === "events").items[0].id).toBe("ev");
  });

  it("rejects an unknown bucket with 400", async () => {
    const url = new URL("http://x/api/timeline?bucket=decade");
    const res = await handleTimelineRequest(url, storeStub([]) as any, checkpointStub([]) as any);
    expect(res.status).toBe(400);
  });

  it("rejects from>to with 400", async () => {
    const url = new URL("http://x/api/timeline?from=2026-07-31&to=2026-07-01");
    const res = await handleTimelineRequest(url, storeStub([]) as any, checkpointStub([]) as any);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown lane id with 400", async () => {
    const url = new URL("http://x/api/timeline?lanes=events,bogus");
    const res = await handleTimelineRequest(url, storeStub([]) as any, checkpointStub([]) as any);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/ui-server-timeline.test.ts`
Expected: FAIL — `handleTimelineRequest` is not exported from `../ui-server.js`.

- [ ] **Step 3: Add the import and module-level checkpoint store**

In `src/ui-server.ts`, add to the imports near the top (alongside the existing `createComponentResolver` import from `./runtime-config.js`):

```ts
import { SessionCheckpointStore } from "./session-store.js";
import { buildTimeline } from "./timeline-aggregator.js";
import type { LaneId, Bucket } from "./types/timeline.js";
import type { MemoryStore } from "./store.js";
```

Immediately after the existing `const getComponents = createComponentResolver(config);` line, add:

```ts
const checkpointStore = new SessionCheckpointStore();
```

- [ ] **Step 4: Add the exported handler**

Add this function to `src/ui-server.ts` above the `const server = Bun.serve({` line (module scope):

```ts
const ALL_LANES: LaneId[] = ["checkpoints", "events", "memories", "cases-patterns"];
const DEFAULT_LANES: LaneId[] = ["checkpoints", "events", "memories"];
const BUCKETS: Bucket[] = ["day", "week", "month"];
const DAY_MS = 24 * 60 * 60 * 1000;

function timelineBadRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export async function handleTimelineRequest(
  url: URL,
  store: Pick<MemoryStore, "list" | "refresh">,
  checkpoints: Pick<SessionCheckpointStore, "listRecent">,
): Promise<Response> {
  const params = url.searchParams;
  const scope = params.get("scope") ?? undefined;

  const bucketRaw = params.get("bucket") ?? "day";
  if (!BUCKETS.includes(bucketRaw as Bucket)) {
    return timelineBadRequest(`invalid bucket: ${bucketRaw}`);
  }
  const bucket = bucketRaw as Bucket;

  const toMs = params.has("to") ? Date.parse(params.get("to") as string) : Date.now();
  if (Number.isNaN(toMs)) return timelineBadRequest("invalid 'to' date");
  const fromMs = params.has("from") ? Date.parse(params.get("from") as string) : toMs - 30 * DAY_MS;
  if (Number.isNaN(fromMs)) return timelineBadRequest("invalid 'from' date");
  if (fromMs > toMs) return timelineBadRequest("'from' must be <= 'to'");

  let lanes = DEFAULT_LANES;
  const lanesRaw = params.get("lanes");
  if (lanesRaw) {
    const parsed = lanesRaw.split(",").map((s) => s.trim()).filter(Boolean) as LaneId[];
    const unknown = parsed.filter((l) => !ALL_LANES.includes(l));
    if (unknown.length > 0) return timelineBadRequest(`unknown lane(s): ${unknown.join(", ")}`);
    lanes = parsed;
  }

  await store.refresh();
  const checkpointRecords = lanes.includes("checkpoints")
    ? await checkpoints.listRecent({ scope, limit: 100 })
    : [];
  const entries = await store.list(scope ? [scope] : undefined, undefined, 10000, 0);

  return Response.json(buildTimeline(checkpointRecords, entries, { fromMs, toMs, bucket, lanes }));
}
```

- [ ] **Step 5: Wire the route into `Bun.serve`**

Inside the `fetch` handler in `src/ui-server.ts`, add this route immediately before the final `return new Response("Not Found", { status: 404 });`:

```ts
      if (request.method === "GET" && url.pathname === "/api/timeline") {
        const { store } = getComponents();
        return await handleTimelineRequest(url, store, checkpointStore);
      }
```

- [ ] **Step 6: Guard the server bootstrap so importing the module doesn't start a server**

The test imports `../ui-server.js`, which currently runs `Bun.serve({...})` and `console.log(...)` at module top level — importing it would bind a port and leak a running server during tests. Wrap only the bootstrap (the `const server = Bun.serve({ ... });` block and the trailing `console.log(\`RecallNest UI running at ...\`)`) in an `import.meta.main` guard. Module-level declarations (`getComponents`, `checkpointStore`, `handleTimelineRequest`, helpers) stay **outside** the guard so they remain importable.

```ts
if (import.meta.main) {
  const server = Bun.serve({
    // ...the entire existing Bun.serve config, unchanged...
  });
  console.log(`RecallNest UI running at http://localhost:${server.port}`);
}
```

Verify the `fetch` handler body (including the new `/api/timeline` route from Step 5) is preserved verbatim inside the moved `Bun.serve` config.

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test src/__tests__/ui-server-timeline.test.ts`
Expected: PASS (4 tests). The suite should exit cleanly with no lingering server / open port.

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/ui-server.ts src/__tests__/ui-server-timeline.test.ts
git commit -m "feat(timeline): add GET /api/timeline endpoint with tests"
```

---

## Task 4: Frontend Timeline view

No automated test harness exists for `assets/ui/*` (the workbench is served static and driven manually). Coverage for logic lives in Tasks 2–3; this task is verified by running the UI and inspecting the browser. Keep all code framework-free to match `app.js`.

**Files:**
- Modify: `assets/ui/index.html`
- Modify: `assets/ui/styles.css`
- Modify: `assets/ui/app.js`

- [ ] **Step 1: Add the Timeline tab and view section (index.html)**

In `assets/ui/index.html`, add a tab button inside `#viewSwitch`, immediately after the Exports tab (`<button class="view-tab" data-view="exports">Exports</button>`):

```html
            <button class="view-tab" data-view="timeline">Timeline</button>
```

Then add this new section immediately after the closing `</section>` of `#dashboardView`:

```html
        <section class="timeline-view card is-hidden" id="timelineView">
          <div class="dashboard-header">
            <h2>Memory Timeline</h2>
            <div class="timeline-controls">
              <button class="ghost-button" data-timeline-window="7">7d</button>
              <button class="ghost-button is-active" data-timeline-window="30">30d</button>
              <button class="ghost-button" data-timeline-window="90">90d</button>
            </div>
          </div>
          <div class="timeline-lane-toggles" id="timelineLaneToggles">
            <label><input type="checkbox" value="checkpoints" checked> Checkpoints</label>
            <label><input type="checkbox" value="events" checked> Events</label>
            <label><input type="checkbox" value="memories" checked> Memories</label>
            <label><input type="checkbox" value="cases-patterns"> Cases &amp; Patterns</label>
          </div>
          <div class="timeline-axis" id="timelineAxis"></div>
          <div class="timeline-lanes" id="timelineLanes">Loading timeline…</div>
          <aside class="timeline-detail is-hidden" id="timelineDetail"></aside>
        </section>
```

- [ ] **Step 2: Add styles (styles.css)**

Append to `assets/ui/styles.css`:

```css
.timeline-controls { display: flex; gap: 6px; }
.timeline-lane-toggles { display: flex; gap: 16px; margin: 8px 0 12px; font-size: 13px; }
.timeline-lane-toggles label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.timeline-axis {
  display: flex; justify-content: space-between;
  font-size: 11px; color: var(--muted, #888);
  border-bottom: 1px solid var(--border, #444); padding-bottom: 4px; margin-bottom: 8px;
}
.timeline-lane { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.timeline-lane-label {
  width: 96px; flex-shrink: 0; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--muted, #888);
}
.timeline-track {
  position: relative; flex: 1; height: 22px;
  background: var(--track, #2a2a2a); border-radius: 11px;
}
.timeline-dot {
  position: absolute; top: 3px; width: 16px; height: 16px; margin-left: -8px;
  border-radius: 50%; cursor: pointer; border: 2px solid rgba(0,0,0,0.35);
}
.timeline-dot:hover { transform: scale(1.25); }
.timeline-dot.lane-checkpoints { background: #4c8dff; }
.timeline-dot.lane-events { background: #ff9f43; }
.timeline-dot.lane-memories { background: #33c27f; }
.timeline-dot.lane-cases-patterns { background: #c0c0c0; }
.timeline-detail {
  margin-top: 14px; padding: 12px; border-radius: 8px;
  background: var(--track, #2a2a2a); font-size: 13px;
}
.timeline-detail h4 { margin: 0 0 6px; }
.timeline-empty { color: var(--muted, #888); padding: 16px 0; }
```

- [ ] **Step 3: Add DOM refs and view wiring (app.js)**

Near the top of `assets/ui/app.js` where other elements are captured (around the `viewTabs` declaration on line 25), add:

```js
const timelineView = document.getElementById('timelineView');
const timelineLanesEl = document.getElementById('timelineLanes');
const timelineAxisEl = document.getElementById('timelineAxis');
const timelineDetailEl = document.getElementById('timelineDetail');
const timelineLaneToggles = document.getElementById('timelineLaneToggles');
let timelineWindowDays = 30;
```

In `setActiveView(view)`, replace the block that toggles the section visibility (currently lines ~174–178) with:

```js
  const showDashboard = view === 'dashboard';
  const showTimeline = view === 'timeline';
  const showSearchSurface = !showDashboard && !showTimeline;
  if (dashboardView) dashboardView.classList.toggle('is-hidden', !showDashboard);
  if (timelineView) timelineView.classList.toggle('is-hidden', !showTimeline);
  if (searchView) searchView.classList.toggle('is-hidden', !showSearchSurface);
  if (resultView) resultView.classList.toggle('is-hidden', !showSearchSurface);
  if (sideView) sideView.classList.toggle('is-hidden', !showSearchSurface);
```

- [ ] **Step 4: Add the loader/renderer (app.js)**

Add these functions to `assets/ui/app.js` (near the other `load*` functions such as `loadExports`):

```js
const TIMELINE_LANE_LABELS = {
  checkpoints: 'Checkpoints',
  events: 'Events',
  memories: 'Memories',
  'cases-patterns': 'Cases & Patterns',
};

function selectedTimelineLanes() {
  if (!timelineLaneToggles) return ['checkpoints', 'events', 'memories'];
  return Array.from(timelineLaneToggles.querySelectorAll('input:checked')).map((i) => i.value);
}

async function loadTimeline() {
  if (!timelineLanesEl) return;
  timelineLanesEl.textContent = 'Loading timeline…';
  if (timelineDetailEl) timelineDetailEl.classList.add('is-hidden');
  const to = new Date();
  const from = new Date(to.getTime() - timelineWindowDays * 24 * 60 * 60 * 1000);
  const lanes = selectedTimelineLanes();
  const qs = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    bucket: timelineWindowDays > 45 ? 'week' : 'day',
    lanes: lanes.join(','),
  });
  try {
    const res = await fetch(`/api/timeline?${qs.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderTimeline(await res.json());
  } catch (err) {
    timelineLanesEl.innerHTML = `<div class="timeline-empty">Failed to load timeline: ${err.message}</div>`;
  }
}

function renderTimeline(data) {
  const fromMs = Date.parse(data.window.from);
  const toMs = Date.parse(data.window.to);
  const span = Math.max(1, toMs - fromMs);

  timelineAxisEl.innerHTML = '';
  for (let i = 0; i <= 4; i++) {
    const d = new Date(fromMs + (span * i) / 4);
    const tick = document.createElement('span');
    tick.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    timelineAxisEl.appendChild(tick);
  }

  const total = data.lanes.reduce((n, lane) => n + lane.items.length, 0);
  if (total === 0) {
    timelineLanesEl.innerHTML =
      '<div class="timeline-empty">No memories in this range — widen the window.</div>';
    return;
  }

  timelineLanesEl.innerHTML = '';
  for (const lane of data.lanes) {
    const row = document.createElement('div');
    row.className = 'timeline-lane';
    const label = document.createElement('div');
    label.className = 'timeline-lane-label';
    label.textContent = TIMELINE_LANE_LABELS[lane.id] || lane.label;
    const track = document.createElement('div');
    track.className = 'timeline-track';
    for (const item of lane.items) {
      const dot = document.createElement('button');
      dot.className = `timeline-dot lane-${lane.id}`;
      dot.style.left = `${((item.ts - fromMs) / span) * 100}%`;
      dot.title = item.title;
      dot.addEventListener('click', () => showTimelineDetail(lane, item));
      track.appendChild(dot);
    }
    row.appendChild(label);
    row.appendChild(track);
    timelineLanesEl.appendChild(row);
  }

  if (data.skipped > 0) {
    const note = document.createElement('div');
    note.className = 'timeline-empty';
    note.textContent = `${data.skipped} item(s) skipped (missing/invalid timestamp).`;
    timelineLanesEl.appendChild(note);
  }
}

function showTimelineDetail(lane, item) {
  if (!timelineDetailEl) return;
  const when = new Date(item.ts).toLocaleString();
  const rows = Object.entries(item.detail)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `<div><strong>${k}:</strong> ${Array.isArray(v) ? v.join('; ') : (typeof v === 'object' ? JSON.stringify(v) : v)}</div>`)
    .join('');
  timelineDetailEl.innerHTML =
    `<h4>${item.title}</h4>` +
    `<div class="timeline-empty">${TIMELINE_LANE_LABELS[lane.id] || lane.label} · ${when} · ${item.scope || 'no scope'}</div>` +
    rows;
  timelineDetailEl.classList.remove('is-hidden');
}
```

- [ ] **Step 5: Wire the tab click and control buttons (app.js)**

In the `viewTabs.forEach((tab) => { tab.addEventListener('click', ...` handler (around line 885), add a branch alongside the existing `if (view === 'pins')` branches:

```js
    if (view === 'timeline') {
      await loadTimeline();
    }
```

At the bottom of `app.js` (near other top-level `addEventListener` wiring), add:

```js
document.querySelectorAll('[data-timeline-window]').forEach((btn) => {
  btn.addEventListener('click', () => {
    timelineWindowDays = Number(btn.dataset.timelineWindow);
    document.querySelectorAll('[data-timeline-window]').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
    });
    loadTimeline();
  });
});
if (timelineLaneToggles) {
  timelineLaneToggles.addEventListener('change', () => loadTimeline());
}
```

- [ ] **Step 6: Manual verification**

Run: `bun run ui`
Then open the printed `http://localhost:<port>` URL and:
1. Click the **Timeline** tab → lanes render with dots along the axis.
2. Click a dot → the detail panel shows the item's title, timestamp, scope, and detail fields.
3. Toggle **Cases & Patterns** on → a fourth lane appears after reload.
4. Switch **7d / 30d / 90d** → the axis and dot positions update.
5. Pick a narrow window with no data → the empty-state message appears.

Confirm each behaves as described. Stop the server (Ctrl-C) when done.

- [ ] **Step 7: Typecheck (app.js is not typechecked, but confirm nothing else broke)**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add assets/ui/index.html assets/ui/styles.css assets/ui/app.js
git commit -m "feat(timeline): add Timeline view to workbench UI"
```

---

## Task 5: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS — at least `1553 + 12` tests (8 aggregator + 4 handler), 0 fail. If anything fails, fix it before proceeding (do not lower the baseline).

- [ ] **Step 2: Run the typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Update the baseline note in CLAUDE.md**

In `CLAUDE.md`, update the "Current baseline" line under **6. Test Baseline** to the new green count reported by `bun test` in Step 1.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "chore(timeline): bump test baseline after timeline view"
```

---

## Self-review notes (author checklist — verify during execution)

- **Spec coverage:** §3 lanes → Task 2 `CATEGORY_TO_LANE`; §4 endpoint/params → Task 3 handler; §5 boundaries → Tasks 1–4 (types / aggregator / thin handler / renderer); §6 testability refactor → Task 3 exported `handleTimelineRequest`; §7 error handling → Task 3 (400s) + Task 2 (`skipped`) + Task 4 empty-state; §8 tests → Tasks 2–3; §9 risks handled: checkpoint `limit: 100` bounds the checkpoint lane, and the aggregator skips (not throws) on bad timestamps.
- **Type consistency:** `LaneId`, `Bucket`, `TimelineOptions`, `buildTimeline`, `handleTimelineRequest`, `CATEGORY_TO_LANE` names are identical across tasks. Lane CSS classes (`lane-checkpoints|events|memories|cases-patterns`) match `LaneId` values.
- **§9 residual risk (document, don't block):** `listRecent({ scope, limit: 100 })` enumerates checkpoints across sessions within a scope via file scan; if a future scope holds >100 checkpoints the lane is capped at the 100 newest — acceptable for v1 and bounded, not silent (dots simply stop at the cap). The spec's fallback to `storedAt` parsing is unnecessary because `store.list` already returns a numeric `timestamp`; a malformed one is counted in `skipped`.
