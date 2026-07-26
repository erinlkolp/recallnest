/**
 * Fold case-variant scopes into their canonical lowercase form.
 *
 * matchesScopeFilter (scope-policy.ts) compares canonical scopes, so variants
 * union on read — but storage still holds two spellings, which splits stats,
 * scope-inventory, and memory_stats reporting. This script rewrites stored
 * scopes to the canonical form across all three layers that persist one:
 *
 *   - the `memories` LanceDB table
 *   - data/session-checkpoints/*.json   (`scope`)
 *   - data/workflow-observations/*.json (`scope`, `resolvedScope`)
 *
 * Only those scope fields are touched. Prose fields such as `summary` and
 * `task` legitimately mention repository names like "VU-Server" and are left
 * exactly as written.
 *
 * Default: preview only. Pass --execute to write.
 * DB path can be overridden with RECALLNEST_DB_PATH (default: ~/.recallnest/data/lancedb).
 * Data dir can be overridden with RECALLNEST_DATA_DIR (default: ./data).
 */

import lancedb from "@lancedb/lancedb";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const DB_PATH = process.env.RECALLNEST_DB_PATH ?? join(homedir(), ".recallnest", "data", "lancedb");
const DATA_DIR = process.env.RECALLNEST_DATA_DIR ?? resolve(import.meta.dir, "..", "data");
const TABLE_NAME = "memories";
const EXECUTE = process.argv.includes("--execute");
const SKIP_BACKUP = process.argv.includes("--skip-backup");

/** Scope fields that may be rewritten. Everything else is prose. */
const SCOPE_FIELDS = ["scope", "resolvedScope"] as const;

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

function canonical(scope: string): string {
  return scope.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function backupDb(): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join(homedir(), ".recallnest", "backups");
  await mkdir(root, { recursive: true });
  const dest = join(root, `lancedb-pre-scope-case-${ts}`);
  await cp(DB_PATH, dest, { recursive: true });
  return dest;
}

// ---------------------------------------------------------------------------
// Layer 1: memories table
// ---------------------------------------------------------------------------

async function migrateMemories(): Promise<{ planned: number; migrated: number; failed: number }> {
  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);
  const allRows = (await table.query().toArray()) as MemoryRow[];
  const targets = allRows.filter((r) => typeof r.scope === "string" && r.scope !== canonical(r.scope));

  console.log(`\n[memories] ${allRows.length} rows scanned, ${targets.length} need rewriting`);
  const groups = new Map<string, number>();
  for (const r of targets) {
    const key = `${r.scope} -> ${canonical(r.scope)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [k, v] of groups) console.log(`    ${k}  (${v} rows)`);

  if (!EXECUTE || targets.length === 0) return { planned: targets.length, migrated: 0, failed: 0 };

  let migrated = 0;
  let failed = 0;
  for (const row of targets) {
    // Mirrors MemoryStore.update, which hardcodes the original scope, so a
    // per-row delete + re-add is the only way to change it.
    const updated = {
      id: row.id,
      text: row.text,
      vector: Array.from(row.vector),
      category: row.category,
      scope: canonical(row.scope),
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: row.metadata ?? "{}",
      language: row.language ?? "en",
      fts_text: row.fts_text ?? row.text,
    };
    try {
      await table.delete(`id = '${escapeSqlLiteral(row.id)}'`);
      await table.add([updated]);
      migrated++;
    } catch (err) {
      failed++;
      console.error(`    FAIL ${String(row.id).slice(0, 8)}: ${(err as Error).message}`);
    }
  }
  console.log(`    migrated ${migrated}${failed ? `, failed ${failed}` : ""}`);
  return { planned: targets.length, migrated, failed };
}

// ---------------------------------------------------------------------------
// Layers 2 and 3: JSON sidecar files
// ---------------------------------------------------------------------------

async function migrateJsonDir(label: string, dir: string): Promise<{ planned: number; migrated: number }> {
  if (!existsSync(dir)) {
    console.log(`\n[${label}] directory not found, skipping: ${dir}`);
    return { planned: 0, migrated: 0 };
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const planned: Array<{ file: string; changes: string[]; next: Record<string, unknown> }> = [];

  for (const file of files) {
    const path = join(dir, file);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`    SKIP ${file}: not valid JSON`);
      continue;
    }

    const changes: string[] = [];
    const next = { ...parsed };
    for (const field of SCOPE_FIELDS) {
      const value = parsed[field];
      if (typeof value !== "string") continue;
      const canonicalValue = canonical(value);
      if (canonicalValue === value) continue;
      next[field] = canonicalValue;
      changes.push(`${field}: ${value} -> ${canonicalValue}`);
    }
    if (changes.length > 0) planned.push({ file, changes, next });
  }

  console.log(`\n[${label}] ${files.length} files scanned, ${planned.length} need rewriting`);
  for (const p of planned.slice(0, 8)) {
    console.log(`    ${p.file}`);
    for (const c of p.changes) console.log(`      ${c}`);
  }
  if (planned.length > 8) console.log(`    ... and ${planned.length - 8} more`);

  if (!EXECUTE || planned.length === 0) return { planned: planned.length, migrated: 0 };

  let migrated = 0;
  for (const p of planned) {
    await writeFile(join(dir, p.file), `${JSON.stringify(p.next, null, 2)}\n`, "utf8");
    migrated++;
  }
  console.log(`    migrated ${migrated}`);
  return { planned: planned.length, migrated };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\nScope case migration ${EXECUTE ? "[EXECUTE]" : "[PREVIEW]"}`);
  console.log(`DB path : ${DB_PATH}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log("=".repeat(60));

  if (EXECUTE && !SKIP_BACKUP) {
    console.log(`\nWriting backup...`);
    console.log(`  Backup: ${await backupDb()}`);
  } else if (EXECUTE) {
    console.log(`\n[--skip-backup] Backup skipped.`);
  }

  const memories = await migrateMemories();
  const checkpoints = await migrateJsonDir("session-checkpoints", join(DATA_DIR, "session-checkpoints"));
  const observations = await migrateJsonDir("workflow-observations", join(DATA_DIR, "workflow-observations"));

  const totalPlanned = memories.planned + checkpoints.planned + observations.planned;
  console.log("\n" + "=".repeat(60));
  if (!EXECUTE) {
    console.log(`Preview only. ${totalPlanned} record(s) would change. Re-run with --execute to apply.`);
    return;
  }
  console.log(`Done. Rewrote ${memories.migrated + checkpoints.migrated + observations.migrated} of ${totalPlanned} record(s).`);
  if (memories.failed > 0) console.log(`WARNING: ${memories.failed} memory row(s) failed.`);
}

await main();
