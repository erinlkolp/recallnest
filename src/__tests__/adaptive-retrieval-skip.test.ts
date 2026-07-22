import { describe, expect, it } from "bun:test";

import { shouldSkipRetrieval } from "../adaptive-retrieval.js";

describe("shouldSkipRetrieval — numeric queries vs emoji", () => {
  it("does not skip a numeric question (digits must not be treated as emoji)", () => {
    // The skip pattern used \p{Emoji}, whose Unicode property includes ASCII
    // digits 0-9 (and #, *). Combined with the literal "?" in the class, an
    // all-digit question like "8080?" fully matched the emoji-only pattern and
    // was skipped, even though questions should always be retrieved.
    expect(shouldSkipRetrieval("8080?")).toBe(false);
  });

  it("does not skip a long all-numeric query", () => {
    expect(shouldSkipRetrieval("123456789012345")).toBe(false);
  });

  it("still skips an emoji-only message", () => {
    expect(shouldSkipRetrieval("👍👍👍")).toBe(true);
  });
});
