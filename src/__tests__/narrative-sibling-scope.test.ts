import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";
import { MemoryRetriever, type RetrievalResult } from "../retriever.js";

const cleanupPaths: string[] = [];

let prevFlag: string | undefined;

beforeAll(() => {
  prevFlag = process.env.RECALLNEST_NARRATIVE_MODE;
  process.env.RECALLNEST_NARRATIVE_MODE = "true";
});

afterAll(() => {
  if (prevFlag === undefined) delete process.env.RECALLNEST_NARRATIVE_MODE;
  else process.env.RECALLNEST_NARRATIVE_MODE = prevFlag;
});

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function createStore(): MemoryStore {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-narrative-scope-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim: 3 });
}

function narrativeMeta(generalEventId: string, seq: number): string {
  return JSON.stringify({
    source: "agent",
    narrative: {
      lifePeriodId: "lp:proj:2026-Q3",
      lifePeriodLabel: "proj (2026-Q3)",
      generalEventId,
      generalEventLabel: "shared debugging session",
      specificEventId: `se:${generalEventId}:${seq}`,
      specificEventLabel: `step ${seq}`,
      startAt: 1_712_835_600_000 + seq,
      endAt: null,
      sequence: seq,
    },
  });
}

describe("expandNarrativeSiblings scope isolation", () => {
  it("only pulls siblings from the retrieval scope, never foreign scopes", async () => {
    const store = createStore();
    const SHARED_EVENT = "ge:shared-event";

    const trigger = await store.store({
      text: "trigger memory in project A",
      vector: [1, 0, 0],
      category: "events",
      scope: "projA",
      importance: 0.6,
      metadata: narrativeMeta(SHARED_EVENT, 0),
    });
    const inScopeSibling = await store.store({
      text: "sibling memory in project A",
      vector: [1, 0, 0],
      category: "events",
      scope: "projA",
      importance: 0.6,
      metadata: narrativeMeta(SHARED_EVENT, 1),
    });
    const foreignSibling = await store.store({
      text: "sibling memory in project B",
      vector: [1, 0, 0],
      category: "events",
      scope: "projB",
      importance: 0.6,
      metadata: narrativeMeta(SHARED_EVENT, 2),
    });

    const retriever = new MemoryRetriever(store, {} as never);
    const results: RetrievalResult[] = [{ entry: trigger, score: 0.9, sources: {} }];

    const expanded = await retriever.expandNarrativeSiblings(results, ["projA"]);

    const scopes = expanded.map((r) => r.entry.scope);
    const ids = expanded.map((r) => r.entry.id);

    // The same-scope sibling is still surfaced (feature keeps working)...
    expect(ids).toContain(inScopeSibling.id);
    // ...but the foreign-scope sibling must never leak in.
    expect(scopes).not.toContain("projB");
    expect(ids).not.toContain(foreignSibling.id);
  });
});
