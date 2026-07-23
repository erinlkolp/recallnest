import { describe, expect, it } from "bun:test";
import { handleTimelineRequest } from "../ui-server.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { SessionCheckpointRecord } from "../session-schema.js";
import type { SessionCheckpointStore } from "../session-store.js";

const T = (iso: string) => Date.parse(iso);

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "e1", text: "note", vector: [], category: "events",
    scope: "project:x", importance: 1,
    timestamp: T("2026-07-20T12:00:00.000Z"), metadata: "{}", ...over,
  };
}

const storeStub = (entries: MemoryEntry[]): Pick<MemoryStore, "list" | "refresh"> => ({
  refresh: async () => {},
  list: async () => entries,
});

const checkpointStub = (records: SessionCheckpointRecord[]): Pick<SessionCheckpointStore, "listRecent"> => ({
  listRecent: async () => records,
});

describe("handleTimelineRequest", () => {
  it("returns 200 with the timeline shape", async () => {
    const url = new URL("http://x/api/timeline?from=2026-07-01&to=2026-07-31");
    const res = await handleTimelineRequest(
      url,
      storeStub([entry({ id: "ev" })]),
      checkpointStub([]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window.bucket).toBe("day");
    expect(body.lanes.map((l: any) => l.id)).toEqual(["checkpoints", "events", "memories"]);
    expect(body.lanes.find((l: any) => l.id === "events").items[0].id).toBe("ev");
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
    const body = await res.json();
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
});
