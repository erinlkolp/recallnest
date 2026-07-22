# RecallNest Project Rules

## 1. Tech Stack Constraints (Mandatory)

- **Runtime: Bun**. Do not use `npm`, `yarn`, or `pnpm`; run all commands through `bun`
- **Language: TypeScript strict**. No `any` types; extract complex interfaces into dedicated type files
- **Vector store: LanceDB**. Do not introduce any other vector database
- **Embedding model: Jina v5**. Do not swap out the embedding solution
- **MCP protocol: `@modelcontextprotocol/sdk`**. Register all MCP tools through `registerTool()`

## 2. Coding Standards

- Every new MCP tool must ship with tests (`src/__tests__/`)
- Do not generate half-finished code with `// TODO` or `// placeholder`—if information is missing, stop and ask
- Before changing an existing tool's schema, confirm caller compatibility first
- Put scripts in `scripts/`; do not create business `.ts` files outside `src/`

## 3. Agent Conduct

- **Always run the tests yourself after writing code**: run `bun test`, read the errors, fix them on your own, and only deliver once everything is green
- Before implementing a new feature, output a step-by-step plan and wait for confirmation before moving into execution
- When a task is too large, proactively break it into subtasks and make incremental progress instead of trying to do it all at once and crashing
- Do not write unverified `git status` results into a checkpoint

## 4. Git Push Rules (Important!)

- **All pushes go to origin only** (`erinlkolp/recallnest`)
- **Never push to upstream** (`CortexReach/memory-lancedb-pro`)—that is the public upstream repo, and pushing to it would expose the downstream modifications
- The former upstream `AliceLJY/recallnest` is retired (the account was deleted); no push is needed and none is possible
- `trihippo/recallnest` is no longer maintained; do not push to it anymore
- A plain `git push` is fine (it pushes to origin by default)
- When you need to submit a PR to upstream, use the fork + PR flow; do not push directly

## 5. Feature Flags

- `RECALLNEST_MULTI_VECTOR=true` — Multi-vector L0/L1/L2 retrieval
- `RECALLNEST_KG_MODE=true` — KG triple extraction + graph traversal
- `RECALLNEST_EMOTION_SCORING=true` — Emotion detection + salience-weighted Weibull decay + arousal boost + retrieval scoring
- `RECALLNEST_CONSTRUCTIVE_RETRIEVAL=true` — Multi-source candidate expansion + source-map grounded reconstruction (resume default, search opt-in)
- `RECALLNEST_NARRATIVE_MODE=true` — Autobiographical narrative metadata layer (life-period / general-event / specific-event)
- `RECALLNEST_PREDICTIVE_MEMORY=true` — Heuristic-predicted prospective reminders (zero LLM, behavioral signals)

## 6. Test Baseline

- After changing code, you must run `bun test`; only commit once the full suite passes
- Current baseline: 1533 tests / 0 fail
- New features must come with tests; the baseline may only go up, never down
