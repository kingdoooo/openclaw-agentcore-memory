# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Check

```bash
npm run build        # tsc — compiles src/ to dist/
npm run typecheck    # tsc --noEmit — type check without emitting
```

No test runner or linter is configured. Verify changes with `npm run typecheck`.

## Git

Always use `git push --no-verify` when pushing to remote.

## What This Is

An OpenClaw plugin (`kind: "general"`) that adds cloud-backed shared memory via Amazon Bedrock AgentCore Memory. It coexists with OpenClaw's built-in memory-core — local memory works offline, this plugin adds cross-agent sharing and managed extraction on top.

Plugin ID: `memory-agentcore`. Declared in `openclaw.plugin.json`.

## Architecture

**Entry point**: `src/index.ts` — single default export `plugin` object with a `register(api)` method. Registration wires up everything: service lifecycle, 8 tools, 2 hooks, and 9 CLI commands.

**Key modules**:

| Module | Role |
|--------|------|
| `client.ts` | AWS SDK wrapper around `BedrockAgentCoreClient`. All AgentCore API calls go through here. |
| `config.ts` | `resolveConfig(env, raw)` merges env vars > plugin config > defaults. `PluginConfig` is the central config type. |
| `scopes.ts` | Scope string parsing (`"agent:bot-a"` -> `/agents/bot-a`) and namespace resolution for multi-agent access control. |
| `noise-filter.ts` | Bilingual (EN/ZH) regex-based noise detection. Configurable bypass/noise patterns evaluated first. |
| `score-filter.ts` | Score gap detection (elbow/knee point) to filter low-relevance results from recall. |
| `adaptive-retrieval.ts` | Gating logic to skip retrieval for trivial queries. |
| `file-sync.ts` | SHA-256 hash-based sync of workspace markdown files to AgentCore. |
| `identity.ts` | Extracts agent ID from OpenClaw session keys. |
| `tools/*.ts` | Each file exports a `createXxxTool(client, config?)` factory returning a tool definition object. |

**Data flow**:
- **Auto-recall** (`before_prompt_build` hook): user prompt -> adaptive gate -> parallel namespace search -> score sort -> score gap filter -> XML context injection
- **Auto-capture** (`agent_end` hook, fire-and-forget): last user+assistant pair -> noise filter -> min length check -> `createEvent` + file sync

## AWS SDK Conventions

- PayloadType uses `conversational` (NOT `conversationalPayload`)
- Each message is a separate PayloadType item: `{ conversational: { content: { text }, role } }`
- Roles must be uppercase: `"USER"`, `"ASSISTANT"`, `"TOOL"`, `"OTHER"`
- MemoryContent uses `{ text: string }` union member
- MetadataValue uses `{ stringValue: string }` union member

## Skills

Two skills in `skills/`:
- `agentcore-memory-validation` — 19 automated tests (numbered 1-19)
- `agentcore-memory-guide` — usage reference (tools, shared memory, config, best practices)

Registered as explicit paths in `openclaw.plugin.json` `"skills"` array.

## Docs

- `docs/AGENT-DEPLOY-PROMPT.md` (EN) / `docs/AGENT-DEPLOY-PROMPT.zh-CN.md` (CN) — copy-paste deploy prompt for OpenClaw agents
- `README.md` (EN) / `README_CN.md` (CN) — keep both in sync when making doc changes
