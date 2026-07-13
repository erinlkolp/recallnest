# Ingest Data-Loss + Lifecycle Fix Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four silent data-loss bugs in the ingest/store pipeline (noise-filter over-matching, chunker tail drop, embedder infinite recursion, 1000-row dedup window) and revive two dead lifecycle subsystems (auto-GC signature drift, unwired memory-health-rebalance).

**Architecture:** Each fix is a small, isolated change to one production module plus a failing-test-first regression test. No schema changes to MCP tools; the only public-surface change is additive (`DreamResult.stats.rebalancedCount`, new optional `MemoryStore.listByCanonicalKey`).

**Tech Stack:** Bun (test runner: `bun test`), TypeScript strict, LanceDB. Test baseline: 1470 pass / 0 fail — must only go up.

**Verification cadence (per project CLAUDE.md):** run `bun test` after every implementation step; commit only on full green. Push only to `origin`, never `upstream`.

---

## Pre-flight

- [ ] **Step 0.1: Confirm clean baseline**

Run: `cd /Users/erin.kolp/workspace/recallnest && git status && bun test 2>&1 | tail -5`
Expected: clean tree on `main`, `1470 pass, 0 fail`. Create a work branch:

```bash
git checkout -b fix/ingest-dataloss-lifecycle-wave
```

---

### Task 1: Noise-filter — stop dropping substantive text that merely contains a denial/meta phrase

**Bug:** `DENIAL_PATTERNS` and `META_QUESTION_PATTERNS` in `src/noise-filter.ts` are unanchored and tested against the whole text (`src/noise-filter.ts:112,116`). A long, content-rich turn containing "I don't recall" anywhere is classified as noise and silently dropped at ingest (`src/ingest.ts:856-858`), capture (`src/capture-heuristic.ts:54`, `src/admission-control.ts:145`), and retrieval (`src/retriever.ts:969,1162`).

**Fix design:** Denial/meta matches only count as noise when the text is short enough to *be* the denial/meta-question, not merely contain one. Use a length gate with CJK awareness (CJK text is ~2x denser, so it gets a lower cap). Boilerplate/metadata/diagnostic patterns are already anchored — leave them untouched. False negatives (keeping a rare long pure-denial) are acceptable; false positives (losing real memories) are not.

**Files:**
- Modify: `src/noise-filter.ts:103-143`
- Test: `src/__tests__/noise-filter.test.ts` (new file)

- [ ] **Step 1.1: Write the failing test**

Create `src/__tests__/noise-filter.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";

import { isNoise } from "../noise-filter.js";

describe("noise-filter denial/meta length gating", () => {
  it("filters a short pure denial", () => {
    expect(isNoise("I don't recall that.")).toBe(true);
  });

  it("filters a short pure meta-question", () => {
    expect(isNoise("Do you remember my deploy setup?")).toBe(true);
  });

  it("keeps long substantive text containing a denial phrase", () => {
    const text =
      "I don't recall the exact commit hash, but the production outage was caused by " +
      "the schema migration dropping the composite index; we fixed it by re-creating " +
      "the index concurrently and adding a migration lint step to CI so it cannot recur.";
    expect(isNoise(text)).toBe(false);
  });

  it("keeps long substantive text containing a meta-question phrase", () => {
    const text =
      "Earlier you asked: did I mention the deploy window? For the record, deploys " +
      "happen Tuesdays at 10:00 UTC, the approver is the on-call lead, and the " +
      "rollback playbook lives in OPERATIONS.md under the fast-rollback section.";
    expect(isNoise(text)).toBe(false);
  });

  it("filters a short Chinese denial", () => {
    expect(isNoise("我不记得了，抱歉。")).toBe(true);
  });

  it("keeps long Chinese content containing a denial-like phrase", () => {
    const text =
      "虽然我不记得具体的提交号，但当时生产事故的根因是数据库迁移删除了复合索引，" +
      "我们通过并发重建索引修复了问题，并在 CI 中增加了迁移检查步骤防止再次发生。";
    expect(isNoise(text)).toBe(false);
  });

  it("still filters anchored boilerplate regardless of gating", () => {
    expect(isNoise("HEARTBEAT ping from scheduler")).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `bun test src/__tests__/noise-filter.test.ts`
Expected: FAIL — the two "keeps long..." cases return `true` (filtered) under current code.

- [ ] **Step 1.3: Implement the length gate**

In `src/noise-filter.ts`, add below the `DIAGNOSTIC_ARTIFACT_PATTERNS` block (before `NoiseFilterOptions`):

```typescript
// Denial/meta patterns are unanchored, so they must only classify a text as
// noise when the text is short enough to BE the denial/meta-question rather
// than merely contain one. CJK text carries ~2x information per char, so it
// gets a lower cap.
const CONTEXTUAL_NOISE_MAX_LENGTH_LATIN = 120;
const CONTEXTUAL_NOISE_MAX_LENGTH_CJK = 60;
const CJK_CHAR_RE = /[㐀-䶿一-鿿]/g;

function contextualNoiseMaxLength(text: string): number {
  const cjkCount = text.match(CJK_CHAR_RE)?.length ?? 0;
  return cjkCount > text.length * 0.3
    ? CONTEXTUAL_NOISE_MAX_LENGTH_CJK
    : CONTEXTUAL_NOISE_MAX_LENGTH_LATIN;
}
```

Then change the two checks in `isNoise` (`src/noise-filter.ts:112-119`) from:

```typescript
  if (opts.filterDenials && DENIAL_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: denial pattern matched: "${trimmed.slice(0, 60)}..."`);
    return true;
  }
  if (opts.filterMetaQuestions && META_QUESTION_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: meta-question filtered: "${trimmed.slice(0, 60)}..."`);
    return true;
  }
```

to:

```typescript
  const contextualMax = contextualNoiseMaxLength(trimmed);
  if (opts.filterDenials && trimmed.length <= contextualMax &&
      DENIAL_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: denial pattern matched: "${trimmed.slice(0, 60)}..."`);
    return true;
  }
  if (opts.filterMetaQuestions && trimmed.length <= contextualMax &&
      META_QUESTION_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: meta-question filtered: "${trimmed.slice(0, 60)}..."`);
    return true;
  }
```

- [ ] **Step 1.4: Run the new test, then the full suite**

Run: `bun test src/__tests__/noise-filter.test.ts` → expected PASS.
Run: `bun test` → expected 0 fail. If existing tests asserted the old contains-anywhere behavior (likely in `ingest.test.ts` / `capture-heuristic.test.ts` / `admission-control.test.ts`), inspect each failure: if the fixture is a *short* denial/meta text, keep the assertion and shorten/verify the fixture; if the fixture is long substantive text expected to be filtered, that assertion encoded the bug — update it to expect retention.

- [ ] **Step 1.5: Commit**

```bash
git add src/noise-filter.ts src/__tests__/noise-filter.test.ts
git commit -m "fix(noise-filter): length-gate unanchored denial/meta patterns to stop dropping substantive text"
```

---

### Task 2: Chunker — never drop the document tail when the iteration guard trips

**Bug:** `chunkDocument` (`src/chunker.ts:179-222`) computes `maxGuard` assuming each iteration advances `maxChunkSize - overlapSize` chars, but line-dense input under `maxLinesPerChunk` splits near `minEnd`, so real advance can be as small as ~20 chars with the conversation config (`src/ingest.ts:757-763`: max 2000 / overlap 100 / min 100 / 40 lines). The guard trips with `pos < text.length` and the remaining tail is silently discarded.

**Fix design:** Track consumption precisely (set `pos = text.length` on every tail-consuming `break`), and after the loop hard-split any unconsumed remainder into `maxChunkSize` slices (no overlap, no semantic split). Termination stays guaranteed; data loss becomes impossible.

**Files:**
- Modify: `src/chunker.ts:182-222`
- Test: `src/__tests__/chunker.test.ts` (new file)

- [ ] **Step 2.1: Write the failing test**

Create `src/__tests__/chunker.test.ts`:

```typescript
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
  });
});
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `bun test src/__tests__/chunker.test.ts`
Expected: FAIL — first case: `END_MARKER_XYZ` absent (guard trips after ~12 iterations covering ~240 of ~12,000 chars).

- [ ] **Step 2.3: Implement the fix**

In `src/chunker.ts`, replace the loop body's three exit points and add a tail flush. The `while` block (`src/chunker.ts:182-222`) becomes:

```typescript
  while (pos < text.length && guard < maxGuard) {
    guard++;

    const remaining = text.length - pos;
    if (remaining <= config.maxChunkSize) {
      const { chunk, meta } = sliceTrimWithIndices(text, pos, text.length);
      if (chunk.length > 0) {
        chunks.push(chunk);
        metadatas.push(meta);
      }
      pos = text.length;
      break;
    }

    const maxEnd = Math.min(pos + config.maxChunkSize, text.length);
    const minEnd = Math.min(pos + config.minChunkSize, maxEnd);

    const end = findSplitEnd(text, pos, maxEnd, minEnd, config);
    const { chunk, meta } = sliceTrimWithIndices(text, pos, end);

    // If trimming made it too small, fall back to a hard split.
    if (chunk.length < config.minChunkSize) {
      const hardEnd = Math.min(pos + config.maxChunkSize, text.length);
      const hard = sliceTrimWithIndices(text, pos, hardEnd);
      if (hard.chunk.length > 0) {
        chunks.push(hard.chunk);
        metadatas.push(hard.meta);
      }
      if (hardEnd >= text.length) {
        pos = text.length;
        break;
      }
      pos = Math.max(hardEnd - config.overlapSize, pos + 1);
      continue;
    }

    chunks.push(chunk);
    metadatas.push(meta);

    if (end >= text.length) {
      pos = text.length;
      break;
    }

    // Move forward with overlap.
    const nextPos = Math.max(end - config.overlapSize, pos + 1);
    pos = nextPos;
  }

  // The guard can trip before the input is consumed (line-dense input makes
  // per-iteration advance much smaller than maxChunkSize - overlapSize).
  // Hard-split the remainder so no text is ever silently dropped.
  while (pos < text.length) {
    const hardEnd = Math.min(pos + config.maxChunkSize, text.length);
    const { chunk, meta } = sliceTrimWithIndices(text, pos, hardEnd);
    if (chunk.length > 0) {
      chunks.push(chunk);
      metadatas.push(meta);
    }
    pos = hardEnd;
  }
```

- [ ] **Step 2.4: Run the new test, then the full suite**

Run: `bun test src/__tests__/chunker.test.ts` → expected PASS.
Run: `bun test` → expected 0 fail.

- [ ] **Step 2.5: Commit**

```bash
git add src/chunker.ts src/__tests__/chunker.test.ts
git commit -m "fix(chunker): flush unconsumed tail when iteration guard trips instead of dropping it"
```

---

### Task 3: Embedder — bound the context-error chunking recursion

**Bug:** `embedSingle` (`src/embedder.ts:355-369`) reacts to a context-length error by chunking and calling itself on each chunk with no depth guard. When `smartChunk` returns the text unchanged (input already ≤ its char heuristic but over the provider's *real* limit, or an unknown model), the recursion never terminates. The batch path (`src/embedder.ts:462-471`) feeds the same recursion.

**Fix design:** Add a `depth` parameter; only attempt chunking at `depth === 0`. A chunk that still exceeds the provider limit then fails cleanly with the provider error instead of recursing.

**Files:**
- Modify: `src/embedder.ts:331,355,369,471`
- Test: `src/__tests__/embedder.test.ts` (append)

- [ ] **Step 3.1: Write the failing test**

Append to `src/__tests__/embedder.test.ts` (follow the existing `(embedder as any).client` injection pattern):

```typescript
describe("Embedder chunking recursion guard", () => {
  it("fails cleanly instead of recursing when chunks still exceed the context limit", async () => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    let calls = 0;
    (embedder as any).client = {
      embeddings: {
        create: async () => {
          calls += 1;
          throw new Error("This model's maximum context length has been exceeded");
        },
      },
    };

    // Long enough that smartChunk splits it; every chunk also "exceeds" the limit.
    const text = "word ".repeat(3000);

    await expect(embedder.embedPassage(text)).rejects.toThrow(/Failed to generate embedding/);
    // 1 original attempt + one attempt per first-level chunk; must not grow unbounded.
    expect(calls).toBeLessThan(20);
  }, 10_000);
});
```

- [ ] **Step 3.2: Run the test to verify it fails**

Run: `bun test src/__tests__/embedder.test.ts`
Expected: FAIL — times out or exceeds the call bound (each chunk re-chunks itself forever).

- [ ] **Step 3.3: Implement the depth guard**

In `src/embedder.ts`:

1. Change the signature at `:331`:

```typescript
  private async embedSingle(text: string, task?: string, depth = 0): Promise<number[]> {
```

2. Change the chunking condition at `:355`:

```typescript
      if (isContextError && this._autoChunk && depth === 0) {
```

3. Change the recursive call at `:369`:

```typescript
                const embedding = await this.embedSingle(chunk, task, depth + 1);
```

4. In `embedMany`'s chunk fallback at `:471`, mark the calls as already-chunked:

```typescript
                chunkResult.chunks.map((chunk) => this.embedSingle(chunk, task, 1))
```

- [ ] **Step 3.4: Run the new test, then the full suite**

Run: `bun test src/__tests__/embedder.test.ts` → expected PASS (rejects quickly, bounded calls).
Run: `bun test` → expected 0 fail.

- [ ] **Step 3.5: Commit**

```bash
git add src/embedder.ts src/__tests__/embedder.test.ts
git commit -m "fix(embedder): bound context-error chunking recursion with a depth guard"
```

---

### Task 4: Canonical dedup — query by canonical key instead of scanning a 1000-row recency window

**Bug:** `findCanonicalMatches` (`src/capture-engine.ts:431-442`) fetches the 1000 most-recent rows (`CANONICAL_SCAN_LIMIT`, `src/capture-engine.ts:99`) via `store.list` (timestamp-desc slice, `src/store.ts:700-701`) and filters app-side. Once the store exceeds 1000 rows, older canonical entries become invisible: exact dupes re-store, cross-category conflicts and latest-wins collapse are missed.

**Fix design:** Add `MemoryStore.listByCanonicalKey(canonicalKey)` that pre-filters at the DB layer with `metadata LIKE '%"canonicalKey":<json>%' ESCAPE '\'` (reusing `escapeSqlLiteral` + `escapeLikePattern`, `src/store.ts:124-130`), then exact-verifies each row by parsing metadata (no LIKE false positives). Both the LIKE fragment and stored metadata are produced by `JSON.stringify`, so escaping is consistent. `findCanonicalMatches` prefers the new method and keeps the windowed scan as fallback for store fakes that don't implement it.

**Files:**
- Modify: `src/store.ts` (new method after `list`, i.e. after `:702`)
- Modify: `src/capture-engine.ts:64,431-442`
- Test: `src/__tests__/store-canonical-lookup.test.ts` (new file)
- Test: `src/__tests__/capture-engine.test.ts` (append)

- [ ] **Step 4.1: Write the failing store-level test**

Create `src/__tests__/store-canonical-lookup.test.ts` (harness copied from `store-update-atomicity.test.ts`):

```typescript
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function createStore(): MemoryStore {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-canonical-lookup-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim: 3 });
}

function durableMetadata(canonicalKey: string): string {
  return JSON.stringify({ canonicalKey, boundary: { layer: "durable" } });
}

describe("MemoryStore.listByCanonicalKey", () => {
  it("finds entries by canonical key regardless of recency", async () => {
    const store = createStore();
    const old = await store.store({
      text: "user prefers bun over npm",
      vector: [1, 0, 0],
      category: "preferences",
      scope: "project:test",
      importance: 0.7,
      timestamp: Date.now() - 90 * 86_400_000,
      metadata: durableMetadata("preferences:tooling:bun"),
    });
    await store.store({
      text: "unrelated memory",
      vector: [0, 1, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata("events:unrelated"),
    });

    const matches = await store.listByCanonicalKey("preferences:tooling:bun");
    expect(matches.map(m => m.id)).toEqual([old.id]);
    expect(matches[0].text).toBe("user prefers bun over npm");
  });

  it("does not treat LIKE wildcards in keys as wildcards", async () => {
    const store = createStore();
    await store.store({
      text: "underscore key entry",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata("entities:a_b"),
    });
    await store.store({
      text: "would match a naive wildcard",
      vector: [0, 1, 0],
      category: "entities",
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata("entities:aXb"),
    });

    const matches = await store.listByCanonicalKey("entities:a_b");
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("underscore key entry");
  });

  it("returns an empty array for an unknown key", async () => {
    const store = createStore();
    await store.store({
      text: "something",
      vector: [1, 0, 0],
      category: "events",
      scope: "project:test",
      importance: 0.5,
      metadata: durableMetadata("events:something"),
    });
    expect(await store.listByCanonicalKey("events:missing")).toEqual([]);
  });
});
```

Note: if `store.store` does not accept a `timestamp` override, drop that field from the first test — recency-independence is proven by the method not being windowed, and the capture-engine test in Step 4.4 covers the beyond-window scenario directly.

- [ ] **Step 4.2: Run the test to verify it fails**

Run: `bun test src/__tests__/store-canonical-lookup.test.ts`
Expected: FAIL — `listByCanonicalKey is not a function`.

- [ ] **Step 4.3: Implement `listByCanonicalKey` in the store**

In `src/store.ts`, add directly after the `list` method (after `:702`):

```typescript
  /**
   * List entries whose metadata carries the exact canonical key.
   * DB-level LIKE prefilter keeps this O(matches) instead of scanning a
   * recency window; each candidate is exact-verified by parsing metadata,
   * so LIKE can only over-match, never wrongly include.
   */
  async listByCanonicalKey(canonicalKey: string): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    // Metadata is serialized with JSON.stringify, so the key appears as
    // "canonicalKey":<json-string>. Build the same fragment for the LIKE.
    const fragment = `"canonicalKey":${JSON.stringify(canonicalKey)}`;
    const likeSafe = escapeSqlLiteral(escapeLikePattern(fragment));

    const rows = await this.table!
      .query()
      .where(`metadata LIKE '%${likeSafe}%' ESCAPE '\\'`)
      .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
      .toArray();

    return rows
      .filter((row) => {
        try {
          const parsed = JSON.parse((row.metadata as string) || "{}") as { canonicalKey?: unknown };
          return parsed.canonicalKey === canonicalKey;
        } catch {
          return false;
        }
      })
      .map((row): MemoryEntry => ({
        id: row.id as string,
        text: row.text as string,
        vector: [],
        category: row.category as MemoryEntry["category"],
        scope: (row.scope as string | undefined) ?? "",
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: (row.metadata as string) || "{}",
      }))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }
```

Run: `bun test src/__tests__/store-canonical-lookup.test.ts` → expected PASS.

- [ ] **Step 4.4: Write the failing capture-engine test**

Append inside the `describe("persistMemory", ...)` block of `src/__tests__/capture-engine.test.ts`, reusing the file's `createDeps()` helper (`src/__tests__/capture-engine.test.ts:7-83`):

```typescript
  it("dedupes against a canonical entry that is outside the recency window", async () => {
    const { deps, storedEntries } = createDeps();

    const oldDurable = {
      id: "99999999-9999-4999-8999-999999999999",
      text: "User prefers dark mode",
      vector: [22, 1, 0],
      category: "preferences",
      scope: TEST_SCOPE,
      importance: 0.7,
      timestamp: 1_600_000_000_000,
      metadata: JSON.stringify({
        source: "manual",
        capture: "store_memory_schema_v1",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        canonicalKey: "preferences:user-prefers-dark-mode",
      }),
    };

    // Simulates a grown store: the recency-windowed list no longer surfaces
    // the old entry, but the canonical-key lookup does.
    (deps.store as any).list = async () => [];
    (deps.store as any).listByCanonicalKey = async (key: string) =>
      key === "preferences:user-prefers-dark-mode" ? [oldDurable] : [];

    const result = await persistMemory(deps as any, {
      text: "User prefers dark mode",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });

    expect(result.disposition).toBe("deduped");
    expect(storedEntries).toHaveLength(0);
  });
```

(The derived canonical key `preferences:user-prefers-dark-mode` matches the existing first test's expectation at `src/__tests__/capture-engine.test.ts:97`.)

- [ ] **Step 4.5: Run the test to verify it fails**

Run: `bun test src/__tests__/capture-engine.test.ts`
Expected: FAIL — disposition is `stored` (the window returned nothing, so the engine treats it as new).

- [ ] **Step 4.6: Wire the store method into capture-engine**

In `src/capture-engine.ts`:

1. Extend `StoreDeps` at `:64`:

```typescript
type StoreDeps = Pick<MemoryStore, "store"> & Partial<Pick<MemoryStore, "list" | "update" | "getById" | "get" | "vectorSearch" | "listByCanonicalKey">>;
```

2. Replace `findCanonicalMatches` (`:431-442`):

```typescript
async function findCanonicalMatches(
  store: StoreDeps,
  canonicalKey: string,
): Promise<MemoryEntry[]> {
  if (store.listByCanonicalKey) {
    const entries = await store.listByCanonicalKey(canonicalKey);
    return entries.filter((entry) => extractBoundaryMetadata(entry.metadata)?.layer === "durable");
  }
  // Fallback for store deps without canonical lookup: recency-windowed scan.
  if (!store.list) return [];
  const entries = await store.list(undefined, undefined, CANONICAL_SCAN_LIMIT, 0);
  return entries.filter((entry) => {
    const boundary = extractBoundaryMetadata(entry.metadata);
    if (boundary?.layer !== "durable") return false;
    return extractCanonicalKey(entry.metadata) === canonicalKey;
  });
}
```

- [ ] **Step 4.7: Run the new tests, then the full suite**

Run: `bun test src/__tests__/capture-engine.test.ts src/__tests__/store-canonical-lookup.test.ts` → expected PASS.
Run: `bun test` → expected 0 fail.

- [ ] **Step 4.8: Commit**

```bash
git add src/store.ts src/capture-engine.ts src/__tests__/store-canonical-lookup.test.ts src/__tests__/capture-engine.test.ts
git commit -m "fix(dedup): query canonical keys at the DB layer instead of a 1000-row recency window"
```

---

### Task 5: Auto-GC — fix the signature drift that makes GC a permanent no-op

**Bug (drive-by, found while auditing the lifecycle wiring):** `src/auto-gc.ts:82` reads `stats.total`, but `store.stats()` returns `{ totalCount, ... }` (`src/store.ts:806-834`) — so `totalMemories` is always `0 ?? 0 = 0`... precisely: `stats.total` is `undefined`, `totalMemories = 0`, and GC always exits with `below_memory_threshold`. Additionally `src/auto-gc.ts:103` calls `store.list({ limit: 5000 })` against the positional signature `list(scopeFilter?, category?, limit = 20, offset = 0)` — even if GC ran, it would scan only 20 rows. The dream pipeline's prune phase (`src/dream-pipeline.ts:186`) is therefore dead. The existing mock in `dream-pipeline.test.ts:44-51` returns *both* `totalCount` and `total`, which is exactly how this drift survived the suite.

**Files:**
- Modify: `src/auto-gc.ts:81-82,103`
- Modify: `src/__tests__/dream-pipeline.test.ts:44-51` (remove the masking `total` field)
- Test: `src/__tests__/auto-gc.test.ts` (new file)

- [ ] **Step 5.1: Write the failing test**

Create `src/__tests__/auto-gc.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "bun:test";

import { maybeRunGc, resetGcTimestamp, DEFAULT_AUTO_GC_CONFIG } from "../auto-gc.js";
import type { MemoryEntry, MemoryStore } from "../store.js";

function makeEntry(i: number): MemoryEntry {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    text: `memory ${i}`,
    vector: [],
    category: "events",
    scope: "project:test",
    importance: 0.4,
    timestamp: Date.now() - 60 * 86_400_000, // 60 days old
    metadata: JSON.stringify({
      evolution: {
        status: "active",
        version: 1,
        accessCount: 0,
        lastAccessedAt: null,
        supersededBy: null,
        consolidatedInto: null,
        contributedToPattern: null,
        sourceMemories: [],
        validFrom: Date.now() - 60 * 86_400_000,
        validUntil: null,
      },
    }),
  };
}

function createAccurateMockStore(entries: MemoryEntry[]): MemoryStore {
  return {
    // Matches the REAL store surface: stats has totalCount (no `total`),
    // list is positional with a default limit of 20.
    async stats() {
      return { totalCount: entries.length, scopeCounts: {}, categoryCounts: {} };
    },
    async list(_scopeFilter?: string[], _category?: string, limit = 20, offset = 0) {
      return entries.slice(offset, offset + limit);
    },
    async update(id: string, updates: Partial<MemoryEntry>) {
      const entry = entries.find(e => e.id === id);
      if (entry && updates.metadata) entry.metadata = updates.metadata;
      return entry ?? null;
    },
  } as unknown as MemoryStore;
}

describe("maybeRunGc store-signature compatibility", () => {
  beforeEach(() => {
    resetGcTimestamp();
  });

  it("triggers when the store holds at least minMemoryCount memories", async () => {
    const entries = Array.from({ length: 1200 }, (_, i) => makeEntry(i));
    const result = await maybeRunGc(createAccurateMockStore(entries), DEFAULT_AUTO_GC_CONFIG);

    expect(result.triggered).toBe(true);
    expect(result.totalChecked).toBe(1200);
  });
});
```

- [ ] **Step 5.2: Run the test to verify it fails**

Run: `bun test src/__tests__/auto-gc.test.ts`
Expected: FAIL — `triggered` is `false` with reason `below_memory_threshold` (reads `stats.total`); after fixing only that line it would still fail on `totalChecked` = 20 (default limit).

- [ ] **Step 5.3: Implement the fix**

In `src/auto-gc.ts`:

1. At `:81-82`, change:

```typescript
  const stats = await store.stats();
  const totalMemories = stats.total ?? 0;
```

to:

```typescript
  const stats = await store.stats();
  const totalMemories = stats.totalCount ?? 0;
```

2. At `:103`, change:

```typescript
  const entries = await store.list({ limit: 5000 });
```

to:

```typescript
  const entries = await store.list(undefined, undefined, 5000, 0);
```

3. In `src/__tests__/dream-pipeline.test.ts:44-51`, delete the masking `total: stored.length,` line from the mock's `stats()` so the mock matches the real store surface again.

- [ ] **Step 5.4: Run the new test, then the full suite**

Run: `bun test src/__tests__/auto-gc.test.ts` → expected PASS.
Run: `bun test` → expected 0 fail (dream-pipeline tests must still pass with the leaner mock).

- [ ] **Step 5.5: Commit**

```bash
git add src/auto-gc.ts src/__tests__/auto-gc.test.ts src/__tests__/dream-pipeline.test.ts
git commit -m "fix(auto-gc): repair stats/list signature drift that made GC a permanent no-op"
```

---

### Task 6: Wire memory-health-rebalance into the dream pipeline

**Bug:** `src/memory-health-rebalance.ts` is fully implemented and unit-tested but has zero production importers — tier backfill, importance rebalancing, and dead-memory demotion silently never run.

**Fix design:** Run rebalancing as a new dream phase between consolidate and prune (`runDream`, `src/dream-pipeline.ts`), using the already-gathered `active` entries. Apply changed plans via `store.update(id, { importance, metadata })`, capped per run. Additive changes only: new phase literal `"rebalance"`, new stat `rebalancedCount`, new config `maxRebalancePerRun`. The `dream` MCP tool's input schema is untouched; its text output gains one line (callers parse nothing structured from it).

**Files:**
- Modify: `src/dream-pipeline.ts` (config `:29-51`, phase type `:54`, stats `:58-72`, pipeline after `:181`, formatter `:206-227`)
- Test: `src/__tests__/dream-pipeline.test.ts` (append + update stats literals)

- [ ] **Step 6.1: Write the failing test**

Append to `src/__tests__/dream-pipeline.test.ts`:

```typescript
describe("runDream rebalance phase", () => {
  beforeEach(() => {
    resetWriteCount();
  });

  it("rebalances tiers and importance for active entries", async () => {
    // Entry with accesses but no tier: gets a tier backfill + banded importance.
    const accessed = makeEntry({ id: "accessed" });
    accessed.importance = 0.2;
    accessed.metadata = JSON.stringify({
      accessCount: 4,
      evolution: {
        status: "active", version: 1, accessCount: 4, lastAccessedAt: Date.now(),
        supersededBy: null, consolidatedInto: null, contributedToPattern: null,
        sourceMemories: [], validFrom: Date.now(), validUntil: null,
      },
    });

    const entries = [accessed, makeEntry({ id: "b" }), makeEntry({ id: "c" }), makeEntry({ id: "d" })];
    const updates: Array<{ id: string; importance?: number; metadata?: string }> = [];
    const store = createMockStore(entries);
    const originalUpdate = store.update.bind(store);
    (store as any).update = async (id: string, upd: any) => {
      updates.push({ id, importance: upd.importance, metadata: upd.metadata });
      return originalUpdate(id, upd);
    };

    const result = await runDream({
      store,
      llm: null,
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    expect(result.phases.some(p => p.phase === "rebalance")).toBe(true);
    expect(result.stats.rebalancedCount).toBeGreaterThan(0);

    const accessedUpdate = updates.find(u => u.id === "accessed");
    expect(accessedUpdate).toBeDefined();
    // accessCount 4, no stored tier → "working" band [0.6, 0.8]
    expect(accessedUpdate!.importance).toBeGreaterThanOrEqual(0.6);
    expect(accessedUpdate!.importance).toBeLessThanOrEqual(0.8);
    expect(JSON.parse(accessedUpdate!.metadata!).tier).toBe("working");
  });
});
```

- [ ] **Step 6.2: Run the test to verify it fails**

Run: `bun test src/__tests__/dream-pipeline.test.ts`
Expected: FAIL — `stats.rebalancedCount` is undefined and no `rebalance` phase exists. (TypeScript may fail compilation first on `rebalancedCount` — same signal.)

- [ ] **Step 6.3: Implement the rebalance phase**

In `src/dream-pipeline.ts`:

1. Add the import below the existing imports (`:23`):

```typescript
import {
  buildMemoryHealthRebalancePlan,
  summarizeMemoryHealthPlans,
  parseMemoryHealthMetadata,
  getMemoryHealthAccessCount,
} from "./memory-health-rebalance.js";
```

2. Extend `DreamConfig` (`:29-42`) and its default (`:44-51`):

```typescript
  /** Max entries to rebalance (tier/importance) per dream run (default: 200) */
  maxRebalancePerRun: number;
```

```typescript
  maxRebalancePerRun: 200,
```

3. Extend the phase union (`:54`):

```typescript
  phase: "orient" | "gather" | "consolidate" | "rebalance" | "prune";
```

4. Add `rebalancedCount: number;` to `DreamResult["stats"]` (`:62-71`) and `rebalancedCount: 0,` to the `stats` initializer in `runDream` (`:91-100`).

5. In the early-return branch (`:140-145`), add before the prune skip line:

```typescript
    phases.push({ phase: "rebalance", detail: "skipped — too few active entries" });
```

6. Insert the phase between consolidate (`:178-181`) and prune (`:183-186`):

```typescript
  // =========================================================================
  // Phase 3.5: Rebalance — recompute tiers/importance from access patterns
  // =========================================================================
  let maxAccessCount = 0;
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;
  for (const entry of active) {
    const md = parseMemoryHealthMetadata(entry.metadata);
    maxAccessCount = Math.max(maxAccessCount, getMemoryHealthAccessCount(md));
    minTimestamp = Math.min(minTimestamp, entry.timestamp);
    maxTimestamp = Math.max(maxTimestamp, entry.timestamp);
  }

  const plans = active.map(entry => buildMemoryHealthRebalancePlan(
    { id: entry.id, importance: entry.importance, timestamp: entry.timestamp, metadata: entry.metadata },
    { maxAccessCount, minTimestamp, maxTimestamp },
  ));
  const changedPlans = plans.filter(p => p.changed).slice(0, config.maxRebalancePerRun);

  for (const plan of changedPlans) {
    await store.update(plan.id, {
      importance: plan.nextImportance,
      metadata: JSON.stringify(plan.nextMetadata),
    });
  }
  stats.rebalancedCount = changedPlans.length;

  const rebalanceSummary = summarizeMemoryHealthPlans(plans);
  phases.push({
    phase: "rebalance",
    detail: `${changedPlans.length} rebalanced (${rebalanceSummary.tierBackfills} tier backfills, ${rebalanceSummary.deadMemoryDemotions} dead-memory demotions)`,
  });
```

7. Add to `formatDreamResult`'s stats lines (`:216-224`):

```typescript
    `  Rebalanced: ${result.stats.rebalancedCount}`,
```

8. Update every existing `stats:` object literal in `src/__tests__/dream-pipeline.test.ts` (the `formatDreamResult` cases around `:207` and `:223`) to include `rebalancedCount: 0,` (or the asserted value), and adjust any exact-output assertions for the new formatter line.

- [ ] **Step 6.4: Run the new test, then the full suite**

Run: `bun test src/__tests__/dream-pipeline.test.ts` → expected PASS.
Run: `bun test` → expected 0 fail, total count strictly above 1470.

- [ ] **Step 6.5: Commit**

```bash
git add src/dream-pipeline.ts src/__tests__/dream-pipeline.test.ts
git commit -m "feat(dream): wire memory-health-rebalance into the dream pipeline as a rebalance phase"
```

---

## Post-flight

- [ ] **Step 7.1: Full verification**

Run: `bun test 2>&1 | tail -5`
Expected: 0 fail, total > 1470. Update the CLAUDE.md test-baseline line (`当前基线`) to the new count and commit it with `chore: bump test baseline`.

- [ ] **Step 7.2: Hand off**

Do NOT push or open a PR without explicit approval. Push target is `origin` only (never `upstream`). Report: fixed bug list, new test count, branch name.

---

## Follow-ups recorded during execution (reviewer findings accepted as out-of-wave)

1. **Chunker guard calibration (Task 2 review).** `maxGuard` in `src/chunker.ts:179` still under-estimates iterations for line-dense input, so such input is largely hard-split by the flush backstop (bypassing `maxLinesPerChunk`/semantic splitting). Deliberately NOT loosened in-wave: a loose guard would emit hundreds of tiny overlapping semantic chunks (~30x embedding calls, retrieval pollution). Data loss is impossible either way (locked by tests). Revisit guard math if chunk quality on line-dense input matters.
2. **Canonical lookup scaling (Task 4 review).** `listByCanonicalKey` is a full LanceDB scan-filter (leading-wildcard LIKE cannot index). Fine at current volumes; the scaling fix is a scalar index or a dedicated `canonicalKey` column. Also note: the unbounded lookup can surface cross-scope canonical matches the old 1000-row window happened to miss — more correct, but a behavioral broadening.
3. **`maybeConsolidate` is still unwired (Task 5 review).** ✅ FIXED (2026-07-13). `maybeConsolidate` held the *only* reachable path to the flag-gated LLM version-group merge (`evaluateCluster`/`executeMergeDecisions`) — not simply redundant. Resolution: extracted that logic into `runLlmClusterMerges` (llm-consolidation.ts) and wired it into the dream consolidate phase behind `RECALLNEST_LLM_CONSOLIDATION`; deleted the dead `auto-consolidation.ts` dual-gate wrapper + its test. Note: dream now considers all currently-linked clusters (not only those linked this run). Tests: `src/__tests__/llm-cluster-merge.test.ts` + dream-pipeline wiring tests.
   ~~Was: no production code calls maybeConsolidate; dream uses ConsolidationEngine/clusterAndConsolidate directly.~~
4. **Auto-GC scan window direction (Task 5 review).** ✅ FIXED (2026-07-13). GC now scans OLDEST-first (`store.list(..., "asc")`) via a configurable `maxScanPerRun` window (default 5000), so the true archive candidates are the rows examined. `store.list` gained an optional `order` param (default `"desc"`, backward-compatible). Tests: `src/__tests__/auto-gc-scope-window.test.ts`.
   ~~Was: GC scans the NEWEST 5000 rows but archives OLD memories, so on stores >5000 rows the prime archive candidates are never scanned.~~
5. **Auto-GC scope semantics (Task 5 review).** ✅ FIXED (2026-07-13). `maybeRunGc` now takes an optional `scope`; `runDream(scope)` passes its scope so the archival scan is scope-restricted and can no longer touch another project's memories. The trigger gate (`minMemoryCount`) stays global by design — a "is the DB big enough to bother" check. Tests: `src/__tests__/auto-gc-scope-window.test.ts`.
   ~~Was: `runDream(scope)` gathers per-scope but `maybeRunGc` runs globally — a dream for one project can archive memories from another.~~
6. **Embedder error-detection regex (Task 3 review).** ✅ FIXED (2026-07-13). Extracted the detector into an exported `isContextLengthError()` (DRY — was duplicated at two sites) with a tightened regex that requires input-size signals (`context length`, `too long`, `too many tokens`, `token limit`, `payload too large`, `413`, …) and no longer matches bare `length`/`exceed`/`context` (which caught array-length bugs, rate/quota limits, and gRPC "context deadline exceeded" timeouts). Batch post-chunking throw now carries `{ cause: error }`. Tests: `src/__tests__/context-length-error.test.ts`.
7. **Noise-filter residual (Task 1 review).** ✅ FIXED (2026-07-13). Denial/meta classification now requires the matched phrase to DOMINATE the text (longest-match / length ≥ 0.4) in addition to the length gate, so short-but-substantive texts that merely contain a denial phrase are kept. Purely narrows what's dropped (never broadens). Tests added to `src/__tests__/noise-filter.test.ts`.
8. **No typecheck step exists.** ✅ FIXED (2026-07-13). Added `typescript` + `@types/bun` devDeps, a strict `tsconfig.json` (excludes `src/__tests__`), a `typecheck` script (`tsc --noEmit`), and a blocking CI step. `tsc` had never run, surfacing 353 latent errors: ~250 collapsed via one systematic fix to the `registerTool` wrapper typing (its `Parameters<typeof server.tool>[2|3]` aliases resolved against the wrong overload → made generic over `ZodRawShape`/`ToolCallback<Args>`); the remaining ~35 production errors were fixed, including genuine runtime bugs (`distill_session` called `distillSession` with a malformed shape dropping scope; `capture-engine` called `buildDefaultCanonicalKey` with wrong args; `mcp-server` read snake_case result props as camelCase; a `context-composer` condition compared a boundary layer to the non-existent "working"; a `memory-boundaries` union-narrowing gap). Tests remain excluded from the gate for now (68 mostly-implicit-any errors in mocks) — a fast-follow could include them. Full suite still 1505/0.
9. **Importance dual-write divergence (Task 6 review).** ✅ FIXED (2026-07-13). Store column `importance` is now the single source of truth. `resolveTier`/`resolveTierFromMeta` take an optional authoritative `importance` (used over the metadata mirror); the 4 call sites (access-tracker, retriever, auto-recall, data-checkup) pass `entry.importance`; `isDecayExempt` threads its column importance through. Rebalance (dream + `buildMemoryHealthRebalancePlan`) no longer writes/mirrors `importance` into metadata and strips any legacy copy; the `changed` flag dropped its now-obsolete `!("importance" in metadata)` backfill clause (which would have caused perpetual rewrites). Tests: `src/__tests__/importance-authority.test.ts` + memory-health-rebalance updates.
   ~~Was: rebalance dual-writes importance to column and metadata; decay-engine read the metadata copy, which goes stale on column-only writes.~~
10. **First-run importance migration (Task 6 review).** On mature stores, most active entries lack a metadata `importance`/`tier`, so early dream runs will rewrite importance into fixed bands, 200 entries per run, collapsing graded values toward band ranges. Accepted because dream is a manual, explicitly-invoked maintenance action (archive-not-delete, capped); revisit if dream ever becomes automatic — a feature flag would then be warranted. Pinned memories (importance ≥ 0.95) are fully excluded from rebalance.
