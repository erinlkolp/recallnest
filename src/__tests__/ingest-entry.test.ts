import { afterEach, describe, expect, it } from "bun:test";

import { buildIngestedEntry } from "../ingest.js";
import { registerLanguageProcessor } from "../language-hook.js";
import type { SmartExtraction } from "../llm-client.js";

// Restore the default (identity) processor after each test so registering a
// fake here does not leak into other test files sharing the process.
afterEach(() => {
  registerLanguageProcessor({
    detectLanguage: () => "en",
    tokenizeForFts: (text: string) => text,
  });
});

function makeExtraction(overrides: Partial<SmartExtraction> = {}): SmartExtraction {
  return {
    category: "events",
    l0: "one-line summary",
    l1: "structured overview",
    importance: 0.6,
    ...overrides,
  };
}

describe("buildIngestedEntry language + fts_text", () => {
  it("detects language and tokenizes fts_text via the registered processor", () => {
    registerLanguageProcessor({
      detectLanguage: () => "zh",
      tokenizeForFts: (text: string, lang: string) => `SEG[${lang}]:${text}`,
    });

    const text = "我们通过并发重建索引修复了生产事故";
    const entry = buildIngestedEntry({
      source: "cc",
      scope: "cc:test-sess",
      text,
      vector: [1, 0, 0],
      extraction: makeExtraction(),
      file: "/tmp/transcript.jsonl",
    });

    expect(entry.language).toBe("zh");
    expect(entry.fts_text).toBe(`SEG[zh]:${text}`);
  });

  it("mirrors the stored text into fts_text under the identity processor", () => {
    const text = "we recreated the composite index concurrently";
    const entry = buildIngestedEntry({
      source: "cc",
      scope: "cc:test-sess",
      text,
      vector: [1, 0, 0],
      extraction: makeExtraction(),
      file: "/tmp/transcript.jsonl",
    });

    expect(entry.language).toBe("en");
    expect(entry.fts_text).toBe(text);
  });
});
