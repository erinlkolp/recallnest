/**
 * Collapse rows that share the same `id` down to a single row.
 *
 * LanceDB does not enforce a primary key, so an append can land a second row
 * with an id that already exists. Once that happens the duplicate is
 * self-perpetuating: every write path uses
 * `.mergeInsert("id").whenMatchedUpdateAll()`, which updates *every* matching
 * row rather than collapsing them, so ordinary writes never heal it. This is
 * the data-side repair.
 *
 * The write paths no longer create duplicates (store.ts store/storeBatch/
 * importEntry upsert on id), so this script is for cleaning up rows that
 * predate that fix, or that a script wrote via delete + re-add.
 *
 * This is NOT the same job as scripts/cleanup-step1-exact-dups.ts. That script
 * groups by identical text and keeps the oldest / most-accessed copy. Same-id
 * rows are versions of one logical memory and the newer row is usually a
 * correction of the older one, so the default here keeps the NEWEST.
 *
 * Repair strategy: `table.delete("id = '...'")` removes every row with that id,
 * so the losers cannot be deleted individually. Each group is repaired by
 * deleting the id outright and re-adding the single keeper.
 *
 * Default: preview only. Pass --execute to write.
 *   bun run scripts/cleanup-duplicate-ids.ts
 *   bun run scripts/cleanup-duplicate-ids.ts --execute
 *   bun run scripts/cleanup-duplicate-ids.ts --keep=oldest --execute
 *
 * DB path can be overridden with RECALLNEST_DB_PATH (default: ~/.recallnest/data/lancedb).
 */

import lancedb from "@lancedb/lancedb";
import { homedir } from "node:os";
import { join } from "node:path";
import { cp, mkdir } from "node:fs/promises";

const DB_PATH = process.env.RECALLNEST_DB_PATH ?? join(homedir(), ".recallnest", "data", "lancedb");
const TABLE_NAME = "memories";
const EXECUTE = process.argv.includes("--execute");
const SKIP_BACKUP = process.argv.includes("--skip-backup");

export type KeepStrategy = "newest" | "oldest" | "access";

const KEEP_STRATEGIES: readonly KeepStrategy[] = ["newest", "oldest", "access"];

function parseKeepStrategy(argv: readonly string[]): KeepStrategy {
  const flag = argv.find((a) => a.startsWith("--keep="));
  if (!flag) return "newest";
  const value = flag.slice("--keep=".length);
  if (!KEEP_STRATEGIES.includes(value as KeepStrategy)) {
    throw new Error(`Invalid --keep=${value}. Expected one of: ${KEEP_STRATEGIES.join(", ")}`);
  }
  return value as KeepStrategy;
}

/** A row as it comes back from LanceDB, before normalization. */
export interface RawMemoryRow {
  id: string;
  text: string;
  vector: Iterable<number>;
  category: string;
  scope: string;
  importance: number | bigint;
  timestamp: number | bigint;
  metadata?: string;
  language?: string;
  fts_text?: string;
}

/** A row normalized to the exact 10-column table schema, safe to re-add. */
export interface MemoryRow {
  id: string;
  text: string;
  vector: number[];
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
  language: string;
  fts_text: string;
}

export interface DuplicateGroup {
  id: string;
  keeper: MemoryRow;
  discarded: MemoryRow[];
}

export function normalizeRow(row: RawMemoryRow): MemoryRow {
  const text = row.text ?? "";
  return {
    id: row.id,
    text,
    vector: Array.from(row.vector ?? []),
    category: row.category,
    scope: row.scope,
    importance: Number(row.importance),
    timestamp: Number(row.timestamp),
    metadata: row.metadata ?? "{}",
    language: row.language ?? "en",
    fts_text: row.fts_text ?? text,
  };
}

function accessCountOf(row: MemoryRow): number {
  try {
    const meta = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
    const raw = meta.accessCount ?? meta.access_count ?? 0;
    return typeof raw === "number" ? raw : 0;
  } catch {
    return 0;
  }
}

/**
 * Order a same-id group so the keeper sorts first. Ties fall through to
 * accessCount, then to the longer text, so a truncated write never wins over a
 * complete one, and finally to a stable id/text compare so a rerun on
 * unchanged data always picks the same keeper.
 */
export function orderGroup(rows: readonly MemoryRow[], keep: KeepStrategy): MemoryRow[] {
  return [...rows].sort((a, b) => {
    if (keep === "access") {
      const diff = accessCountOf(b) - accessCountOf(a);
      if (diff !== 0) return diff;
    }
    if (a.timestamp !== b.timestamp) {
      return keep === "oldest" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp;
    }
    const byAccess = accessCountOf(b) - accessCountOf(a);
    if (byAccess !== 0) return byAccess;
    if (a.text.length !== b.text.length) return b.text.length - a.text.length;
    return a.text.localeCompare(b.text);
  });
}

/** Group rows by id and return only the ids that appear more than once. */
export function planDedup(rows: readonly MemoryRow[], keep: KeepStrategy): DuplicateGroup[] {
  const byId = new Map<string, MemoryRow[]>();
  for (const row of rows) {
    const group = byId.get(row.id);
    if (group) group.push(row);
    else byId.set(row.id, [row]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const [keeper, ...discarded] = orderGroup(group, keep);
    groups.push({ id, keeper: keeper!, discarded });
  }
  // Largest groups first so the preview surfaces the worst offenders.
  return groups.sort((a, b) => b.discarded.length - a.discarded.length);
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function backup(): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join(homedir(), ".recallnest", "backups");
  await mkdir(root, { recursive: true });
  const dest = join(root, `lancedb-pre-dup-id-cleanup-${ts}`);
  await cp(DB_PATH, dest, { recursive: true });
  return dest;
}

function preview(row: MemoryRow): string {
  return row.text.replace(/\s+/g, " ").slice(0, 68);
}

async function main(): Promise<void> {
  const keep = parseKeepStrategy(process.argv);

  console.log(`\nDuplicate-ID cleanup ${EXECUTE ? "[EXECUTE]" : "[PREVIEW]"}`);
  console.log(`DB path : ${DB_PATH}`);
  console.log(`Keep    : ${keep}`);
  console.log("=".repeat(72));

  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  const totalBefore = await table.countRows();
  const rows = ((await table.query().toArray()) as RawMemoryRow[]).map(normalizeRow);
  const groups = planDedup(rows, keep);
  const excess = groups.reduce((sum, g) => sum + g.discarded.length, 0);

  console.log(`\nTotal rows       : ${totalBefore}`);
  console.log(`Distinct ids     : ${totalBefore - excess}`);
  console.log(`Duplicated ids   : ${groups.length}`);
  console.log(`Rows to remove   : ${excess}`);

  if (groups.length === 0) {
    console.log("\nNo duplicate ids. Nothing to do.");
    return;
  }

  console.log(`\nGroups:`);
  for (const g of groups) {
    console.log(`\n  ${g.id}  (${g.discarded.length + 1} rows, ${g.keeper.scope})`);
    console.log(`    KEEP  ${new Date(g.keeper.timestamp).toISOString()} | ${preview(g.keeper)}`);
    for (const d of g.discarded) {
      console.log(`    DROP  ${new Date(d.timestamp).toISOString()} | ${preview(d)}`);
    }
    // A same-id group whose rows differ in text is a lost update, not a
    // harmless double-write; call it out so the choice gets a human look.
    const distinctTexts = new Set(
      [g.keeper, ...g.discarded].map((r) => r.text.trim().toLowerCase())
    );
    if (distinctTexts.size > 1) {
      console.log(`    NOTE  rows differ in content — dropped text is discarded, not merged.`);
    }
  }

  if (!EXECUTE) {
    console.log(`\nPreview only. Re-run with --execute to apply.`);
    return;
  }

  if (!SKIP_BACKUP) {
    console.log(`\nWriting backup...`);
    console.log(`  Backup: ${await backup()}`);
  } else {
    console.log(`\n[--skip-backup] Backup skipped.`);
  }

  console.log(`\nCollapsing ${groups.length} duplicated ids...`);
  let repaired = 0;
  let failed = 0;
  for (const g of groups) {
    try {
      // delete() drops every row sharing this id, keeper included, so the
      // keeper has to be written back immediately afterwards.
      await table.delete(`id = '${escapeSqlLiteral(g.id)}'`);
      await table.add([g.keeper] as unknown as Record<string, unknown>[]);
      repaired++;
    } catch (err) {
      failed++;
      console.error(`  FAIL ${g.id}: ${(err as Error).message}`);
    }
  }

  const totalAfter = await table.countRows();
  console.log(`\nDone.`);
  console.log(`  Rows before : ${totalBefore}`);
  console.log(`  Rows after  : ${totalAfter}`);
  console.log(`  Ids repaired: ${repaired}`);
  if (failed > 0) console.log(`  Failed      : ${failed}`);

  const verifyRows = ((await table.query().select(["id"]).toArray()) as { id: string }[]);
  const lingering = planDedup(
    verifyRows.map((r) => ({ ...normalizeRow({ ...r } as RawMemoryRow), id: r.id })),
    keep
  );
  if (lingering.length > 0) {
    console.log(`  WARNING: ${lingering.length} duplicated ids remain.`);
  } else {
    console.log(`  Verified: every id is unique.`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
