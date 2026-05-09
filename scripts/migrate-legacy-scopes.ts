/**
 * Migrate legacy non-`project:*` scopes to the project:* convention so
 * scope filters behave consistently. matchesScopeFilter (scope-policy.ts:43)
 * does exact equality when the filter contains `:` and prefix-match otherwise,
 * which means `recallnest` and `project:recallnest` are two disjoint buckets.
 * This script unifies them.
 *
 * Default: preview only. Pass --execute to write.
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

const RULES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "recallnest", to: "project:recallnest" },
  { from: "memory", to: "project:discord-mcp" },
  { from: "openpets", to: "project:openpets" },
];

interface MemoryRow {
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

async function backup(): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join(homedir(), ".recallnest", "backups");
  await mkdir(root, { recursive: true });
  const dest = join(root, `lancedb-pre-scope-migrate-${ts}`);
  await cp(DB_PATH, dest, { recursive: true });
  return dest;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function main(): Promise<void> {
  console.log(`\nLegacy scope migration ${EXECUTE ? "[EXECUTE]" : "[PREVIEW]"}`);
  console.log(`DB path: ${DB_PATH}`);
  console.log("=".repeat(60));

  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  const totalBefore = await table.countRows();
  console.log(`Total rows: ${totalBefore}`);

  const ruleByFrom = new Map(RULES.map((r) => [r.from, r.to] as const));
  const allRows = (await table.query().toArray()) as MemoryRow[];
  const targets = allRows.filter((r) => ruleByFrom.has(r.scope));

  console.log(`\nProposed migrations:`);
  const groups = new Map<string, number>();
  for (const r of targets) {
    const key = `  ${r.scope.padEnd(15)} -> ${ruleByFrom.get(r.scope)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [k, v] of groups) console.log(`${k}  (${v} rows)`);
  console.log(`\nRows to migrate: ${targets.length}`);

  if (targets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  console.log(`\nSample (first 5):`);
  for (const r of targets.slice(0, 5)) {
    const txt = r.text.replace(/\s+/g, " ").slice(0, 80);
    console.log(`  ${String(r.id).slice(0, 8)} [${r.category}] ${r.scope} -> ${ruleByFrom.get(r.scope)} | ${txt}`);
  }

  if (!EXECUTE) {
    console.log(`\nPreview only. Re-run with --execute to apply.`);
    return;
  }

  if (!SKIP_BACKUP) {
    console.log(`\nWriting backup...`);
    const dest = await backup();
    console.log(`  Backup: ${dest}`);
  } else {
    console.log(`\n[--skip-backup] Backup skipped.`);
  }

  console.log(`\nMigrating ${targets.length} rows (delete + re-add per row)...`);
  let migrated = 0;
  let failed = 0;
  for (const row of targets) {
    const newScope = ruleByFrom.get(row.scope)!;
    const updated = {
      id: row.id,
      text: row.text,
      vector: Array.from(row.vector),
      category: row.category,
      scope: newScope,
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: row.metadata ?? "{}",
      language: row.language ?? "en",
      fts_text: row.fts_text ?? row.text,
    };
    try {
      const safeId = escapeSqlLiteral(row.id);
      await table.delete(`id = '${safeId}'`);
      await table.add([updated]);
      migrated++;
      if (migrated % 5 === 0 || migrated === targets.length) {
        console.log(`  ${migrated} / ${targets.length}`);
      }
    } catch (err) {
      failed++;
      console.error(`  FAIL ${String(row.id).slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  const totalAfter = await table.countRows();
  console.log(`\nDone.`);
  console.log(`  Rows before: ${totalBefore}`);
  console.log(`  Rows after:  ${totalAfter}`);
  console.log(`  Migrated:    ${migrated}`);
  if (failed > 0) console.log(`  Failed:      ${failed}`);

  const verifyRows = (await table.query().toArray()) as MemoryRow[];
  const lingering = verifyRows.filter((r) => ruleByFrom.has(r.scope));
  if (lingering.length > 0) {
    console.log(`  WARNING: ${lingering.length} rows still on legacy scope after migration.`);
  } else {
    console.log(`  Verified: no legacy scopes remain.`);
  }

  const newCounts = new Map<string, number>();
  for (const r of verifyRows) {
    newCounts.set(r.scope, (newCounts.get(r.scope) ?? 0) + 1);
  }
  console.log(`\nFinal scope distribution:`);
  for (const [k, v] of [...newCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
