import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";
import { runDataCheckup } from "../data-checkup.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function createStore(vectorDim: number): MemoryStore {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-checkup-vectordim-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim });
}

describe("runDataCheckup vector_dimensions against a live store", () => {
  it("reports the real stored vector dimension, not 0", async () => {
    // Regression: runDataCheckup loads entries via store.list(), which strips
    // vectors (vector: []) for performance. The dimension check therefore saw
    // length 0 for every row and always reported "dimension 0" as OK — a dead
    // check that could never detect a real dimension mismatch.
    const store = createStore(4);
    await store.store({
      text: "first", vector: [1, 0, 0, 0], category: "events",
      scope: "project:test", importance: 0.5, metadata: "{}",
    });
    await store.store({
      text: "second", vector: [0, 1, 0, 0], category: "events",
      scope: "project:test", importance: 0.5, metadata: "{}",
    });

    const report = await runDataCheckup({ store, openConflictCount: 0 });
    const dimCheck = report.checks.find(c => c.name === "vector_dimensions")!;

    expect(dimCheck.status).toBe("ok");
    expect(dimCheck.detail).toContain("dimension 4");
    expect(dimCheck.detail).not.toContain("dimension 0");
  });
});
