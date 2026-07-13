# RecallNest Integrations

> Integration overview: RecallNest works with any AI agent. The options below are ready-to-use integrations.

RecallNest provides two integration paths:

## MCP Server (for CLI tools)

Best for AI coding assistants that support Model Context Protocol natively.

| Tool | Setup | What it does |
|------|-------|-------------|
| [Claude Code](claude-code/) | `setup.sh` adds MCP to `~/.claude.json` and installs rules in `~/.claude/CLAUDE.md` | Proactive continuity plus shared recall |
| [Gemini CLI](gemini-cli/) | `setup.sh` adds MCP to `~/.gemini/settings.json` and installs rules in `~/.gemini/GEMINI.md` | Same MCP tools, shared index, continuity prompts |
| [Codex](codex/) | `setup.sh` adds MCP to `~/.codex/config.toml` and installs rules in `~/.codex/AGENTS.md` | Same MCP tools, shared index, continuity prompts |

All three share the same LanceDB index, and all three setup scripts now install a managed RecallNest continuity block so fresh windows are instructed to call `resume_context` and `checkpoint_session` at the right times.

## HTTP API (for agent frameworks)

Best for custom agents built with any SDK or language. Start the API server:

```bash
cd ~/recallnest && bun run api
# Server runs on http://localhost:4318
```

Then call it from your agent:

| Framework | Example | Language |
|-----------|---------|----------|
| [Claude Agent SDK](examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](examples/langchain/) | `memory-chain.py` | Python |

> Any language that can send HTTP requests can integrate; the examples above are just references.

## Architecture

```
Your Agent (any framework, any language)
    │
    ├──► MCP Server (stdio)     ← CLI tools use this
    │       │
    └──► HTTP API (port 4318)   ← Agent frameworks use this
            │
            ▼
    RecallNest Core Engine
    (Hybrid Retrieval + 6-Category + Weibull Decay)
            │
            ▼
    LanceDB + Jina Embeddings
```

## API Reference

See [docs/api-reference.md](../docs/api-reference.md) for full HTTP API documentation.
