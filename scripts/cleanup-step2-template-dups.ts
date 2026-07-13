/**
 * Cleanup step 2: delete templated duplicate content
 * For memories sharing the same first 100 chars, keep the 1 with the highest accessCount per group
 * (Step 1 already removed exact duplicates; this catches "near-duplicates" — the same content
 *  stored multiple times at different lengths)
 *
 * Usage:
 *   bun run scripts/cleanup-step2-template-dups.ts [--execute]
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
  console.log(`\n🧹 Cleanup step 2: templated-duplicate deletion ${EXECUTE ? "[execute mode]" : "[preview mode]"}`);
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

  // Group by first 100 chars (normalized)
  const fpGroups = new Map<string, typeof parsedRows>();
  for (const row of parsedRows) {
    const fp = row.text.trim().slice(0, 100).toLowerCase();
    if (!fpGroups.has(fp)) fpGroups.set(fp, []);
    fpGroups.get(fp)!.push(row);
  }

  // Find groups with duplicates (after step 1, exact dups are gone, so these are near-dups)
  const dupGroups = [...fpGroups.entries()].filter(([, rows]) => rows.length > 1);
  const idsToDelete: string[] = [];

  for (const [, rows] of dupGroups) {
    // Keep the one with highest accessCount, then longest text, then oldest
    rows.sort((a, b) => {
      const acA = a.meta.accessCount ?? a.meta.access_count ?? 0;
      const acB = b.meta.accessCount ?? b.meta.access_count ?? 0;
      if (acB !== acA) return acB - acA;
      if (b.text.length !== a.text.length) return b.text.length - a.text.length; // longer is more complete
      return a.timestamp - b.timestamp;
    });
    for (let i = 1; i < rows.length; i++) {
      idsToDelete.push(rows[i].id);
    }
  }

  console.log(`📊 Statistics:`);
  console.log(`  Near-duplicate groups:  ${dupGroups.length.toLocaleString()}`);
  console.log(`  To delete:              ${idsToDelete.length.toLocaleString()}`);
  console.log(`  To keep:                ${(total - idsToDelete.length).toLocaleString()}`);
  console.log(`  Reduction:              ${(idsToDelete.length / total * 100).toFixed(1)}%`);

  // Show top 15 largest groups
  const topGroups = dupGroups.sort((a, b) => b[1].length - a[1].length).slice(0, 15);
  console.log(`\n  Top 15 near-duplicate groups:`);
  for (const [fp, rows] of topGroups) {
    console.log(`    [×${rows.length.toString().padStart(3)}] ${fp.slice(0, 65)}...`);
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
