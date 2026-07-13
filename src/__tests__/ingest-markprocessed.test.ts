import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestCCTranscripts } from "../ingest.js";
import { isProcessed } from "../tracker.js";
import type { Embedder } from "../embedder.js";
import type { MemoryStore } from "../store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

/** Write a CC-style JSONL transcript (>500 bytes, several parseable turns). */
function writeTranscript(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "recallnest-cc-ingest-"));
  cleanupPaths.push(dir);
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    lines.push(JSON.stringify({
      type: "user",
      sessionId: "testsession-abcd1234",
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      message: { content: `User question number ${i} about deploying the production service safely and reliably.` },
    }));
    lines.push(JSON.stringify({
      type: "assistant",
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      message: { content: `Assistant answer number ${i} covering deploy windows, rollback playbooks, and on-call approval steps.` },
    }));
  }
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, lines.join("\n"));
  return { dir, filePath };
}

function makeStore(): MemoryStore {
  return {
    async storeBatch() { return 0; },
    async vectorSearch() { return []; },
  } as unknown as MemoryStore;
}

describe("ingestCCTranscripts markProcessed on batch failure", () => {
  it("does NOT mark a file processed when its embedding batch fails", async () => {
    const { dir, filePath } = writeTranscript();
    const stat = statSync(filePath);

    const failingEmbedder = {
      async embedBatchPassage() { throw new Error("embedding provider unavailable"); },
    } as unknown as Embedder;

    const result = await ingestCCTranscripts(makeStore(), failingEmbedder, dir, {
      noDedup: true,
      llm: null,
    });

    expect(result.errors.length).toBeGreaterThan(0);
    // The batch failed and its chunks were never stored — the file must stay
    // eligible for reprocessing on the next incremental run.
    expect(isProcessed(filePath, stat.size, stat.mtimeMs)).toBe(false);
  });

  it("marks a file processed when all batches succeed", async () => {
    const { dir, filePath } = writeTranscript();
    const stat = statSync(filePath);

    const okEmbedder = {
      async embedBatchPassage(texts: string[]) { return texts.map(() => [0.1, 0.2, 0.3]); },
    } as unknown as Embedder;

    await ingestCCTranscripts(makeStore(), okEmbedder, dir, {
      noDedup: true,
      llm: null,
    });

    expect(isProcessed(filePath, stat.size, stat.mtimeMs)).toBe(true);
  });
});
