import { describe, expect, it } from "bun:test";
import { handleTimelineRequest } from "../ui-server.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { SessionCheckpointRecord } from "../session-schema.js";
import type { SessionCheckpointQuery, SessionCheckpointStore } from "../session-store.js";
import type { TimelineResponse } from "../types/timeline.js";

const T = (iso: string) => Date.parse(iso);

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "e1", text: "note", vector: [], category: "events",
    scope: "project:x", importance: 1,
    timestamp: T("2026-07-20T12:00:00.000Z"), metadata: "{}", ...over,
  };
}

interface StoreStub extends Pick<MemoryStore, "list" | "refresh"> {
  listCalls: Array<string[] | undefined>;
}

function storeStub(entries: MemoryEntry[]): StoreStub {
  const listCalls: Array<string[] | undefined> = [];
  return {
    listCalls,
    refresh: async () => {},
    list: async (scopeFilter) => {
      listCalls.push(scopeFilter);
      return entries;
    },
  };
}

interface CheckpointStub extends Pick<SessionCheckpointStore, "listRecent"> {
  listRecentCalls: SessionCheckpointQuery[];
}

function checkpointStub(records: SessionCheckpointRecord[]): CheckpointStub {
  const listRecentCalls: SessionCheckpointQuery[] = [];
  return {
    listRecentCalls,
    listRecent: async (query = {}) => {
      listRecentCalls.push(query);
      return records;
    },
  };
}

describe("handleTimelineRequest", () => {
  it("returns 200 with the timeline shape", async () => {
    const url = new URL("http://x/api/timeline?from=2026-07-01&to=2026-07-31");
    const res = await handleTimelineRequest(
      url,
      storeStub([entry({ id: "ev" })]),
      checkpointStub([]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    expect(body.window.bucket).toBe("day");
    expect(body.lanes.map((l) => l.id)).toEqual(["checkpoints", "events", "memories"]);
    expect(body.lanes.find((l) => l.id === "events")?.items[0]?.id).toBe("ev");
  });

  it("rejects an unknown bucket with 400", async () => {
    const url = new URL("http://x/api/timeline?bucket=decade");
    const res = await handleTimelineRequest(url, storeStub([]), checkpointStub([]));
    expect(res.status).toBe(400);
  });

  it("rejects from>to with 400", async () => {
    const url = new URL("http://x/api/timeline?from=2026-07-31&to=2026-07-01");
    const res = await handleTimelineRequest(url, storeStub([]), checkpointStub([]));
    expect(res.status).toBe(400);
  });

  it("rejects an unknown lane id with 400", async () => {
    const url = new URL("http://x/api/timeline?lanes=events,bogus");
    const res = await handleTimelineRequest(url, storeStub([]), checkpointStub([]));
    expect(res.status).toBe(400);
  });

  it("defaults to a 30-day window when from/to are omitted", async () => {
    const url = new URL("http://x/api/timeline");
    const res = await handleTimelineRequest(url, storeStub([]), checkpointStub([]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    const spanMs = Date.parse(body.window.to) - Date.parse(body.window.from);
    expect(Math.abs(spanMs - 30 * 24 * 60 * 60 * 1000)).toBeLessThan(1000);
  });

  it("does not call listRecent when the checkpoints lane is not requested", async () => {
    const url = new URL("http://x/api/timeline?lanes=events");
    const throwingCheckpoints: Pick<SessionCheckpointStore, "listRecent"> = {
      listRecent: async () => {
        throw new Error("should not be called");
      },
    };
    const res = await handleTimelineRequest(url, storeStub([]), throwingCheckpoints);
    expect(res.status).toBe(200);
  });

  it("threads an explicit ?scope= through to both store.list and checkpoints.listRecent", async () => {
    const url = new URL("http://x/api/timeline?scope=project:x");
    const store = storeStub([]);
    const checkpoints = checkpointStub([]);
    const res = await handleTimelineRequest(url, store, checkpoints);
    expect(res.status).toBe(200);
    expect(store.listCalls).toEqual([["project:x"]]);
    expect(checkpoints.listRecentCalls[0]?.scope).toBe("project:x");
  });

  it("returns an empty lanes list when ?lanes= is present but empty", async () => {
    const url = new URL("http://x/api/timeline?lanes=");
    const res = await handleTimelineRequest(url, storeStub([]), checkpointStub([]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    expect(body.lanes.length).toBe(0);
  });

  it("dedupes repeated lane ids", async () => {
    const url = new URL("http://x/api/timeline?lanes=events,events");
    const res = await handleTimelineRequest(url, storeStub([]), checkpointStub([]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    expect(body.lanes.filter((l) => l.id === "events").length).toBe(1);
  });
});
