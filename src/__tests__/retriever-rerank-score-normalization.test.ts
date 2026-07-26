import { describe, expect, it } from "bun:test";

import { normalizeRerankScores } from "../retriever.js";

/**
 * Measured from a live jina-reranker-v3 call on 2026-07-26. Query was
 * "how do you bake sourdough bread at home"; the top document was a
 * near-verbatim restatement of the query and still only scored 0.362,
 * while three of five documents scored negative.
 */
const JINA_V3_OBSERVED = [
  { index: 0, score: 0.3622 },
  { index: 1, score: 0.1063 },
  { index: 2, score: -0.1380 },
  { index: 3, score: -0.1496 },
  { index: 4, score: -0.1733 },
];

describe("normalizeRerankScores — logit providers", () => {
  it("maps jina-reranker-v3 logits into 0-1", () => {
    const out = normalizeRerankScores(JINA_V3_OBSERVED, "jina", "jina-reranker-v3");

    for (const item of out) {
      expect(item.score).toBeGreaterThan(0);
      expect(item.score).toBeLessThan(1);
    }
  });

  it("preserves ordering exactly", () => {
    const out = normalizeRerankScores(JINA_V3_OBSERVED, "jina", "jina-reranker-v3");
    const before = [...JINA_V3_OBSERVED].sort((a, b) => b.score - a.score).map(i => i.index);
    const after = [...out].sort((a, b) => b.score - a.score).map(i => i.index);

    expect(after).toEqual(before);
  });

  it("preserves the index of every item", () => {
    const out = normalizeRerankScores(JINA_V3_OBSERVED, "jina", "jina-reranker-v3");

    expect(out.map(i => i.index)).toEqual(JINA_V3_OBSERVED.map(i => i.index));
  });

  it("lifts a near-verbatim match clear of the blend collapse", () => {
    // Regression: raw 0.362 blended as 0.362*0.6 + 0.85*0.4 = 0.557, a 0.29
    // drop versus the cosine path. Normalized, the top match must stay high.
    const out = normalizeRerankScores(JINA_V3_OBSERVED, "jina", "jina-reranker-v3");
    const top = out.find(i => i.index === 0)!;
    const blended = top.score * 0.6 + 0.85 * 0.4;

    expect(blended).toBeGreaterThan(0.8);
  });

  it("keeps a mid-tier genuine match above hardMinScore after blending", () => {
    // Regression: raw 0.05 blended with fused 0.55 gave 0.250, under the
    // hardMinScore of 0.3 that this store is configured with, so the result
    // was discarded outright.
    const out = normalizeRerankScores([{ index: 0, score: 0.05 }], "jina", "jina-reranker-v3");
    const blended = out[0].score * 0.6 + 0.55 * 0.4;

    expect(blended).toBeGreaterThan(0.3);
  });

  it("still ranks an irrelevant document below a relevant one", () => {
    const out = normalizeRerankScores(JINA_V3_OBSERVED, "jina", "jina-reranker-v3");
    const relevant = out.find(i => i.index === 0)!;
    const irrelevant = out.find(i => i.index === 4)!;

    expect(irrelevant.score).toBeLessThan(relevant.score);
    expect(irrelevant.score).toBeLessThan(0.5);
  });

  it("is batch-independent: one item scores the same alone as in a batch", () => {
    // Min-max normalization would pin a lone item at 1.0 and reintroduce the
    // score saturation fixed in PR #39. A memory's score must not depend on
    // what else happened to match.
    const inBatch = normalizeRerankScores(JINA_V3_OBSERVED, "jina", "jina-reranker-v3")
      .find(i => i.index === 0)!.score;
    const alone = normalizeRerankScores([{ index: 0, score: 0.3622 }], "jina", "jina-reranker-v3")[0].score;

    expect(alone).toBeCloseTo(inBatch, 10);
  });

  it("never pins the best candidate at exactly 1.0", () => {
    const out = normalizeRerankScores(JINA_V3_OBSERVED, "jina", "jina-reranker-v3");

    expect(Math.max(...out.map(i => i.score))).toBeLessThan(1);
  });
});

describe("normalizeRerankScores — unit-range providers are untouched", () => {
  const unitScores = [
    { index: 0, score: 0.93 },
    { index: 1, score: 0.41 },
    { index: 2, score: 0.02 },
  ];

  it("passes voyage scores through unchanged", () => {
    expect(normalizeRerankScores(unitScores, "voyage", "rerank-2")).toEqual(unitScores);
  });

  it("passes pinecone scores through unchanged", () => {
    expect(normalizeRerankScores(unitScores, "pinecone", "bge-reranker-v2-m3")).toEqual(unitScores);
  });

  it("passes jina-reranker-v2 through unchanged, since v2 returns 0-1", () => {
    expect(normalizeRerankScores(unitScores, "jina", "jina-reranker-v2-base-multilingual"))
      .toEqual(unitScores);
  });
});

describe("normalizeRerankScores — unknown providers fall back to detection", () => {
  it("normalizes when a self-hosted model emits out-of-range scores", () => {
    const out = normalizeRerankScores(
      [{ index: 0, score: 2.4 }, { index: 1, score: -3.1 }],
      "vllm",
      "some-local-reranker",
    );

    expect(out[0].score).toBeGreaterThan(0);
    expect(out[0].score).toBeLessThan(1);
    expect(out[1].score).toBeGreaterThan(0);
    expect(out[1].score).toBeLessThan(1);
    expect(out[1].score).toBeLessThan(out[0].score);
  });

  it("leaves a self-hosted model alone when it already returns 0-1", () => {
    const unit = [{ index: 0, score: 0.8 }, { index: 1, score: 0.1 }];

    expect(normalizeRerankScores(unit, "vllm", "some-local-reranker")).toEqual(unit);
  });
});

describe("normalizeRerankScores — edge cases", () => {
  it("returns an empty array unchanged", () => {
    expect(normalizeRerankScores([], "jina", "jina-reranker-v3")).toEqual([]);
  });

  it("produces finite scores for extreme logits", () => {
    const out = normalizeRerankScores(
      [{ index: 0, score: 1e6 }, { index: 1, score: -1e6 }],
      "jina",
      "jina-reranker-v3",
    );

    expect(Number.isFinite(out[0].score)).toBe(true);
    expect(Number.isFinite(out[1].score)).toBe(true);
    expect(out[0].score).toBeLessThanOrEqual(1);
    expect(out[1].score).toBeGreaterThanOrEqual(0);
  });

  it("treats an absent model name as the provider default", () => {
    const out = normalizeRerankScores(JINA_V3_OBSERVED, "jina", undefined);

    expect(Math.max(...out.map(i => i.score))).toBeLessThan(1);
    expect(Math.min(...out.map(i => i.score))).toBeGreaterThan(0);
  });
});
