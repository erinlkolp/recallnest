/**
 * Cleanup step 1: delete exact-duplicate memories
 * For each duplicate group, keep the one with the highest accessCount and delete the rest
 *
 * Usage:
 *   bun run scripts/cleanup-step1-exact-dups.ts [--execute]
 *   Without --execute it only reports stats; with it, it actually deletes
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
  console.log(`\n🧹 Cleanup step 1: exact-duplicate deletion ${EXECUTE ? "[execute mode]" : "[preview mode]"}`);
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

  // Parse metadata
  const parsedRows = allRows.map(row => ({
    ...row,
    meta: row.metadata ? JSON.parse(row.metadata) : {},
  }));

  // Group by normalized text
  const textGroups = new Map<string, typeof parsedRows>();
  for (const row of parsedRows) {
    const key = row.text.trim().toLowerCase();
    if (!textGroups.has(key)) textGroups.set(key, []);
    textGroups.get(key)!.push(row);
  }

  // Find duplicates
  const dupGroups = [...textGroups.entries()].filter(([, rows]) => rows.length > 1);
  const idsToDelete: string[] = [];

  for (const [, rows] of dupGroups) {
    // Sort: highest accessCount first, then oldest timestamp as tiebreaker (keep oldest)
    rows.sort((a, b) => {
      const acA = a.meta.accessCount ?? a.meta.access_count ?? 0;
      const acB = b.meta.accessCount ?? b.meta.access_count ?? 0;
      if (acB !== acA) return acB - acA; // higher access first
      return a.timestamp - b.timestamp;  // older first
    });
    // Keep first, delete rest
    for (let i = 1; i < rows.length; i++) {
      idsToDelete.push(rows[i].id);
    }
  }

  console.log(`📊 Statistics:`);
  console.log(`  Duplicate groups:   ${dupGroups.length.toLocaleString()}`);
  console.log(`  To delete:          ${idsToDelete.length.toLocaleString()}`);
  console.log(`  To keep:            ${(total - idsToDelete.length).toLocaleString()}`);
  console.log(`  Reduction:          ${(idsToDelete.length / total * 100).toFixed(1)}%`);

  // Show top 10 largest duplicate groups
  const topGroups = dupGroups.sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  console.log(`\n  Top 10 duplicate groups:`);
  for (const [text, rows] of topGroups) {
    console.log(`    [×${rows.length}] ${text.slice(0, 70)}...`);
  }

  if (!EXECUTE) {
    console.log(`\n⚠️  Preview mode; no deletions performed. Pass --execute to run.`);
    return;
  }

  // Execute deletion in batches
  console.log(`\n🔥 Deleting ${idsToDelete.length.toLocaleString()} entries...`);
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize);
    // Build WHERE clause: id IN ('a', 'b', 'c')
    const escaped = batch.map(id => id.replace(/'/g, "''"));
    const whereClause = `id IN (${escaped.map(id => `'${id}'`).join(",")})`;
    await table.delete(whereClause);
    deleted += batch.length;
    if (deleted % 1000 === 0 || deleted === idsToDelete.length) {
      console.log(`  ✅ ${deleted.toLocaleString()} / ${idsToDelete.length.toLocaleString()}`);
    }
  }

  // Verify
  const remaining = await table.countRows();
  console.log(`\n✅ Deletion complete!`);
  console.log(`  Before: ${total.toLocaleString()} entries`);
  console.log(`  After:  ${remaining.toLocaleString()} entries`);
  console.log(`  Actually deleted: ${(total - remaining).toLocaleString()} entries`);
}

main().catch(console.error);
