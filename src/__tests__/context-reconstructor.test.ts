import { describe, test, expect } from "bun:test";
import {
  shouldReconstruct,
  extractCitedIds,
  removeSentencesWithId,
  computeCoverage,
  computeSourceMapCoverage,
} from "../context-reconstructor.js";

describe("reconstruction gate", () => {
  test("false when flag off", () => {
    expect(shouldReconstruct({ flagEnabled: false, callerOptIn: true, resultCount: 5, llmAvailable: true })).toBe(false);
  });
  test("false when no opt-in", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: false, resultCount: 5, llmAvailable: true })).toBe(false);
  });
  test("false when too few results", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 2, llmAvailable: true })).toBe(false);
  });
  test("false when LLM down", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 5, llmAvailable: false })).toBe(false);
  });
  test("true when all conditions met", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 5, llmAvailable: true })).toBe(true);
  });
});

describe("extractCitedIds", () => {
  test("extracts [src:ID] references", () => {
    expect(extractCitedIds("A [src:abc]. B [src:def].")).toEqual(["abc", "def"]);
  });
  test("empty for no citations", () => {
    expect(extractCitedIds("No refs.")).toEqual([]);
  });
  test("deduplicates", () => {
    expect(extractCitedIds("A [src:abc]. B [src:abc].")).toEqual(["abc"]);
  });
});

describe("removeSentencesWithId", () => {
  test("removes sentence with invalid ID", () => {
    const text = "Valid [src:real]. Fake [src:bad]. Also valid [src:ok].";
    const result = removeSentencesWithId(text, "bad");
    expect(result).toContain("[src:real]");
    expect(result).toContain("[src:ok]");
    expect(result).not.toContain("[src:bad]");
  });
  test("unchanged if ID not found", () => {
    const text = "All valid [src:a].";
    expect(removeSentencesWithId(text, "nope")).toBe(text);
  });
});

describe("computeCoverage", () => {
  test("high for identical text", () => {
    expect(computeCoverage("user prefers dark mode and typescript", ["user prefers dark mode and typescript"])).toBeGreaterThan(0.5);
  });
  test("low for unrelated text", () => {
    expect(computeCoverage("quantum physics wave function particles", ["user prefers dark mode"])).toBeLessThan(0.3);
  });
  test("partial for mixed", () => {
    const cov = computeCoverage("User likes TypeScript. Weather is sunny today.", ["User likes TypeScript", "User uses Bun"]);
    expect(cov).toBeGreaterThan(0.3);
    expect(cov).toBeLessThan(0.9);
  });
});

describe("CJK sentence handling", () => {
  test("preserves valid CJK sentences when one citation is hallucinated", () => {
    // No inter-sentence whitespace; fullwidth 。 terminators. The old ASCII
    // splitter collapsed this into one sentence, so removing the bad citation
    // dropped the whole reconstruction.
    const text =
      "これはDockerの設定です[src:mem-1]。次にKubernetesを構成しました[src:bad-9]。最後にテストしました[src:mem-2]。";
    const cleaned = removeSentencesWithId(text, "bad-9");
    expect(cleaned).toContain("[src:mem-1]");
    expect(cleaned).toContain("[src:mem-2]");
    expect(cleaned).not.toContain("[src:bad-9]");
  });

  test("computes per-sentence coverage for CJK (not all-or-nothing)", () => {
    const text = "根拠あり[src:mem-1]。根拠なしの主張です。";
    const cov = computeSourceMapCoverage(text, new Set(["mem-1"]));
    // Old behavior: whole text is one sentence -> coverage 1.0.
    expect(cov).toBeCloseTo(0.5);
  });

  test("English splitting is unaffected (decimals not over-split)", () => {
    // The ASCII branch still requires whitespace after .!?, so "3.14" stays whole.
    const text = "Version is 3.14 now [src:a]. Bad claim [src:bad].";
    const cleaned = removeSentencesWithId(text, "bad");
    expect(cleaned).toContain("3.14");
    expect(cleaned).toContain("[src:a]");
    expect(cleaned).not.toContain("[src:bad]");
  });
});
