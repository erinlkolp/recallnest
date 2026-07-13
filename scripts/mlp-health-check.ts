/**
 * memory-lancedb-pro generic memory health-check script
 * Read-only analysis of LanceDB data; writes nothing
 * Compatible with both RecallNest (camelCase) and memory-lancedb-pro (snake_case) metadata formats
 *
 * Usage:
 *   bun run scripts/mlp-health-check.ts <lancedb-dir> [bot-name]
 *
 * Examples:
 *   bun run scripts/mlp-health-check.ts /tmp/mlp-healthcheck/antigravity/lancedb-pro AntiBot
 *   bun run scripts/mlp-health-check.ts ./data/lancedb RecallNest
 */

import lancedb from "@lancedb/lancedb";

const DB_PATH = process.argv[2] || "./data/lancedb";
const BOT_NAME = process.argv[3] || "Unnamed";
const TABLE_NAME = "memories";

interface MemoryRow {
  id: string;
  text: string;
  vector: number[];
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

/** Compatible with camelCase (RecallNest) and snake_case (memory-lancedb-pro) */
function getAccessCount(meta: Record<string, any>): number {
  return meta.accessCount ?? meta.access_count ?? 0;
}

function getLastAccessed(meta: Record<string, any>): number {
  return meta.lastAccessedAt ?? meta.last_accessed_at ?? 0;
}

function getTier(meta: Record<string, any>): string {
  return meta.tier ?? "unknown";
}

function getSource(meta: Record<string, any>): string {
  return meta.source ?? meta.source_session ?? "";
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function percentBar(pct: number, width = 30): string {
  const filled = Math.round(pct / 100 * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function main() {
  console.log(`\n🏥 Memory health-check report — ${BOT_NAME}`);
  console.log("=".repeat(60));
  console.log(`📅 Checked at: ${new Date().toISOString().slice(0, 19)}`);
  console.log(`📂 Data path: ${DB_PATH}\n`);

  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  // Fetch all rows (without vectors first for speed)
  console.log("⏳ Loading all data...");
  const allRows: MemoryRow[] = await table
    .query()
    .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray() as any;

  const total = allRows.length;
  if (total === 0) {
    console.log("⚠️  Memory store is empty; no data to analyze.");
    return;
  }
  console.log(`✅ Loaded: ${total.toLocaleString()} memories\n`);

  // Parse metadata once
  const parsedRows = allRows.map(row => ({
    ...row,
    meta: row.metadata ? JSON.parse(row.metadata) : {},
  }));

  // ============================================
  // 1. Category distribution
  // ============================================
  console.log("📊 1. Category distribution");
  console.log("-".repeat(60));
  const catMap = new Map<string, number>();
  for (const row of parsedRows) {
    catMap.set(row.category, (catMap.get(row.category) || 0) + 1);
  }
  const catSorted = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of catSorted) {
    const pct = (count / total * 100).toFixed(1);
    console.log(`  ${cat.padEnd(14)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 2. Tier distribution
  // ============================================
  console.log("\n📊 2. Tier distribution");
  console.log("-".repeat(60));
  const tierMap = new Map<string, number>();
  for (const row of parsedRows) {
    const tier = getTier(row.meta);
    tierMap.set(tier, (tierMap.get(tier) || 0) + 1);
  }
  const tierSorted = [...tierMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [tier, count] of tierSorted) {
    const pct = (count / total * 100).toFixed(1);
    console.log(`  ${tier.padEnd(14)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 3. Dead-memory analysis
  // ============================================
  console.log("\n📊 3. Dead-memory analysis (accessCount = 0 or no record)");
  console.log("-".repeat(60));
  let deadCount = 0;
  let aliveCount = 0;
  let totalAccess = 0;
  let maxAccess = 0;
  let maxAccessText = "";
  const accessDistribution = new Map<string, number>();

  for (const row of parsedRows) {
    const ac = getAccessCount(row.meta);
    totalAccess += ac;

    if (ac === 0) deadCount++;
    else aliveCount++;

    if (ac > maxAccess) {
      maxAccess = ac;
      maxAccessText = row.text.slice(0, 80);
    }

    let bucket: string;
    if (ac === 0) bucket = "0 (dead)";
    else if (ac <= 2) bucket = "1-2";
    else if (ac <= 5) bucket = "3-5";
    else if (ac <= 10) bucket = "6-10";
    else if (ac <= 50) bucket = "11-50";
    else bucket = "50+";
    accessDistribution.set(bucket, (accessDistribution.get(bucket) || 0) + 1);
  }

  const deadPct = (deadCount / total * 100).toFixed(1);
  const alivePct = (aliveCount / total * 100).toFixed(1);
  console.log(`  Dead:     ${deadCount.toLocaleString()} / ${total.toLocaleString()}  (${deadPct}%)`);
  console.log(`  Alive:    ${aliveCount.toLocaleString()} / ${total.toLocaleString()}  (${alivePct}%)`);
  console.log(`  Total accesses: ${totalAccess.toLocaleString()}`);
  console.log(`  Avg accesses:   ${(totalAccess / total).toFixed(2)} per entry`);
  if (maxAccess > 0) {
    console.log(`  Hottest memory: [${maxAccess} accesses] ${maxAccessText}...`);
  }

  console.log("\n  Access-count distribution:");
  const bucketOrder = ["0 (dead)", "1-2", "3-5", "6-10", "11-50", "50+"];
  for (const bucket of bucketOrder) {
    const count = accessDistribution.get(bucket) || 0;
    const pct = (count / total * 100).toFixed(1);
    console.log(`    ${bucket.padEnd(14)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 4. Importance distribution
  // ============================================
  console.log("\n📊 4. Importance distribution");
  console.log("-".repeat(60));
  const impBuckets = new Map<string, number>();
  let impSum = 0;
  for (const row of parsedRows) {
    const imp = row.importance || 0;
    impSum += imp;
    let bucket: string;
    if (imp < 0.2) bucket = "0.0-0.2 (low)";
    else if (imp < 0.4) bucket = "0.2-0.4";
    else if (imp < 0.6) bucket = "0.4-0.6 (mid)";
    else if (imp < 0.8) bucket = "0.6-0.8";
    else bucket = "0.8-1.0 (high)";
    impBuckets.set(bucket, (impBuckets.get(bucket) || 0) + 1);
  }
  console.log(`  Avg importance: ${(impSum / total).toFixed(3)}`);
  const impOrder = ["0.0-0.2 (low)", "0.2-0.4", "0.4-0.6 (mid)", "0.6-0.8", "0.8-1.0 (high)"];
  for (const bucket of impOrder) {
    const count = impBuckets.get(bucket) || 0;
    const pct = (count / total * 100).toFixed(1);
    console.log(`    ${bucket.padEnd(16)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 5. Scope distribution
  // ============================================
  console.log("\n📊 5. Scope distribution");
  console.log("-".repeat(60));
  const scopeMap = new Map<string, number>();
  for (const row of parsedRows) {
    const s = row.scope || "(empty)";
    scopeMap.set(s, (scopeMap.get(s) || 0) + 1);
  }
  const scopeSorted = [...scopeMap.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  Unique scopes: ${scopeMap.size}`);
  console.log("  Top 10:");
  for (const [scope, count] of scopeSorted.slice(0, 10)) {
    const pct = (count / total * 100).toFixed(1);
    const label = scope.length > 30 ? scope.slice(0, 27) + "..." : scope;
    console.log(`    ${label.padEnd(32)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)`);
  }

  // ============================================
  // 6. Age distribution
  // ============================================
  console.log("\n📊 6. Age distribution");
  console.log("-".repeat(60));
  const now = Date.now();
  const ageBuckets = new Map<string, number>();
  let oldest = Infinity, newest = 0;
  for (const row of parsedRows) {
    const ts = row.timestamp;
    if (ts < oldest) oldest = ts;
    if (ts > newest) newest = ts;
    const ageHours = (now - ts) / (1000 * 60 * 60);
    let bucket: string;
    if (ageHours < 24) bucket = "< 1 day";
    else if (ageHours < 24 * 7) bucket = "1-7 days";
    else if (ageHours < 24 * 30) bucket = "7-30 days";
    else if (ageHours < 24 * 90) bucket = "30-90 days";
    else bucket = "> 90 days";
    ageBuckets.set(bucket, (ageBuckets.get(bucket) || 0) + 1);
  }
  console.log(`  Oldest: ${formatDate(oldest)}`);
  console.log(`  Newest: ${formatDate(newest)}`);
  const ageOrder = ["< 1 day", "1-7 days", "7-30 days", "30-90 days", "> 90 days"];
  for (const bucket of ageOrder) {
    const count = ageBuckets.get(bucket) || 0;
    const pct = (count / total * 100).toFixed(1);
    console.log(`    ${bucket.padEnd(12)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 7. Near-duplicate detection (sampled)
  // ============================================
  const sampleSize = Math.min(500, total);
  console.log(`\n📊 7. Near-duplicate detection (${sampleSize}-entry sample, cosine > 0.95)`);
  console.log("-".repeat(60));
  console.log("  ⏳ Loading vector data (sample)...");

  const sampleRows: MemoryRow[] = await table
    .query()
    .select(["id", "text", "vector", "category"])
    .limit(sampleSize)
    .toArray() as any;

  let dupPairs = 0;
  const dupExamples: Array<{sim: number, textA: string, textB: string}> = [];

  for (let i = 0; i < sampleRows.length; i++) {
    for (let j = i + 1; j < sampleRows.length; j++) {
      if (sampleRows[i].vector && sampleRows[j].vector) {
        const sim = cosineSimilarity(sampleRows[i].vector, sampleRows[j].vector);
        if (sim > 0.95) {
          dupPairs++;
          if (dupExamples.length < 3) {
            dupExamples.push({
              sim,
              textA: sampleRows[i].text.slice(0, 60),
              textB: sampleRows[j].text.slice(0, 60),
            });
          }
        }
      }
    }
  }

  const totalPairs = sampleSize * (sampleSize - 1) / 2;
  const dupRate = (dupPairs / totalPairs * 100).toFixed(3);
  console.log(`  Sampled pairs:  ${totalPairs.toLocaleString()}`);
  console.log(`  High-similarity pairs: ${dupPairs} (${dupRate}%)`);
  if (total > sampleSize) {
    console.log(`  Extrapolated:   ~${Math.round(dupPairs / totalPairs * total * (total-1) / 2).toLocaleString()} potential duplicate pairs full-db`);
  }

  if (dupExamples.length > 0) {
    console.log("\n  Sample duplicate pairs:");
    for (const ex of dupExamples) {
      console.log(`    [sim=${ex.sim.toFixed(3)}]`);
      console.log(`      A: ${ex.textA}...`);
      console.log(`      B: ${ex.textB}...`);
    }
  }

  // ============================================
  // 8. Overall diagnosis
  // ============================================
  console.log("\n" + "=".repeat(60));
  console.log(`🩺 Overall diagnosis — ${BOT_NAME}`);
  console.log("=".repeat(60));

  const issues: string[] = [];
  const healthy: string[] = [];

  // Total count check
  if (total < 10) {
    issues.push(`🟡 Only ${total} memories total; low data volume`);
  } else {
    healthy.push(`✅ ${total.toLocaleString()} memories total`);
  }

  // Dead memory ratio
  const deadRatio = deadCount / total;
  if (deadRatio > 0.9) {
    issues.push(`🔴 ${deadPct}% of memories never accessed (dead-memory rate too high)`);
  } else if (deadRatio > 0.7) {
    issues.push(`🟡 ${deadPct}% of memories never accessed (dead-memory rate elevated)`);
  } else {
    healthy.push(`✅ Dead-memory rate ${deadPct}% is within a reasonable range`);
  }

  // Category balance — check if any single legacy category dominates
  const factCount = catMap.get("fact") || 0;
  const decisionCount = catMap.get("decision") || 0;
  const legacyRatio = (factCount + decisionCount) / total;
  if (legacyRatio > 0.5) {
    issues.push(`🟡 Legacy categories (fact/decision) are ${(legacyRatio*100).toFixed(1)}%; consider migrating to the 6-category system`);
  }
  // Check structural category coverage
  const structuredCount = (catMap.get("entities") || 0) + (catMap.get("patterns") || 0) + (catMap.get("cases") || 0);
  if (structuredCount === 0 && total > 20) {
    issues.push(`🟡 No structured memories (entities/patterns/cases all 0)`);
  } else if (structuredCount > 0) {
    healthy.push(`✅ ${structuredCount} structured memories (entities+patterns+cases)`);
  }

  // Tier distribution
  const coreCount = tierMap.get("core") || 0;
  const unknownTier = tierMap.get("unknown") || 0;
  if (unknownTier / total > 0.5) {
    issues.push(`🟡 ${(unknownTier/total*100).toFixed(1)}% of memories have no tier tag`);
  }
  if (coreCount < 5 && total > 50) {
    issues.push(`🟡 Only ${coreCount} entries in core tier; too few high-value memories`);
  } else if (coreCount >= 5) {
    healthy.push(`✅ Core tier has ${coreCount} high-value memories`);
  }

  // Importance differentiation
  const modeImpBucket = [...impBuckets.entries()].sort((a, b) => b[1] - a[1])[0];
  if (modeImpBucket && modeImpBucket[1] / total > 0.9) {
    issues.push(`🟡 ${(modeImpBucket[1]/total*100).toFixed(1)}% of importance is concentrated in ${modeImpBucket[0]}; insufficient differentiation`);
  } else {
    healthy.push(`✅ Importance distribution shows differentiation`);
  }

  // Dup rate
  if (parseFloat(dupRate) > 1) {
    issues.push(`🟡 Sampled duplicate rate ${dupRate}%; the full db may contain many near-duplicates`);
  } else {
    healthy.push(`✅ Sampled duplicate rate ${dupRate}%; duplication is under control`);
  }

  for (const h of healthy) console.log(`  ${h}`);
  for (const i of issues) console.log(`  ${i}`);

  console.log("\n" + "=".repeat(60));
  console.log("📋 Health check complete\n");
}

main().catch(console.error);
