import { describe, expect, it } from "bun:test";

import { runLlmClusterMerges } from "../llm-consolidation.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { LLMClient } from "../llm-client.js";

/**
 * #3 — the LLM version-group merge capability, extracted from the (deleted)
 * maybeConsolidate wrapper into a reusable function the dream pipeline calls.
 */
function makeEntry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    text: `memory ${id}`,
    vector: [1, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.6,
    timestamp: Date.now(),
    metadata: "{}",
    ...overrides,
  };
}

function makeStore(entries: MemoryEntry[]) {
  const data = new Map(entries.map((e) => [e.id, { ...e }]));
  return {
    store: {
      async list(_scopeFilter?: string[], _cat?: string, limit = 500) {
        return [...data.values()].slice(0, limit);
      },
      async getById(id: string) {
        return data.get(id) ?? null;
      },
      async update(id: string, upd: Partial<MemoryEntry>) {
        const e = data.get(id);
        if (e && upd.metadata) e.metadata = upd.metadata;
        return e ?? null;
      },
    } as unknown as MemoryStore,
    data,
  };
}

function makeLLM(response: string, onCall?: () => void): LLMClient {
  return {
    async synthesizeFragments() {
      onCall?.();
      return response;
    },
  } as unknown as LLMClient;
}

describe("runLlmClusterMerges", () => {
  it("merges a linked cluster the LLM approves into a version group", async () => {
    const a = makeEntry("A", { importance: 0.9, metadata: JSON.stringify({ cluster_members: ["B"] }) });
    const b = makeEntry("B", { importance: 0.5, metadata: "{}" });
    const { store, data } = makeStore([a, b]);
    const llm = makeLLM('{"mergeGroups":[[0,1]],"keepSeparate":[],"reasoning":"duplicate"}');

    const merges = await runLlmClusterMerges({ store, scope: "project:test", llm });

    expect(merges).toBe(1);
    const ga = JSON.parse(data.get("A")!.metadata).version_group;
    const gb = JSON.parse(data.get("B")!.metadata).version_group;
    expect(typeof ga).toBe("string");
    expect(gb).toBe(ga); // both entries joined the same version group
  });

  it("performs no merge when the LLM keeps entries separate", async () => {
    const a = makeEntry("A", { metadata: JSON.stringify({ cluster_members: ["B"] }) });
    const b = makeEntry("B");
    const { store } = makeStore([a, b]);
    const llm = makeLLM('{"mergeGroups":[],"keepSeparate":[0,1],"reasoning":"distinct"}');

    expect(await runLlmClusterMerges({ store, scope: "project:test", llm })).toBe(0);
  });

  it("no-ops (never calls the LLM) when there are no linked clusters", async () => {
    let called = 0;
    const { store } = makeStore([makeEntry("A"), makeEntry("B")]); // no cluster_members
    const llm = makeLLM("{}", () => { called++; });

    expect(await runLlmClusterMerges({ store, scope: "project:test", llm })).toBe(0);
    expect(called).toBe(0);
  });

  it("skips clusters that are already merged into a version group", async () => {
    let called = 0;
    const a = makeEntry("A", { metadata: JSON.stringify({ cluster_members: ["B"], version_group: "g1" }) });
    const b = makeEntry("B");
    const { store } = makeStore([a, b]);
    const llm = makeLLM("{}", () => { called++; });

    expect(await runLlmClusterMerges({ store, scope: "project:test", llm })).toBe(0);
    expect(called).toBe(0);
  });
});
