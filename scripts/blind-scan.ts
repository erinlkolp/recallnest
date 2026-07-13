/**
 * Blind scan script — Module 4: open-ended exploration
 * Analyzes the text content of ~38K memories without preconceptions
 * Read-only; writes nothing
 *
 * Usage: bun run scripts/blind-scan.ts [lancedb-dir]
 */

import lancedb from "@lancedb/lancedb";

const DB_PATH = process.argv[2] || "./data/lancedb";
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

// Simple CJK-aware tokenizer
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Remove URLs
  const cleaned = text.replace(/https?:\/\/\S+/g, " ");
  // Split into words (English) and characters (CJK)
  const parts = cleaned.match(/[\u4e00-\u9fff\u3400-\u4dbf]+|[a-zA-Z][a-zA-Z0-9_'-]+/g) || [];
  for (const part of parts) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(part)) {
      // CJK: bigrams
      for (let i = 0; i < part.length - 1; i++) {
        tokens.push(part.slice(i, i + 2));
      }
    } else if (part.length > 1) {
      tokens.push(part.toLowerCase());
    }
  }
  return tokens;
}

// Stopwords (minimal)
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "because", "but", "and", "or", "if",
  "while", "about", "up", "its", "it", "this", "that", "these", "those",
  "he", "she", "they", "we", "you", "me", "him", "her", "us", "them",
  "my", "your", "his", "our", "their", "what", "which", "who", "whom",
  "also", "been", "like", "get", "got", "make", "made", "use", "used",
]);

async function main() {
  console.log("\n🔍 Blind Scan Report — RecallNest open-ended exploration");
  console.log("=".repeat(70));
  console.log(`📅 Time: ${new Date().toISOString().slice(0, 19)}`);
  console.log(`📂 Path: ${DB_PATH}\n`);

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

  // ============================================
  // 1. Text length distribution
  // ============================================
  console.log("📊 1. Text length distribution");
  console.log("-".repeat(70));
  const lengths = parsedRows.map(r => r.text.length);
  lengths.sort((a, b) => a - b);
  const avgLen = lengths.reduce((s, l) => s + l, 0) / total;
  const medianLen = lengths[Math.floor(total / 2)];
  const p95Len = lengths[Math.floor(total * 0.95)];
  const p99Len = lengths[Math.floor(total * 0.99)];

  console.log(`  Min:    ${lengths[0]} chars`);
  console.log(`  Median: ${medianLen} chars`);
  console.log(`  Mean:   ${Math.round(avgLen)} chars`);
  console.log(`  P95:    ${p95Len} chars`);
  console.log(`  P99:    ${p99Len} chars`);
  console.log(`  Max:    ${lengths[total - 1]} chars`);

  // Length buckets
  const lenBuckets = new Map<string, number>();
  const lenRanges: Array<[number, number, string]> = [
    [0, 50, "0-50"],
    [50, 100, "50-100"],
    [100, 200, "100-200"],
    [200, 500, "200-500"],
    [500, 1000, "500-1K"],
    [1000, 2000, "1K-2K"],
    [2000, 5000, "2K-5K"],
    [5000, Infinity, "5K+"],
  ];
  for (const len of lengths) {
    for (const [lo, hi, label] of lenRanges) {
      if (len >= lo && len < hi) {
        lenBuckets.set(label, (lenBuckets.get(label) || 0) + 1);
        break;
      }
    }
  }
  console.log("\n  Distribution:");
  for (const [, , label] of lenRanges) {
    const count = lenBuckets.get(label) || 0;
    const pct = (count / total * 100).toFixed(1);
    const bar = "█".repeat(Math.round(parseFloat(pct) / 100 * 40));
    console.log(`    ${label.padEnd(10)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${bar}`);
  }

  // Extremely short texts (likely garbage)
  const ultraShort = parsedRows.filter(r => r.text.length < 20);
  if (ultraShort.length > 0) {
    console.log(`\n  ⚠️ Ultra-short text (<20 chars): ${ultraShort.length} entries`);
    console.log("  Examples:");
    for (const r of ultraShort.slice(0, 5)) {
      console.log(`    [${r.category}] "${r.text}"`);
    }
  }

  // ============================================
  // 2. Language mix analysis
  // ============================================
  console.log("\n📊 2. Language mix analysis");
  console.log("-".repeat(70));
  let pureEn = 0, pureCn = 0, mixed = 0, other = 0;
  for (const row of parsedRows) {
    const hasCJK = /[\u4e00-\u9fff]/.test(row.text);
    const hasEn = /[a-zA-Z]{3,}/.test(row.text);
    if (hasCJK && hasEn) mixed++;
    else if (hasCJK) pureCn++;
    else if (hasEn) pureEn++;
    else other++;
  }
  console.log(`  English only:    ${pureEn.toLocaleString()} (${(pureEn/total*100).toFixed(1)}%)`);
  console.log(`  Chinese only:    ${pureCn.toLocaleString()} (${(pureCn/total*100).toFixed(1)}%)`);
  console.log(`  Mixed CN/EN:     ${mixed.toLocaleString()} (${(mixed/total*100).toFixed(1)}%)`);
  console.log(`  Other:           ${other.toLocaleString()} (${(other/total*100).toFixed(1)}%)`);

  // ============================================
  // 3. Top-word analysis (by language)
  // ============================================
  console.log("\n📊 3. Top-word analysis");
  console.log("-".repeat(70));
  const wordFreq = new Map<string, number>();
  for (const row of parsedRows) {
    const tokens = tokenize(row.text);
    for (const t of tokens) {
      if (!STOPWORDS.has(t) && t.length > 1) {
        wordFreq.set(t, (wordFreq.get(t) || 0) + 1);
      }
    }
  }
  const topWords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  console.log("  Top 40 word frequencies (stopwords removed):");
  for (let i = 0; i < topWords.length; i++) {
    const [word, count] = topWords[i];
    const pctOfDocs = (count / total * 100).toFixed(1);
    console.log(`    ${(i+1).toString().padStart(2)}. ${word.padEnd(20)} ${count.toString().padStart(6)}  (${pctOfDocs}% of docs)`);
  }

  // ============================================
  // 4. Text prefix clustering (detect templated content)
  // ============================================
  console.log("\n📊 4. Text prefix clustering (detect templated content)");
  console.log("-".repeat(70));
  const prefixMap = new Map<string, number>();
  for (const row of parsedRows) {
    // Take first 40 chars as prefix fingerprint
    const prefix = row.text.slice(0, 40).trim();
    prefixMap.set(prefix, (prefixMap.get(prefix) || 0) + 1);
  }
  const repeatedPrefixes = [...prefixMap.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1]);

  console.log(`  Unique prefixes: ${prefixMap.size.toLocaleString()}`);
  console.log(`  Prefixes repeated ≥3 times: ${repeatedPrefixes.length}`);

  if (repeatedPrefixes.length > 0) {
    console.log("\n  Top 20 repeated prefixes:");
    for (const [prefix, count] of repeatedPrefixes.slice(0, 20)) {
      console.log(`    [×${count.toString().padStart(4)}] ${prefix}...`);
    }
  }

  // ============================================
  // 5. Scope × Category cross-analysis
  // ============================================
  console.log("\n📊 5. Scope × Category cross-analysis (Top 10 scopes)");
  console.log("-".repeat(70));
  const scopeCat = new Map<string, Map<string, number>>();
  for (const row of parsedRows) {
    const s = row.scope || "(empty)";
    if (!scopeCat.has(s)) scopeCat.set(s, new Map());
    const catMap = scopeCat.get(s)!;
    catMap.set(row.category, (catMap.get(row.category) || 0) + 1);
  }
  const topScopes = [...scopeCat.entries()]
    .map(([scope, cats]) => {
      const scopeTotal = [...cats.values()].reduce((s, c) => s + c, 0);
      return { scope, total: scopeTotal, cats };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const allCats = [...new Set(parsedRows.map(r => r.category))].sort();
  // Header
  let header = "  Scope".padEnd(35);
  for (const cat of allCats) header += cat.slice(0, 6).padStart(8);
  header += "   Total".padStart(8);
  console.log(header);

  for (const { scope, total: scopeTotal, cats } of topScopes) {
    const label = scope.length > 30 ? scope.slice(0, 27) + "..." : scope;
    let line = `  ${label.padEnd(33)}`;
    for (const cat of allCats) {
      line += (cats.get(cat) || 0).toString().padStart(8);
    }
    line += scopeTotal.toString().padStart(8);
    console.log(line);
  }

  // ============================================
  // 6. Temporal pattern analysis
  // ============================================
  console.log("\n📊 6. Temporal pattern analysis");
  console.log("-".repeat(70));

  // By month
  const monthMap = new Map<string, number>();
  // By hour of day
  const hourMap = new Map<number, number>();
  // By day of week
  const dowMap = new Map<number, number>();
  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (const row of parsedRows) {
    const d = new Date(row.timestamp);
    const month = d.toISOString().slice(0, 7);
    monthMap.set(month, (monthMap.get(month) || 0) + 1);
    hourMap.set(d.getHours(), (hourMap.get(d.getHours()) || 0) + 1);
    dowMap.set(d.getDay(), (dowMap.get(d.getDay()) || 0) + 1);
  }

  // Monthly trend
  const months = [...monthMap.entries()].sort();
  console.log("  Monthly trend:");
  const maxMonthCount = Math.max(...months.map(m => m[1]));
  for (const [month, count] of months) {
    const bar = "█".repeat(Math.round(count / maxMonthCount * 30));
    console.log(`    ${month}  ${count.toString().padStart(6)}  ${bar}`);
  }

  // Hourly pattern
  console.log("\n  Hourly distribution:");
  const maxHourCount = Math.max(...[...hourMap.values()]);
  for (let h = 0; h < 24; h++) {
    const count = hourMap.get(h) || 0;
    const bar = "█".repeat(Math.round(count / maxHourCount * 20));
    console.log(`    ${h.toString().padStart(2)}:00  ${count.toString().padStart(5)}  ${bar}`);
  }

  // Day of week
  console.log("\n  Day-of-week distribution:");
  for (let d = 0; d < 7; d++) {
    const count = dowMap.get(d) || 0;
    const pct = (count / total * 100).toFixed(1);
    console.log(`    ${DOW_NAMES[d]}  ${count.toString().padStart(6)}  (${pct}%)`);
  }

  // ============================================
  // 7. Stale content detection
  // ============================================
  console.log("\n📊 7. Stale content detection");
  console.log("-".repeat(70));

  // Look for date references in text
  const yearRefs = new Map<string, number>();
  for (const row of parsedRows) {
    const yearPattern = /20(2[0-6])/g;
    let match;
    while ((match = yearPattern.exec(row.text)) !== null) {
      const year = `20${match[1]}`;
      yearRefs.set(year, (yearRefs.get(year) || 0) + 1);
    }
  }
  console.log("  Years referenced in text:");
  for (const [year, count] of [...yearRefs.entries()].sort()) {
    console.log(`    ${year}: ${count.toLocaleString()} times`);
  }

  // Look for potentially outdated keywords
  // NOTE: Chinese keywords below are functional scan terms matched against
  // memory text (临时=temporary, 废弃=deprecated, 已删除=deleted, 待修复=to-fix).
  const outdatedKeywords = [
    "deprecated", "removed", "old", "legacy", "TODO", "FIXME", "HACK",
    "temporary", "workaround", "临时", "废弃", "已删除", "待修复",
  ];
  console.log("\n  Stale keyword scan:");
  for (const kw of outdatedKeywords) {
    const count = parsedRows.filter(r =>
      r.text.toLowerCase().includes(kw.toLowerCase())
    ).length;
    if (count > 0) {
      console.log(`    "${kw}": ${count} entries`);
    }
  }

  // ============================================
  // 8. Exact text duplicate detection
  // ============================================
  console.log("\n📊 8. Exact / near-duplicate text");
  console.log("-".repeat(70));

  // Exact text duplicates
  const textMap = new Map<string, number>();
  for (const row of parsedRows) {
    const normalized = row.text.trim().toLowerCase();
    textMap.set(normalized, (textMap.get(normalized) || 0) + 1);
  }
  const exactDups = [...textMap.entries()].filter(([, count]) => count > 1);
  const totalDupRows = exactDups.reduce((s, [, c]) => s + c, 0);
  console.log(`  Exact duplicate groups: ${exactDups.length}`);
  console.log(`  Total duplicate rows: ${totalDupRows} / ${total} (${(totalDupRows/total*100).toFixed(1)}%)`);

  if (exactDups.length > 0) {
    const topDups = exactDups.sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log("\n  Top 10 exact duplicates:");
    for (const [text, count] of topDups) {
      console.log(`    [×${count}] ${text.slice(0, 80)}...`);
    }
  }

  // Text fingerprint duplicates (first 100 chars match)
  const fpMap = new Map<string, number>();
  for (const row of parsedRows) {
    const fp = row.text.trim().slice(0, 100).toLowerCase();
    fpMap.set(fp, (fpMap.get(fp) || 0) + 1);
  }
  const fpDups = [...fpMap.entries()].filter(([, count]) => count > 1);
  const fpDupRows = fpDups.reduce((s, [, c]) => s + c, 0);
  console.log(`\n  First-100-char duplicate groups: ${fpDups.length}`);
  console.log(`  Related rows total: ${fpDupRows} / ${total} (${(fpDupRows/total*100).toFixed(1)}%)`);

  // ============================================
  // 9. Scope ecosystem analysis
  // ============================================
  console.log("\n📊 9. Scope ecosystem analysis");
  console.log("-".repeat(70));

  const scopeCounts = new Map<string, number>();
  for (const row of parsedRows) {
    const s = row.scope || "(empty)";
    scopeCounts.set(s, (scopeCounts.get(s) || 0) + 1);
  }
  const totalScopes = scopeCounts.size;
  const singletonScopes = [...scopeCounts.entries()].filter(([, c]) => c === 1).length;
  const tinyScopes = [...scopeCounts.entries()].filter(([, c]) => c <= 5 && c > 1).length;

  console.log(`  Total scopes: ${totalScopes}`);
  console.log(`  Single-entry scopes (orphans): ${singletonScopes} (${(singletonScopes/totalScopes*100).toFixed(1)}%)`);
  console.log(`  2-5 entry scopes: ${tinyScopes}`);
  console.log(`  Top-1 scope share: ${(([...scopeCounts.values()].sort((a,b)=>b-a)[0] / total) * 100).toFixed(1)}%`);

  // ============================================
  // 10. Content topic clustering (embedding sample)
  // ============================================
  const clusterSampleSize = 2000;
  console.log(`\n📊 10. Embedding cluster sample (${clusterSampleSize} entries, K-Means k=8)`);
  console.log("-".repeat(70));
  console.log("  ⏳ Loading vector data...");

  // Read vectors for sample
  const sampleWithVectors: MemoryRow[] = await table
    .query()
    .select(["id", "text", "vector", "category", "scope", "timestamp"])
    .limit(clusterSampleSize)
    .toArray() as any;

  // Simple K-Means
  const K = 8;
  const dim = sampleWithVectors[0]?.vector?.length || 0;
  if (dim === 0) {
    console.log("  ⚠️ No vector data; skipping clustering");
  } else {
    console.log(`  Vector dimension: ${dim}`);

    // Initialize centroids randomly
    const centroids: number[][] = [];
    const usedSet = new Set<number>();
    for (let i = 0; i < K; i++) {
      let idx: number;
      do { idx = Math.floor(Math.random() * sampleWithVectors.length); } while (usedSet.has(idx));
      usedSet.add(idx);
      centroids.push([...sampleWithVectors[idx].vector]);
    }

    // Run K-Means for 20 iterations
    const assignments = new Array(sampleWithVectors.length).fill(0);
    for (let iter = 0; iter < 20; iter++) {
      // Assign
      for (let i = 0; i < sampleWithVectors.length; i++) {
        let bestK = 0, bestSim = -1;
        for (let k = 0; k < K; k++) {
          const sim = cosineSimilarity(sampleWithVectors[i].vector, centroids[k]);
          if (sim > bestSim) { bestSim = sim; bestK = k; }
        }
        assignments[i] = bestK;
      }
      // Update centroids
      for (let k = 0; k < K; k++) {
        const members = sampleWithVectors.filter((_, i) => assignments[i] === k);
        if (members.length === 0) continue;
        for (let d = 0; d < dim; d++) {
          centroids[k][d] = members.reduce((s, m) => s + m.vector[d], 0) / members.length;
        }
      }
    }

    // Analyze clusters
    const clusters: Map<number, typeof sampleWithVectors> = new Map();
    for (let i = 0; i < sampleWithVectors.length; i++) {
      if (!clusters.has(assignments[i])) clusters.set(assignments[i], []);
      clusters.get(assignments[i])!.push(sampleWithVectors[i]);
    }

    console.log(`\n  Clustering results (K=${K}):`);
    const sortedClusters = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [k, members] of sortedClusters) {
      console.log(`\n  ── Cluster ${k} (${members.length} entries, ${(members.length/sampleWithVectors.length*100).toFixed(1)}%) ──`);

      // Category distribution within cluster
      const clCatMap = new Map<string, number>();
      for (const m of members) {
        clCatMap.set(m.category, (clCatMap.get(m.category) || 0) + 1);
      }
      const catStr = [...clCatMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c}:${n}`)
        .join(", ");
      console.log(`    Categories: ${catStr}`);

      // Top scopes
      const clScopeMap = new Map<string, number>();
      for (const m of members) {
        const s = m.scope || "(empty)";
        clScopeMap.set(s, (clScopeMap.get(s) || 0) + 1);
      }
      const topClScopes = [...clScopeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      console.log(`    Top scope: ${topClScopes.map(([s, n]) => `${s.slice(0,30)}(${n})`).join(", ")}`);

      // Top keywords
      const clWordFreq = new Map<string, number>();
      for (const m of members) {
        const tokens = tokenize(m.text);
        const seen = new Set<string>();
        for (const t of tokens) {
          if (!STOPWORDS.has(t) && t.length > 1 && !seen.has(t)) {
            clWordFreq.set(t, (clWordFreq.get(t) || 0) + 1);
            seen.add(t);
          }
        }
      }
      const topClWords = [...clWordFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([w]) => w)
        .join(", ");
      console.log(`    Keywords: ${topClWords}`);

      // Sample texts
      console.log(`    Examples:`);
      const samples = members.slice(0, 3);
      for (const s of samples) {
        console.log(`      - ${s.text.slice(0, 100)}...`);
      }
    }
  }

  // ============================================
  // 11. Outlier detection
  // ============================================
  console.log("\n📊 11. Outlier detection");
  console.log("-".repeat(70));

  // Empty or near-empty scope
  const emptyScope = parsedRows.filter(r => !r.scope || r.scope.trim() === "").length;
  console.log(`  Empty scope: ${emptyScope} entries (${(emptyScope/total*100).toFixed(1)}%)`);

  // Suspiciously high importance + zero access
  const highImpZeroAccess = parsedRows.filter(r => {
    const ac = r.meta.accessCount ?? r.meta.access_count ?? 0;
    return r.importance >= 0.8 && ac === 0;
  }).length;
  console.log(`  High importance (≥0.8) + 0 accesses: ${highImpZeroAccess} entries`);

  // Very old memories that are still "working" tier
  const oldWorking = parsedRows.filter(r => {
    const tier = r.meta.tier ?? "unknown";
    const agedays = (Date.now() - r.timestamp) / (1000*60*60*24);
    return tier === "working" && agedays > 60;
  }).length;
  console.log(`  Working-tier memories >60 days old: ${oldWorking} entries (should demote?)`);

  // Memories with no metadata
  const noMeta = parsedRows.filter(r => !r.metadata || r.metadata === "{}").length;
  console.log(`  No metadata: ${noMeta} entries`);

  // ============================================
  // Overall findings
  // ============================================
  console.log("\n" + "=".repeat(70));
  console.log("🔬 Blind scan — overall findings");
  console.log("=".repeat(70));

  const findings: string[] = [];

  if (exactDups.length > 0) {
    findings.push(`📌 Exact duplicates: ${exactDups.length} groups / ${totalDupRows} entries — room to clean up`);
  }
  if (ultraShort.length > 0) {
    findings.push(`📌 Ultra-short text (<20 chars): ${ultraShort.length} entries — likely junk data`);
  }
  if (singletonScopes > totalScopes * 0.5) {
    findings.push(`📌 ${singletonScopes}/${totalScopes} scopes have only 1 memory — severe scope fragmentation`);
  }
  if (highImpZeroAccess > 100) {
    findings.push(`📌 ${highImpZeroAccess} high-importance memories never accessed — importance may be inflated`);
  }
  if (mixed / total > 0.3) {
    findings.push(`📌 ${(mixed/total*100).toFixed(1)}% of memories mix CN/EN — may affect retrieval consistency`);
  }
  if (emptyScope > total * 0.1) {
    findings.push(`📌 ${(emptyScope/total*100).toFixed(1)}% of memories have no scope — cannot filter by project at retrieval`);
  }

  for (const f of findings) {
    console.log(`  ${f}`);
  }

  if (findings.length === 0) {
    console.log("  ✅ No obvious anomalous patterns found");
  }

  console.log("\n" + "=".repeat(70));
  console.log("📋 Blind scan complete\n");
}

main().catch(console.error);
