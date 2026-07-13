# Self-Evolution: How RecallNest Memories and Workflows Evolve

> How self-evolution works: RecallNest not only lets memories consolidate, decay, and surface on their own, but also starts to observe when a workflow gets things right and when it gets them wrong.

## Overview

Traditional memory systems are append-only: store everything, search later, hope for the best. Over time, they bloat with duplicates, outdated entries, and noise.

RecallNest takes a different approach: **memories evolve**. They consolidate, decay, and surface based on usage — just like biological memory.

```
Store → Classify → Decay → Access → Consolidate → Promote/Demote
  │        │         │        │          │              │
  ▼        ▼         ▼        ▼          ▼              ▼
 New    6 types   Weibull   "Use it    Merge         Core ↔
memory  auto-     curve     or lose    similar       Working ↔
        assigned  over      it"        entries       Peripheral
                  time
```

---

## Workflow Observation Loop

RecallNest now separates self-evolution signals from regular memory.

Instead of turning every workflow failure into another `events` row, RecallNest records workflow observations in a dedicated append-only store:

```
Observe → Inspect → Health → Evidence → Fix / Test
   │         │         │         │          │
   ▼         ▼         ▼         ▼          ▼
 record   aggregate  degrade   package   repair the
 success/ 7d / 30d   or stay   top       workflow,
 failure   health    healthy   signals   then observe again
```

- **`workflow_observe`** records whether `resume_context`, `checkpoint_session`, or another workflow primitive succeeded, failed, was corrected, or was missed
- **`workflow_health`** aggregates recent observations into a health report or degraded-workflow dashboard
- **`workflow_evidence`** packages recent issue observations and suggestions so tests, rules, and prompts can be tightened
- these records live outside the 6 memory categories and are not composed into `resume_context`
- managed MCP / HTTP continuity calls now append `resume_context` / `checkpoint_session` observations automatically, and checkpoint repo-state sanitization is recorded as `corrected`

That boundary is deliberate: self-evolution needs operational telemetry, not more noisy durable memory.

---

## The Three-Tier Lifecycle

Every memory lives in one of three tiers:

| Tier | Description | Typical Size |
|------|-------------|--------------|
| **Core** | Essential knowledge, accessed frequently | ~5% of total |
| **Working** | Actively useful, moderate access | ~25% of total |
| **Peripheral** | Rarely accessed, candidates for archival | ~70% of total |

> Three-tier lifecycle: Core tier (the frequently used 5%) → Working tier (medium frequency, 25%) → Peripheral tier (low frequency, 70%)

### Promotion and Demotion

Memories move between tiers based on access patterns:

- **Promotion** (peripheral → working → core): Memory accessed ≥ N times within a window
- **Demotion** (core → working → peripheral): Memory not accessed for extended period
- **Archival**: Peripheral memories with zero access beyond decay threshold get archived (not deleted)

---

## Weibull Decay

RecallNest uses the [Weibull distribution](https://en.wikipedia.org/wiki/Weibull_distribution) for time-based memory decay, inspired by human forgetting curves.

> The Weibull decay model matches the human forgetting curve better than simple linear decay: it starts fading slowly, then accelerates.

### Why Weibull, not Exponential?

| Model | Behavior | Problem |
|-------|----------|---------|
| Linear | Constant decay rate | Too aggressive early on |
| Exponential | Fast initial decay | Important but old memories vanish too quickly |
| **Weibull** | Slow start, accelerating decay | Matches human memory: recent stays fresh, old fades naturally |

### Formula

```
decay(t) = exp(-(t / λ)^k)

where:
  t = days since last access
  λ = scale parameter (half-life, default: 120 days)
  k = shape parameter (default: 1.5, gives the "slow then fast" curve)
```

### Impact on Search

Decay factor multiplies the retrieval score:

```
final_score = relevance_score × decay(days_since_access)
```

A highly relevant but stale memory can still surface if the semantic match is strong enough.

---

## Memory Consolidation

Over time, you accumulate many memories about the same topic. Consolidation merges them.

> Memory consolidation: find clusters of memories on similar topics, then merge or deduplicate them by strategy to keep the memory store lean.

### Merge vs. Append Strategies

| Category | Strategy | Why |
|----------|----------|-----|
| `profile` | **Merge** | User identity evolves; latest version wins |
| `preferences` | **Merge** | Preferences update within the same slot; concrete item preferences stay separate |
| `entities` | **Merge** | Entity info accumulates; consolidate |
| `patterns` | **Merge** | Patterns refine over time |
| `events` | **Append** | Events are facts; dedup but keep distinct entries |
| `cases` | **Append** | Case studies are unique; dedup only exact matches |

### How It Works

1. For each category, compute pairwise cosine similarity
2. Cluster entries with similarity > threshold (default: 0.85)
3. For **merge** categories: LLM combines the cluster into one entry, archives originals
4. For **append** categories: remove exact duplicates, keep distinct entries
5. Update access counts (merged entry inherits the sum)

`preferences` needs one extra guard: do not collapse same-brand, different-item preferences into one topic-level memory. A summary can exist, but it should not replace the atomic preference facts. The same idea now also applies to slot-aware reply-style and tool-choice preferences.

### Safety

- Default mode is **dry-run**: preview changes before applying
- Original entries are **archived**, never deleted
- Consolidation is triggered manually or via scheduled task, never automatic

---

## Gap Detection

RecallNest tracks what you search for and notices when searches consistently return poor results.

> Gap detection: analyze the search logs to find topics you ask about often but that the memory store covers poorly.

### How It Works

1. Log every search query and its top result score
2. Periodically analyze: which topics have avg score < threshold?
3. Cluster low-score queries by topic
4. Generate a gap report with suggestions

### Example Gap Report

```
Topic: "deployment pipeline"
  Searches: 8 in last 30 days
  Avg top score: 0.12
  Suggestion: Consider documenting your deployment workflow

Topic: "API rate limiting"
  Searches: 5 in last 30 days
  Avg top score: 0.18
  Suggestion: Store your rate limiting strategy and past incidents
```

---

## Access-Based Surfacing ("Use It or Lose It")

> Use it or lose it: memories that are searched often gain weight, while those left untouched for a long time lose weight.

The access tracker records every time a memory appears in search results. This creates a feedback loop:

```
Accessed often → higher tier → higher base score → more likely to surface
Never accessed → lower tier → lower base score → gradually fades
```

This is the "use it or lose it" principle applied to AI memory.

---

## Putting It All Together

A typical memory lifecycle:

1. **Day 0**: New memory stored → classified as `events` → tier: `peripheral`
2. **Day 1-30**: Searched 5 times → promoted to `working`
3. **Day 30-90**: Searched 15 more times → promoted to `core`
4. **Day 120**: Consolidated with 3 similar memories → single refined entry
5. **Day 180+**: Access drops to zero → demoted to `working`
6. **Day 365+**: Still no access → demoted to `peripheral`, Weibull decay significant
7. **Archival**: If importance < threshold after extended inactivity → archived

The result: your memory index stays lean, relevant, and self-maintaining.
