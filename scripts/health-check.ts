/**
 * RecallNest memory health-check script
 * Read-only analysis of LanceDB data; writes nothing
 *
 * Checks:
 * 1. Category distribution (with percentages)
 * 2. Tier distribution (peripheral/working/core)
 * 3. Dead memories (accessCount = 0 or no accessCount)
 * 4. Importance distribution
 * 5. Source distribution (CC/Codex/Gemini/manual)
 * 6. Age distribution
 * 7. Near-duplicate detection (sampled cosine similarity)
 */

import lancedb from "@lancedb/lancedb";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "..", "data", "lancedb");
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
  console.log("\n🏥 RecallNest memory health-check report");
  console.log("=" .repeat(60));
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
  console.log(`✅ Loaded: ${total.toLocaleString()} memories\n`);

  // ============================================
  // 1. Category distribution
  // ============================================
  console.log("📊 1. Category distribution");
  console.log("-".repeat(60));
  const catMap = new Map<string, number>();
  for (const row of allRows) {
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
  let noTier = 0;
  for (const row of allRows) {
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    const tier = meta.tier || "unknown";
    if (tier === "unknown") noTier++;
    tierMap.set(tier, (tierMap.get(tier) || 0) + 1);
  }
  const tierSorted = [...tierMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [tier, count] of tierSorted) {
    const pct = (count / total * 100).toFixed(1);
    console.log(`  ${tier.padEnd(14)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 3. Dead memories (never hit by recall)
  // ============================================
  console.log("\n📊 3. Dead-memory analysis (accessCount = 0 or no record)");
  console.log("-".repeat(60));
  let deadCount = 0;
  let aliveCount = 0;
  let totalAccess = 0;
  let maxAccess = 0;
  let maxAccessId = "";
  let maxAccessText = "";
  const accessDistribution = new Map<string, number>();

  for (const row of allRows) {
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    const ac = meta.accessCount || 0;
    totalAccess += ac;

    if (ac === 0) {
      deadCount++;
    } else {
      aliveCount++;
    }

    if (ac > maxAccess) {
      maxAccess = ac;
      maxAccessId = row.id;
      maxAccessText = row.text.slice(0, 80);
    }

    // Bucket access counts
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
  console.log(`  Hottest memory: [${maxAccess} accesses] ${maxAccessText}...`);

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
  for (const row of allRows) {
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
  // 5. Source breakdown
  // ============================================
  console.log("\n📊 5. Source breakdown");
  console.log("-".repeat(60));
  let ccCount = 0, codexCount = 0, geminiCount = 0, memoryCount = 0, otherCount = 0;
  const scopeSet = new Set<string>();
  for (const row of allRows) {
    scopeSet.add(row.scope);
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    const source = meta.source || row.scope || "";
    if (source.startsWith("cc:") || row.scope.startsWith("cc:")) ccCount++;
    else if (source.startsWith("codex:") || row.scope.startsWith("codex:")) codexCount++;
    else if (source.startsWith("gemini:") || row.scope.startsWith("gemini:")) geminiCount++;
    else if (source === "memory" || row.scope === "memory" || source === "manual" || source === "agent") memoryCount++;
    else otherCount++;
  }
  console.log(`  Claude Code:  ${ccCount.toLocaleString().padStart(6)}  (${(ccCount/total*100).toFixed(1)}%)`);
  console.log(`  Codex:        ${codexCount.toLocaleString().padStart(6)}  (${(codexCount/total*100).toFixed(1)}%)`);
  console.log(`  Gemini:       ${geminiCount.toLocaleString().padStart(6)}  (${(geminiCount/total*100).toFixed(1)}%)`);
  console.log(`  Manual:       ${memoryCount.toLocaleString().padStart(6)}  (${(memoryCount/total*100).toFixed(1)}%)`);
  console.log(`  Other:        ${otherCount.toLocaleString().padStart(6)}  (${(otherCount/total*100).toFixed(1)}%)`);
  console.log(`  Unique scopes: ${scopeSet.size}`);

  // ============================================
  // 6. Age distribution
  // ============================================
  console.log("\n📊 6. Age distribution");
  console.log("-".repeat(60));
  const now = Date.now();
  const ageBuckets = new Map<string, number>();
  let oldest = Infinity, newest = 0;
  for (const row of allRows) {
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
  console.log("\n📊 7. Near-duplicate detection (500-entry sample, cosine > 0.95)");
  console.log("-".repeat(60));
  console.log("  ⏳ Loading vector data (sample)...");

  // Sample 500 random rows with vectors
  const sampleSize = 500;
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
  console.log(`  High-similarity pairs: ${dupPairs} (>${dupRate}%)`);
  console.log(`  Extrapolated:   ~${Math.round(dupPairs / totalPairs * total * (total-1) / 2).toLocaleString()} potential duplicate pairs full-db`);

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
  console.log("🩺 Overall diagnosis");
  console.log("=".repeat(60));

  const issues: string[] = [];
  const healthy: string[] = [];

  // Check dead memory ratio
  const deadRatio = deadCount / total;
  if (deadRatio > 0.9) {
    issues.push(`🔴 ${deadPct}% of memories never accessed (dead-memory rate too high)`);
  } else if (deadRatio > 0.7) {
    issues.push(`🟡 ${deadPct}% of memories never accessed (dead-memory rate elevated)`);
  } else {
    healthy.push(`✅ Dead-memory rate ${deadPct}% is within a reasonable range`);
  }

  // Check category balance
  const factRatio = (catMap.get("fact") || 0) / total;
  if (factRatio > 0.8) {
    issues.push(`🟡 "fact" category is ${(factRatio*100).toFixed(1)}%; structured memories (entities/patterns/cases) are underrepresented`);
  } else {
    healthy.push(`✅ Category distribution is balanced`);
  }

  // Check tier distribution
  const coreCount = tierMap.get("core") || 0;
  const workingCount = tierMap.get("working") || 0;
  if (coreCount < 10) {
    issues.push(`🟡 Only ${coreCount} entries in core tier; too few high-value memories`);
  } else {
    healthy.push(`✅ Core tier has ${coreCount} high-value memories`);
  }

  // Check dup rate
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
