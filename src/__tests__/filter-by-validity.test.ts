import { describe, expect, it } from "bun:test";

import { filterByValidity, type RetrievalResult } from "../retriever.js";

const NOW = 1_700_000_000_000;

function result(id: string, validUntil: number | null): RetrievalResult {
  return {
    score: 0.9,
    entry: {
      id,
      text: `memory ${id}`,
      vector: [],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      timestamp: NOW - 100_000,
      metadata: JSON.stringify({ evolution: { validUntil } }),
    },
  };
}

describe("filterByValidity NaN validAt handling", () => {
  const expired = result("expired", NOW - 10_000);
  const active = result("active", null);

  it("treats a NaN validAt as no point-in-time filter and still excludes expired memories", () => {
    const out = filterByValidity([expired, active], NOW, { validAt: Number.NaN });
    expect(out.map(r => r.entry.id)).toEqual(["active"]);
  });

  it("still applies a genuine point-in-time validAt", () => {
    // At a checkTime before the expired memory's validUntil it is still valid.
    const out = filterByValidity([expired, active], NOW, { validAt: NOW - 50_000 });
    expect(out.map(r => r.entry.id).sort()).toEqual(["active", "expired"]);
  });
});
