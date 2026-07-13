import { describe, expect, it } from "bun:test";

import { filterResultSet, type RetrievalResult, type RetrievalResultSet } from "../retriever.js";

function makeResult(id: string, timestamp: number): RetrievalResult {
  return {
    score: 0.9,
    entry: {
      id,
      text: `memory ${id}`,
      vector: [],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      timestamp,
      metadata: "{}",
    },
    sources: {},
  } as RetrievalResult;
}

describe("filterResultSet", () => {
  it("preserves the reconstruction property across filter + slice", () => {
    const set = [makeResult("a", 1), makeResult("b", 2), makeResult("c", 3)] as RetrievalResultSet;
    set.reconstruction = { reconstructed: "synthesized context" } as RetrievalResultSet["reconstruction"];

    const out = filterResultSet(set, r => r.entry.id !== "b", 5);

    expect(out.map(r => r.entry.id)).toEqual(["a", "c"]);
    expect(out.reconstruction?.reconstructed).toBe("synthesized context");
  });

  it("applies the limit cap and leaves reconstruction undefined when absent", () => {
    const set = [makeResult("a", 1), makeResult("b", 2), makeResult("c", 3)] as RetrievalResultSet;

    const out = filterResultSet(set, () => true, 2);

    expect(out.map(r => r.entry.id)).toEqual(["a", "b"]);
    expect(out.reconstruction).toBeUndefined();
  });
});
