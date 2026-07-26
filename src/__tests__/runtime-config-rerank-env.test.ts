import { describe, expect, it } from "bun:test";

import { resolveRetrievalConfig } from "../runtime-config.js";

describe("resolveRetrievalConfig — ${VAR} expansion", () => {
  it("expands ${VAR} placeholders in rerankApiKey", () => {
    const { config } = resolveRetrievalConfig(
      { rerankApiKey: "${RECALLNEST_RERANK_API_KEY}" },
      { RECALLNEST_RERANK_API_KEY: "jina_live_key" },
    );

    expect(config.rerankApiKey).toBe("jina_live_key");
  });

  it("drops the field instead of throwing when the env var is unset", () => {
    const { config } = resolveRetrievalConfig(
      { rerankApiKey: "${RECALLNEST_RERANK_API_KEY}" },
      {},
    );

    expect(config.rerankApiKey).toBeUndefined();
  });

  it("never leaks an unexpanded placeholder as a literal credential", () => {
    const { config } = resolveRetrievalConfig(
      { rerankApiKey: "${MISSING_VAR}" },
      {},
    );

    // Regression: a literal "${MISSING_VAR}" is truthy and would pass the
    // cross-encoder guard, firing a doomed 401 round trip on every retrieval.
    expect(config.rerankApiKey).not.toBe("${MISSING_VAR}");
  });

  it("leaves plain literal strings untouched", () => {
    const { config } = resolveRetrievalConfig(
      { rerankApiKey: "plain-literal-key", rerankModel: "jina-reranker-v3" },
      {},
    );

    expect(config.rerankApiKey).toBe("plain-literal-key");
    expect(config.rerankModel).toBe("jina-reranker-v3");
  });

  it("does not disturb non-string retrieval settings", () => {
    const { config } = resolveRetrievalConfig(
      { vectorWeight: 0.7, bm25Weight: 0.3, filterNoise: true },
      {},
    );

    expect(config.vectorWeight).toBe(0.7);
    expect(config.bm25Weight).toBe(0.3);
    expect(config.filterNoise).toBe(true);
  });
});

describe("resolveRetrievalConfig — cross-encoder degradation notice", () => {
  it("reports a degradation when cross-encoder is set but no key resolves", () => {
    const { degraded } = resolveRetrievalConfig(
      { rerank: "cross-encoder", rerankApiKey: "${RECALLNEST_RERANK_API_KEY}" },
      {},
    );

    expect(degraded).toBe(true);
  });

  it("reports no degradation once the key resolves", () => {
    const { degraded } = resolveRetrievalConfig(
      { rerank: "cross-encoder", rerankApiKey: "${RECALLNEST_RERANK_API_KEY}" },
      { RECALLNEST_RERANK_API_KEY: "jina_live_key" },
    );

    expect(degraded).toBe(false);
  });

  it("reports no degradation for vllm, which needs no API key", () => {
    const { degraded } = resolveRetrievalConfig(
      { rerank: "cross-encoder", rerankProvider: "vllm" },
      {},
    );

    expect(degraded).toBe(false);
  });

  it("reports no degradation when cross-encoder was never requested", () => {
    const { degraded } = resolveRetrievalConfig({ rerank: "lightweight" }, {});

    expect(degraded).toBe(false);
  });

  it("flags the default config, which requests cross-encoder with no key", () => {
    // DEFAULT_RETRIEVAL_CONFIG.rerank is "cross-encoder"; a stock install has
    // no key wired, so the operator must be told cosine is what actually runs.
    const { degraded } = resolveRetrievalConfig({}, {});

    expect(degraded).toBe(true);
  });
});
