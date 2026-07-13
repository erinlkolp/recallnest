import { describe, expect, it } from "bun:test";

import { isContextLengthError } from "../embedder.js";

/**
 * #6 — the embedder's "is this a context-length error, so retry via chunking?"
 * detector. The old inline regex /context|too long|exceed|length/i was
 * over-broad: bare `length`/`exceed`/`context` matched unrelated failures
 * (array-length bugs, rate-limit-exceeded, gRPC "context deadline exceeded"),
 * wrongly triggering the chunking fallback and masking the real error.
 */
describe("isContextLengthError", () => {
  it("detects genuine context-length / input-too-long errors", () => {
    for (const msg of [
      "This model's maximum context length is 8192 tokens",
      "This model's maximum context length has been exceeded",
      "context length exceeded",
      "input is too long",
      "too many tokens in request",
      "token limit exceeded",
      "413 Payload Too Large",
      "Request Entity Too Large",
      "context_length_exceeded",
    ]) {
      expect(isContextLengthError(msg)).toBe(true);
    }
  });

  it("does NOT match unrelated errors that merely mention length/exceed/context", () => {
    for (const msg of [
      "Cannot read property 'length' of undefined",
      "array length mismatch between request and response",
      "invalid vector length: expected 1024",
      "rate limit exceeded, retry after 30s",
      "context deadline exceeded", // gRPC/HTTP timeout, NOT a size error
      "quota exceeded for this month",
      "connection reset",
      "error code 41300",
    ]) {
      expect(isContextLengthError(msg)).toBe(false);
    }
  });
});
