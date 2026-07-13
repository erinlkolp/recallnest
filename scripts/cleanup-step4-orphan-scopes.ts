/**
 * Cleanup step 4: analyze orphan scopes (scopes with only 1 memory)
 * Strategy: instead of deleting memories, reclassify orphan-scope memories into more meaningful scopes
 * - accessCount=0 orphans → delete outright (dead memory + orphan scope, doubly useless)
 * - accessCount>0 orphans → keep, report only (don't touch anything valuable)
 *
 * Usage:
 *   bun run scripts/cleanup-step4-orphan-scopes.ts [--execute]
 */

import lancedb from "@lancedb/lancedb";

const DB_PATH = "./data/lancedb";
const TABLE_NAME = "memories";
const EXECUTE = process.argv.includes("--execute");

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
  console.log(`\n🧹 Cleanup step 4: orphan-scope cleanup ${EXECUTE ? "[execute mode]" : "[preview mode]"}`);
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

  // Find orphan scopes (only 1 memory)
  const scopeCounts = new Map<string, number>();
  for (const row of parsedRows) {
    const s = row.scope || "(empty)";
    scopeCounts.set(s, (scopeCounts.get(s) || 0) + 1);
  }

  const orphanScopes = new Set(
    [...scopeCounts.entries()].filter(([, c]) => c === 1).map(([s]) => s)
  );

  const orphanRows = parsedRows.filter(r => orphanScopes.has(r.scope || "(empty)"));

  // Split: dead orphans vs alive orphans
  const deadOrphans = orphanRows.filter(r => (r.meta.accessCount ?? r.meta.access_count ?? 0) === 0);
  const aliveOrphans = orphanRows.filter(r => (r.meta.accessCount ?? r.meta.access_count ?? 0) > 0);

  console.log(`📊 Orphan scope statistics:`);
  console.log(`  Total orphan scopes:   ${orphanScopes.size}`);
  console.log(`  Dead-memory orphans:   ${deadOrphans.length} entries → safe to delete`);
  console.log(`  Live-memory orphans:   ${aliveOrphans.length} entries → keep untouched`);

  // Category breakdown
  const deadCatMap = new Map<string, number>();
  for (const r of deadOrphans) {
    deadCatMap.set(r.category, (deadCatMap.get(r.category) || 0) + 1);
  }
  console.log(`\n  Dead-memory orphans by category:`);
  for (const [cat, count] of [...deadCatMap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(14)} ${count}`);
  }

  // Show alive orphan samples (these we keep)
  if (aliveOrphans.length > 0) {
    console.log(`\n  Live-memory orphan samples (kept):`);
    for (const r of aliveOrphans.slice(0, 5)) {
      const ac = r.meta.accessCount ?? r.meta.access_count ?? 0;
      console.log(`    [${r.category}] [ac=${ac}] [scope=${r.scope.slice(0, 25)}] ${r.text.slice(0, 60)}...`);
    }
  }

  // Show dead orphan samples
  console.log(`\n  Dead-memory orphan samples (to delete):`);
  const samples = deadOrphans.sort(() => Math.random() - 0.5).slice(0, 10);
  for (const r of samples) {
    console.log(`    [${r.category}] [scope=${r.scope.slice(0, 25)}] ${r.text.slice(0, 60)}...`);
  }

  const idsToDelete = deadOrphans.map(r => r.id);

  console.log(`\n📊 Cleanup plan:`);
  console.log(`  To delete:  ${idsToDelete.length} entries (dead memory + orphan scope)`);
  console.log(`  To keep:    ${(total - idsToDelete.length).toLocaleString()} entries`);
  console.log(`  Reduction:  ${(idsToDelete.length / total * 100).toFixed(1)}%`);

  if (!EXECUTE) {
    console.log(`\n⚠️  Preview mode; no deletions performed. Pass --execute to run.`);
    return;
  }

  console.log(`\n🔥 Deleting ${idsToDelete.length} entries...`);
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize);
    const escaped = batch.map(id => id.replace(/'/g, "''"));
    const whereClause = `id IN (${escaped.map(id => `'${id}'`).join(",")})`;
    await table.delete(whereClause);
    deleted += batch.length;
    if (deleted % 100 === 0 || deleted === idsToDelete.length) {
      console.log(`  ✅ ${deleted} / ${idsToDelete.length}`);
    }
  }

  const remaining = await table.countRows();
  console.log(`\n✅ Deletion complete!`);
  console.log(`  Before: ${total.toLocaleString()} entries`);
  console.log(`  After:  ${remaining.toLocaleString()} entries`);
  console.log(`  Actually deleted: ${(total - remaining).toLocaleString()} entries`);
  console.log(`  Orphan scopes eliminated: ${deadOrphans.length}`);
}

main().catch(console.error);
