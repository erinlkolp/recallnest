import { describe, expect, it } from "bun:test";

import { chunkDocument, type ChunkerConfig } from "../chunker.js";

// Mirrors CONVERSATION_CHUNK_CONFIG in src/ingest.ts
const CONVERSATION_LIKE_CONFIG: ChunkerConfig = {
  maxChunkSize: 2000,
  overlapSize: 100,
  minChunkSize: 100,
  semanticSplit: true,
  maxLinesPerChunk: 40,
};

describe("chunkDocument tail preservation", () => {
  it("keeps the tail of line-dense input that forces tiny per-iteration advances", () => {
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) lines.push(`x${i % 10}`);
    const text = `${lines.join("\n")}\nEND_MARKER_XYZ`;

    const result = chunkDocument(text, CONVERSATION_LIKE_CONFIG);

    expect(result.chunks.some(c => c.includes("END_MARKER_XYZ"))).toBe(true);
    const lastMeta = result.metadatas[result.metadatas.length - 1];
    expect(lastMeta.endIndex).toBeGreaterThanOrEqual(text.length - 1);

    // Every chunk respects the size cap.
    for (const chunk of result.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CONVERSATION_LIKE_CONFIG.maxChunkSize);
    }

    // Coverage starts at (or trivially near) the beginning of the text.
    expect(result.metadatas[0].startIndex).toBeLessThanOrEqual(2);

    // No-gap coverage: any source text between consecutive chunks is whitespace-only.
    // Overlap means next.startIndex may be BEFORE prev.endIndex — no gap, passes trivially.
    for (let i = 1; i < result.metadatas.length; i++) {
      const prev = result.metadatas[i - 1];
      const next = result.metadatas[i];
      if (next.startIndex > prev.endIndex) {
        expect(text.slice(prev.endIndex, next.startIndex).trim()).toBe("");
      }
    }
  });

  it("keeps normal prose chunking behavior with overlap", () => {
    const sentence = "This is a plain sentence that ends properly. ";
    const text = sentence.repeat(300); // ~13,800 chars
    const result = chunkDocument(text, CONVERSATION_LIKE_CONFIG);

    expect(result.chunkCount).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CONVERSATION_LIKE_CONFIG.maxChunkSize);
    }
    const lastMeta = result.metadatas[result.metadatas.length - 1];
    expect(lastMeta.endIndex).toBeGreaterThanOrEqual(text.length - 1);

    // At least one consecutive pair actually overlaps.
    const hasOverlap = result.metadatas.some(
      (meta, i) => i > 0 && meta.startIndex < result.metadatas[i - 1].endIndex,
    );
    expect(hasOverlap).toBe(true);
  });
});
