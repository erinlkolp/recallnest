# RecallNest Recall Optimization Implementation Checklist

> 2026-04-01 problem found: high-frequency information (such as "轮巡仓库" / patrolling repos) fails to be recalled
> Root cause: the embedding distance between a short query and a long document is too large + no frequency weighting
> Complements the existing P1-P5; this checklist focuses on the **retrieval/recall** stage

---

## P0: Short-query recall enhancement (highest priority)

### P0.1 Two-layer index — original text + retrieval anchor

- [ ] `capture-engine.ts` / `ingest.ts`: at store time, also generate a one-sentence summary (≤80 chars) and save it into `metadata.anchor`
- [ ] `search.ts`: at retrieval time, search both the original-text vector and the anchor vector, taking the max score
- [ ] Effect: the short query "轮巡仓库" matches the short anchor "每日轮巡4个win4r仓库" (patrol 4 win4r repos daily), sharply shortening the distance
- **Estimate:** ~120 LOC
- **Risk:** Low — does not change original-text storage; a purely additive field
- **Dependencies:** None

### P0.2 High-frequency boost — repeated mentions automatically gain weight

- [ ] Add `frequency-tracker.ts`: record the number of query→memory hits
- [ ] Scoring formula: `final_score = base_score × (1 + log2(hit_count) × boost_factor)`
- [ ] hit_count ≥ 3 → peripheral is automatically promoted to the core tier
- [ ] Persistence: write to `data/frequency-stats.json`, accumulating across sessions
- **Estimate:** ~100 LOC
- **Risk:** Medium — the boost magnitude needs balancing so old high-frequency memories don't permanently outrank new ones
- **Dependencies:** None

### P0.3 Automatic short-query expansion

- [ ] `search.ts`: when a query ≤ 6 characters is detected, call the LLM to expand it into 3-5 synonymous keywords
- [ ] Cache the expansion results in `data/query-expansion-cache.json` so the same query is not called repeatedly
- [ ] Alternative: skip the LLM and maintain a `data/alias-map.json` with manual/automatic mappings ("轮巡" → "轮巡 仓库 patrol repo 每日检查")
- **Estimate:** ~60 LOC (alias-map approach) / ~100 LOC (LLM approach)
- **Risk:** alias-map is low; the LLM approach adds ~200ms latency
- **Dependencies:** None

---

## High-frequency vs deduplication balancing mechanism (the key design of P0.2)

### Problem

High-frequency boost and deduplication are in tension:
- **Boost says**: something mentioned 10 times must be important — boost it!
- **Dedup says**: the same piece of information was stored 10 times — it should be merged!

### Design: layered counting, not layered storage

```
Storage layer: dedup as usual; identical content keeps only 1 entry (existing consolidation logic unchanged)
Counting layer: add frequency-tracker, which records **the number of query hits**, not the number of stored entries
```

**Key distinction:**

| Dimension | Storage dedup | Recall weighting |
|------|---------|---------|
| Trigger time | At write time (store/ingest) | At retrieval time (search) |
| Target | Duplicate memory entries | query→memory hit frequency |
| Goal | Keep the database from bloating | Rank high-frequency information first |
| Interaction | None — after dedup only 1 entry remains, but that entry's hit_count keeps accumulating |

### Edge-case handling

1. **Old high-frequency vs new relevance**
   - Time decay: `effective_hits = hit_count × decay(days_since_last_hit)`
   - Not hit for 30 days → hit_count is effectively halved, so it won't dominate the rankings forever

2. **High-frequency but outdated**
   - The user says "轮巡仓库从4个变成3个了" (the patrol went from 4 repos to 3) → store_memory update
   - The old entry is marked superseded by consolidation → hit_count is not inherited
   - The new entry starts counting from 0, but since the user will trigger it frequently next, it quickly catches up

3. **Frequency-counting granularity**
   - Count by memory_id, not by query text
   - "轮巡", "轮巡仓库", and "patrol repo" hitting the same memory → the same counter +1
   - Avoids scattering the count across synonyms

---

## Relationship to the existing P1-P5

| Existing item | Relationship |
|--------|------|
| P1 summary fidelity | P0.1's anchor generation needs P1's fidelity constraints, but can be developed in parallel |
| P2 cluster summaries | Complementary — P2 saves tokens at injection time, P0 makes things findable at retrieval time |
| P3 incremental ingest | P0.1's anchor field needs backfilling for existing data; P3's incremental logic can be reused |
| P4 data-checkup | Could add a check: anchor field coverage (how many memories already have an anchor) |
| P5 large-file gating | No direct relationship |

---

## Verification criteria

- [ ] `search_memory("轮巡")` → returns memories related to patrolling repos, score ≥ 70%
- [ ] `search_memory("轮巡仓库")` → returns results, score ≥ 80%
- [ ] High-frequency memories (hit ≥5 times) automatically appear in the core section of `resume_context`
- [ ] After dedup, the number of database entries does not grow (frequency accumulates only at the tracker layer)
