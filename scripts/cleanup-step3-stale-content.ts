/**
 * Cleanup step 3: flag/clean up stale content
 * Scans for memories containing temporary/临时/HACK/TODO/FIXME
 * Only deletes those with accessCount=0 that also contain these keywords
 * (stale content that has never been used)
 *
 * Usage:
 *   bun run scripts/cleanup-step3-stale-content.ts [--execute]
 */

import lancedb from "@lancedb/lancedb";

const DB_PATH = "./data/lancedb";
const TABLE_NAME = "memories";
const EXECUTE = process.argv.includes("--execute");

// NOTE: the Chinese entries are functional scan terms matched against memory
// text (临时=temporary, 废弃=deprecated, 待修复=to-fix) — do not translate.
const STALE_KEYWORDS = [
  "temporary", "临时", "HACK", "TODO", "FIXME",
  "workaround", "deprecated", "废弃", "待修复",
];

interface MemoryRow {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

async function main() {
  console.log(`\n🧹 Cleanup step 3: stale-content cleanup ${EXECUTE ? "[execute mode]" : "[preview mode]"}`);
  console.log("=".repeat(60));

  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  console.log("⏳ Loading all data...");
  const allRows: MemoryRow[] = await table
    .query()
    .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray() as any;

  const total = allRows.length;
  console.log(`✅ ${total.toLocaleString()} memories\n`);

  const parsedRows = allRows.map(row => ({
    ...row,
    meta: row.metadata ? JSON.parse(row.metadata) : {},
  }));

  // Scan for stale keywords
  const keywordHits = new Map<string, typeof parsedRows>();
  for (const kw of STALE_KEYWORDS) {
    keywordHits.set(kw, []);
  }

  for (const row of parsedRows) {
    const textLower = row.text.toLowerCase();
    for (const kw of STALE_KEYWORDS) {
      if (textLower.includes(kw.toLowerCase())) {
        keywordHits.get(kw)!.push(row);
      }
    }
  }

  console.log("📊 Keyword hit statistics:");
  let totalHits = 0;
  for (const kw of STALE_KEYWORDS) {
    const hits = keywordHits.get(kw)!;
    if (hits.length > 0) {
      const deadHits = hits.filter(r => (r.meta.accessCount ?? r.meta.access_count ?? 0) === 0);
      console.log(`  "${kw}": ${hits.length} entries (${deadHits.length} never accessed)`);
    }
  }

  // Collect: only delete if accessCount=0 (dead memory with stale keyword)
  const idsToDeleteSet = new Set<string>();
  const deleteCandidates: typeof parsedRows = [];

  for (const row of parsedRows) {
    const ac = row.meta.accessCount ?? row.meta.access_count ?? 0;
    if (ac > 0) continue; // keep anything that was ever accessed

    const textLower = row.text.toLowerCase();
    for (const kw of STALE_KEYWORDS) {
      if (textLower.includes(kw.toLowerCase())) {
        if (!idsToDeleteSet.has(row.id)) {
          idsToDeleteSet.add(row.id);
          deleteCandidates.push(row);
        }
        break;
      }
    }
  }

  const idsToDelete = [...idsToDeleteSet];

  console.log(`\n📊 Cleanup scope (only accessCount=0 + contains stale keywords):`);
  console.log(`  To delete:  ${idsToDelete.length.toLocaleString()}`);
  console.log(`  To keep:    ${(total - idsToDelete.length).toLocaleString()}`);
  console.log(`  Reduction:  ${(idsToDelete.length / total * 100).toFixed(1)}%`);

  // Category breakdown of what we're deleting
  const catBreakdown = new Map<string, number>();
  for (const row of deleteCandidates) {
    catBreakdown.set(row.category, (catBreakdown.get(row.category) || 0) + 1);
  }
  console.log(`\n  To delete, by category:`);
  for (const [cat, count] of [...catBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(14)} ${count}`);
  }

  // Show samples
  console.log(`\n  Deletion samples (10 random):`);
  const shuffled = deleteCandidates.sort(() => Math.random() - 0.5).slice(0, 10);
  for (const row of shuffled) {
    const matched = STALE_KEYWORDS.find(kw => row.text.toLowerCase().includes(kw.toLowerCase()));
    console.log(`    [${row.category}] [kw="${matched}"] ${row.text.slice(0, 80)}...`);
  }

  if (!EXECUTE) {
    console.log(`\n⚠️  Preview mode; no deletions performed. Pass --execute to run.`);
    return;
  }

  console.log(`\n🔥 Deleting ${idsToDelete.length.toLocaleString()} entries...`);
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize);
    const escaped = batch.map(id => id.replace(/'/g, "''"));
    const whereClause = `id IN (${escaped.map(id => `'${id}'`).join(",")})`;
    await table.delete(whereClause);
    deleted += batch.length;
    if (deleted % 500 === 0 || deleted === idsToDelete.length) {
      console.log(`  ✅ ${deleted.toLocaleString()} / ${idsToDelete.length.toLocaleString()}`);
    }
  }

  const remaining = await table.countRows();
  console.log(`\n✅ Deletion complete!`);
  console.log(`  Before: ${total.toLocaleString()} entries`);
  console.log(`  After:  ${remaining.toLocaleString()} entries`);
  console.log(`  Actually deleted: ${(total - remaining).toLocaleString()} entries`);
}

main().catch(console.error);
