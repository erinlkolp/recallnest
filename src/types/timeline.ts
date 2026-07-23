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
