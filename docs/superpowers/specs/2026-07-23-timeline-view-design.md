# Timeline View — Design Spec

**Date:** 2026-07-23
**Status:** Approved (pending spec review → implementation plan)
**Feature:** A horizontal, swimlane-based timeline view in the RecallNest workbench UI that
plots checkpoints, events, and durable memories over time to serve continuity recovery,
audit, and narrative exploration from a single surface.

## 1. Motivation

RecallNest is the shared memory layer for Claude Code / Codex / Gemini, exposed over MCP + HTTP.
The existing browser workbench (`ui-server.ts` + `assets/ui/`) is powerful but developer-facing:
search returns a ranked list, which answers "find X" but not "when did things happen and where
did we stop." A timeline makes the *temporal* shape of memory legible — the single most direct
win for the continuity use case RecallNest exists to serve.

One horizontal timeline serves three jobs via filters + zoom:
- **Continuity recovery** — recent checkpoints/next-actions at the right edge.
- **Audit / trace** — see what was stored and when, across weeks.
- **Narrative exploration** — browse a scope's history as a story.

## 2. Scope

### In scope
- One new read-only endpoint: `GET /api/timeline`.
- One new pure aggregation module: `src/timeline-aggregator.ts`.
- One new types file: `src/types/timeline.ts`.
- Timeline view added to the existing workbench (`assets/ui/index.html`, `app.js`, `styles.css`)
  inside the current `viewSwitch`.
- A minimal refactor of `ui-server.ts` to make the new route testable (see §6).
- Tests: aggregator unit tests + endpoint-handler test.

### Out of scope (YAGNI)
- No new persistence, stores, or schema changes — the timeline reads existing data only.
- No new dependencies (no timeline/charting library) — vanilla DOM/CSS, matching current `app.js`.
- No write actions from the timeline (pin/forget/edit stay in existing Recall Actions).
- No cross-scope aggregation in v1 (single `scope` or default scope only).
- Cases/Patterns lane ships but is **off by default**.

## 3. Data sources → lanes

No new storage. Lanes map onto data that already exists:

| Lane | Default | Source | Timestamp |
|------|---------|--------|-----------|
| 🔵 Checkpoints | on | `SessionCheckpointStore.listRecent({ scope })` | `updatedAt` (ISO string → ms) |
| 🟠 Events | on | `store.list(...)` filtered to `category === "events"` | `entry.timestamp` (ms) |
| 🟢 Memories | on | `store.list(...)` filtered to `category ∈ {profile, preferences, entities}` | `entry.timestamp` (ms) |
| ⚪ Cases/Patterns | **off** | `store.list(...)` filtered to `category ∈ {cases, patterns}` | `entry.timestamp` (ms) |

Notes:
- **Events are not a separate store.** `event-segmenter.ts` operates on text in-memory; persisted
  "events" are memory entries with `category: "events"`. The lane is therefore a category filter.
- Memory entries expose a numeric `entry.timestamp` (ms) — the same field the existing
  `/api/dashboard-stats` handler already uses.
- Checkpoint records expose `updatedAt` as an ISO datetime string; the aggregator converts to ms.

## 4. API — `GET /api/timeline`

Added to `ui-server.ts`, following the existing `/api/dashboard-stats` pattern
(`getComponents()` → `store.refresh()` → build → `Response.json`).

### Query parameters
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `scope` | string? | default scope | Passed to both checkpoint query and entry filter |
| `from` | ISO date? | `to − 30 days` | Window start |
| `to` | ISO date? | now | Window end |
| `bucket` | `day` \| `week` \| `month` | `day` | Zoom granularity hint (echoed back; used by UI axis) |
| `lanes` | csv? | `checkpoints,events,memories` | Subset of lane ids to include |

### Response shape
```jsonc
{
  "window": { "from": "2026-06-23T00:00:00.000Z", "to": "2026-07-23T...", "bucket": "day" },
  "lanes": [
    {
      "id": "checkpoints",
      "label": "Checkpoints",
      "items": [
        {
          "id": "smoke-test-...",
          "ts": 1784834934000,
          "title": "Checkpoint · smoke-test",
          "subtitle": "next: verify reminder fires on search",
          "scope": "session:smoke-test",
          "detail": {
            "summary": "…",
            "decisions": ["…"],
            "openLoops": ["…"],
            "nextActions": ["…"]
          }
        }
      ]
    },
    { "id": "events",   "label": "Events",   "items": [ /* TimelineItem */ ] },
    { "id": "memories", "label": "Memories", "items": [ /* TimelineItem */ ] }
  ],
  "skipped": 0
}
```

- **Detail is inlined** (no lazy load): the dataset is small — the dashboard already lists up to
  10,000 entries in one call — so clicking a dot opens the detail panel with no second request.
- `skipped` counts items dropped for an unparseable/missing timestamp, so nothing vanishes silently
  (per project rule against silent truncation).

### Status codes
- `200` — always on valid params, including an empty window (empty `lanes[].items`).
- `400` — invalid params (`from > to`, unknown `bucket`, unknown lane id) via existing
  `errorResponse`.

## 5. Component boundaries

Each unit has one purpose, a clear interface, and is testable in isolation.

### `src/types/timeline.ts` (new)
Strict TypeScript types (no `any`):
`TimelineItem`, `TimelineLane`, `TimelineWindow`, `TimelineResponse`, `TimelineOptions`,
`LaneId = "checkpoints" | "events" | "memories" | "cases-patterns"`,
`Bucket = "day" | "week" | "month"`.

### `src/timeline-aggregator.ts` (new — pure, no I/O)
```ts
buildTimeline(
  checkpoints: SessionCheckpointRecord[],
  entries: MemoryEntry[],
  opts: TimelineOptions        // { from, to, bucket, lanes, scope }
): TimelineResponse
```
Responsibilities: category → lane assignment, window clamping (drop items outside `[from, to]`),
checkpoint `updatedAt` ISO→ms conversion, per-lane sort by `ts` ascending, `skipped` counting,
lane inclusion per `opts.lanes`. **All feature logic lives here.** Total function: never throws on
empty or malformed input (malformed timestamps increment `skipped`).

### `ui-server.ts` handler (thin)
Fetch checkpoints + entries from stores, parse/validate query params, delegate to `buildTimeline`,
return `Response.json`. No business logic. Route extracted to an exported function (see §6).

### `assets/ui/app.js` — `renderTimeline()`
- Fetches `/api/timeline` with current filters.
- Draws lanes as rows in a CSS grid; positions each item by
  `left = (item.ts − window.from) / (window.to − window.from) * 100%`.
- Renders a time axis with ticks per `bucket`.
- Click a dot → detail panel slides in from the right (reuses existing panel styling).
- Zoom / window controls change `bucket`/`from`/`to` and re-fetch.
- Lane toggles (checkpoints/events/memories + off-by-default cases/patterns) change `lanes` and re-fetch.
- Matches existing vanilla, framework-free idioms in `app.js`.

### `assets/ui/index.html` + `styles.css`
Add a "Timeline" entry to the existing `viewSwitch`; add lane / dot / axis / detail-panel styles.

## 6. `ui-server.ts` testability refactor (minimal)

Today `ui-server.ts` calls `Bun.serve({ async fetch(request) { … } })` at module top level with no
export, so route logic can't be tested without booting a server. The refactor is deliberately small:

- Extract the timeline route into an exported async function:
  ```ts
  export async function handleTimelineRequest(
    url: URL,
    getComponents: () => Components   // existing accessor
  ): Promise<Response>
  ```
- The `Bun.serve` `fetch` handler calls it for `GET /api/timeline`.
- Only the new route is extracted — existing routes are left untouched to avoid regression risk.

This keeps the endpoint thin and gives it a real, fast test without a live socket.

## 7. Error handling & edge cases

- **Empty window** → `200`, empty lanes; UI shows an empty state:
  "No memories in this range — widen the window."
- **`from > to`, unknown `bucket`, unknown lane id** → `400` via `errorResponse`.
- **Malformed/missing timestamp on an item** → item skipped, `skipped` incremented (never throws).
- **Checkpoint with unparseable `updatedAt`** → same skip-and-count behavior.
- **Large result sets** → v1 relies on the existing `store.list(..., 10000, 0)` ceiling; if a lane
  would exceed a display cap, the UI clusters visually but the API returns all items in-window
  (no silent server-side truncation).

## 8. Testing

- **`src/__tests__/timeline-aggregator.test.ts`** — pure-function coverage:
  window clamping (in/out of range), category→lane assignment, checkpoint ISO→ms conversion,
  cases/patterns excluded unless requested, `skipped` counting for bad timestamps, empty input,
  per-lane ascending sort. (The aggregator assumes already-valid options and never throws.)
- **`src/__tests__/ui-server-timeline.test.ts`** — calls the exported `handleTimelineRequest`
  with a stubbed `getComponents`: asserts `200` shape, and `400` on bad params
  (`from > to`, unknown `bucket`, unknown lane id — param validation lives in the handler).
- No fixtures or live server needed; tests are fast.
- **Baseline discipline:** current baseline is 1553 tests / 0 fail; this feature only adds tests
  (baseline goes up, never down). Full `bun test` must be green before commit.

## 9. Open questions / risks

- **Checkpoint enumeration by scope:** `listRecent` takes a `SessionCheckpointQuery`; confirm during
  implementation that it can enumerate across sessions within a scope (or that the default query is
  sufficient for v1). If it only returns a single session's recent checkpoints, v1 scopes the
  checkpoint lane accordingly and this is documented in the UI.
- **Timestamp field name drift:** implementation must confirm `entry.timestamp` (ms) is populated on
  all categories, not just those seen in `dashboard-stats`; fall back to `storedAt` (ISO) parse if a
  numeric `timestamp` is absent, counting any failures in `skipped`.
