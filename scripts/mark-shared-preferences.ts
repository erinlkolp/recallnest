/**
 * Mark genuinely-global preferences with `privacyTier: "shared"`.
 *
 * selectStableResults (src/context-composer-stable-selection.ts) now applies a
 * hard scope gate to every stable category, so a preference stored under one
 * project no longer bleeds into another project's resume_context. That is the
 * correct default, but several of Erin's stored preferences are general rules
 * that merely happened to be captured during project work — they say so in
 * their own text ("and generally", "in Erin's project docs", "anything to be
 * posted publicly under their name").
 *
 * `privacyTier: "shared"` is the supported cross-scope escape hatch, so those
 * rows are tagged here rather than duplicated per project.
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

/** Memory IDs whose text states a rule that applies beyond its stored scope. */
const SHARED_PREFERENCE_IDS: ReadonlyArray<{ id: string; why: string }> = [
  {
    id: "10b0b3c0-6a4a-589e-b014-4acd0890753f",
    why: "Keeping personal identifiers out of public repos — a policy, with the Glass Reddit client only as the example.",
  },
  {
    id: "cdaf621d-565d-438a-623a-7c46cc6d7df6",
    why: "Direct, unhedged status language — explicitly generalized to \"Erin's project docs\".",
  },
  {
    id: "cd8e6300-446a-4f70-6580-e736f5dfb9b5",
    why: "Attribution rule for \"anything to be posted publicly under their name\" — not VU-Server specific.",
  },
  {
    id: "4da987f6-6655-f888-e340-928a66d71e34",
    why: "Engineering workflow preferences — the text itself says \"on VU-Server (and generally)\".",
  },
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
  const dest = join(root, `lancedb-pre-shared-tier-${ts}`);
  await cp(DB_PATH, dest, { recursive: true });
  return dest;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function withSharedTier(metadata: string | undefined): string {
  let parsed: Record<string, unknown> = {};
  if (metadata) {
    try {
      const candidate: unknown = JSON.parse(metadata);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // Malformed metadata: start from an empty object rather than losing the write.
    }
  }
  parsed.privacyTier = "shared";
  return JSON.stringify(parsed);
}

async function main(): Promise<void> {
  console.log(`\nMark shared preferences ${EXECUTE ? "[EXECUTE]" : "[PREVIEW]"}`);
  console.log(`DB path: ${DB_PATH}`);
  console.log("=".repeat(60));

  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  const wanted = new Map(SHARED_PREFERENCE_IDS.map((e) => [e.id, e.why] as const));
  const allRows = (await table.query().toArray()) as MemoryRow[];
  const targets = allRows.filter((r) => wanted.has(r.id));

  const missing = [...wanted.keys()].filter((id) => !targets.some((r) => r.id === id));
  for (const id of missing) {
    console.warn(`  WARN: ${id.slice(0, 8)} not found — skipping.`);
  }

  const pending = targets.filter((r) => {
    try {
      return (JSON.parse(r.metadata ?? "{}") as { privacyTier?: string }).privacyTier !== "shared";
    } catch {
      return true;
    }
  });

  console.log(`\nRows to tag: ${pending.length} (of ${targets.length} matched)`);
  for (const r of pending) {
    console.log(`  ${r.id.slice(0, 8)} [${r.scope}]`);
    console.log(`      ${wanted.get(r.id)}`);
  }

  if (pending.length === 0) {
    console.log("\nNothing to do.");
    return;
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

  console.log(`\nTagging ${pending.length} rows (delete + re-add per row)...`);
  let tagged = 0;
  let failed = 0;
  for (const row of pending) {
    const updated = {
      id: row.id,
      text: row.text,
      vector: Array.from(row.vector),
      category: row.category,
      scope: row.scope,
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: withSharedTier(row.metadata),
      language: row.language ?? "en",
      fts_text: row.fts_text ?? row.text,
    };
    try {
      await table.delete(`id = '${escapeSqlLiteral(row.id)}'`);
      await table.add([updated]);
      tagged++;
    } catch (err) {
      failed++;
      console.error(`  FAIL ${row.id.slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Rows total: ${await table.countRows()}`);
  console.log(`  Tagged:     ${tagged}`);
  if (failed > 0) console.log(`  Failed:     ${failed}`);

  const verify = (await table.query().toArray()) as MemoryRow[];
  const stillPending = verify.filter(
    (r) => wanted.has(r.id) &&
      (JSON.parse(r.metadata ?? "{}") as { privacyTier?: string }).privacyTier !== "shared",
  );
  console.log(
    stillPending.length === 0
      ? "  Verified: all target preferences carry privacyTier=shared."
      : `  WARNING: ${stillPending.length} row(s) still untagged.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
