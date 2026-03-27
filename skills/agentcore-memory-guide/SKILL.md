---
name: agentcore-memory-guide
description: AgentCore Memory usage guide — tool reference, shared memory, cross-agent collaboration, configuration, best practices.
---

# AgentCore Memory — Usage Guide

This guide is for **after** the plugin is installed. If the plugin is not installed yet, follow the deployment prompt in `docs/AGENT-DEPLOY-PROMPT.md`.

To verify the plugin is working, use `agentcore-memory-validation` (19 automated tests).

---

## Tool Quick Reference

| When to use | Tool | Key params |
|-------------|------|------------|
| Save important facts/decisions | `agentcore_store` | content, category, importance, scope, tags |
| Find relevant memories | `agentcore_recall` | query, limit, scope, strategy |
| Browse/verify records exist | `agentcore_search` | scope, max_results. No index delay — fallback if recall is empty |
| Update incorrect memories | `agentcore_correct` | record_id, new_content. Auto-retries on transient errors |
| Delete memories | `agentcore_forget` | record_ids, search_query (preview first with confirm=false) |
| Bulk delete entire scope | `agentcore_forget` | purge_scope=true, scope, confirm |
| Share across agents | `agentcore_share` | content, target_scopes: ["agent:bot-b", "project:xxx"] |
| Search past experiences | `agentcore_episodes` | query, actor_id, top_k |
| Check status | `agentcore_stats` | scope. Results cached for 5 min |

## Shared Memory & Cross-Agent Collaboration

### Namespace Model

```
/global                    — All agents share. Default read/write.
/agents/<id>               — Per-agent private space. Auto-recall searches here.
/projects/<id>             — Project-level shared space.
/users/<id>                — Per-user space.
/custom/<id>               — Freeform.
```

**Default isolation** (`per-agent` mode, default): Each agent can only access `/global` + its own namespaces. Cross-agent access is denied unless explicitly configured via `scopes`. In `shared` mode, search uses shorter prefixes (e.g. `/semantic` instead of `/semantic/{id}`), so all agents' data is naturally visible — permissions still enforce but paths overlap.

### Scope Parameter Syntax

All tools accept a `scope` parameter:
- `"global"` -> `/global`
- `"agent:sales-bot"` -> `/agents/sales-bot`
- `"project:ecommerce"` -> `/projects/ecommerce`
- `"user:kent"` -> `/users/kent`
- `"custom:shared-kb"` -> `/custom/shared-kb`

**Scope syntax**: `<kind>:<id>[:<strategy>]`

| Kind | Example | Namespace |
|------|---------|-----------|
| `global` | `"global"` | `/global` |
| `agent` | `"agent:sales-bot"` | `/agents/sales-bot` + strategy namespaces |
| `project` | `"project:ecommerce"` | `/projects/ecommerce` |
| `user` | `"user:kent"` | `/users/kent` |
| `custom` | `"custom:shared-kb"` | `/custom/shared-kb` |

**Strategy filter** (optional third segment, agent scope only):

| Strategy | Example | Namespace |
|----------|---------|-----------|
| `semantic` | `"agent:bot:semantic"` | `/semantic/bot` |
| `episodic` | `"agent:bot:episodic"` | `/episodic/bot` |
| `preferences` | `"agent:bot:preferences"` | `/preferences/bot` |
| `summary` | `"agent:bot:summary"` | `/summary/bot` |
| `primary` | `"agent:bot:primary"` | `/agents/bot` |

Without strategy segment, `"agent:bot"` expands to all 5 namespaces.
Invalid kind → falls back to global. Invalid strategy → entry ignored (least privilege).

> **Invalid scope handling**: Unknown kind (e.g. `"banana:xyz"`) silently falls back to global scope. Unknown strategy (e.g. `"agent:bot:typo"`) silently ignores the entry. Check gateway logs (`warn` level) if permissions behave unexpectedly.

### Auto-Recall Behavior

The `before_prompt_build` hook automatically searches these namespaces in parallel:
1. `/global` — always
2. `/agents/<current-agent-id>` — always
3. Strategy namespaces for current agent (controlled by `namespaceMode`):
   - `per-agent`: `/semantic/<id>`, `/episodic/<id>`, `/preferences/<id>`, `/summary/<id>` (prefix-matches only own data)
   - `shared`: `/semantic`, `/episodic`, `/preferences`, `/summary` (prefix-matches all agents' data)
4. Authorized agents' namespaces from `scopes.agentAccess` — **without this config, only own namespaces are searched**

Results are merged, deduplicated, sorted by score, filtered by score gap detection, and injected as `<agentcore_memory>` context before each turn.

### Cross-Agent Sharing Patterns

**Pattern 1: Explicit share (push model)**

Agent A stores a fact, then uses `agentcore_share` to push to Agent B's namespace. Agent B's auto-recall picks it up on next turn.

```
agentcore_share:
  content: "Customer XYZ prefers email over phone"
  target_scopes: ["agent:support-bot", "project:crm"]
```

**Pattern 2: Shared project space (pull model)**

Multiple agents read/write to the same project scope:

```
agentcore_store:  scope "project:ecommerce"  -> Agent A writes
agentcore_recall: scope "project:ecommerce"  -> Agent B reads
```

**Pattern 3: Access control (config-based)**

Configure in `openclaw.json` -> `plugins.entries.memory-agentcore.config.scopes`:

```json
{
  "scopes": {
    "agentAccess": {
      "bot-a": ["agent:bot-b", "project:shared"],
      "bot-b": ["agent:bot-a"]
    },
    "writeAccess": {
      "bot-a": ["project:shared"]
    }
  }
}
```

- `bot-a`'s auto-recall searches: `/global` + `/agents/bot-a` + `/agents/bot-b` + `/projects/shared`
- `bot-b`'s auto-recall searches: `/global` + `/agents/bot-b` + `/agents/bot-a`
- `bot-a` can write to `/projects/shared`; `bot-b` cannot
- Both can always write to `/global` and their own `/agents/<id>`

Entries are **additive** — `global` and `agent:<self>` are always included, no need to list them.
Strategy-level granularity: `"agent:agama:semantic"` grants read access to agama's semantic namespace only.

## Configuration Reference

All settings have defaults. Configure in `openclaw.json` under `plugins.entries.memory-agentcore.config`:

| Field | Default | Env var | Description |
|-------|---------|---------|-------------|
| `memoryId` | (required) | `AGENTCORE_MEMORY_ID` | AWS Memory resource ID |
| `awsRegion` | `"us-east-1"` | `AWS_REGION` | AWS region |
| `awsProfile` | — | `AWS_PROFILE` | Named AWS credential profile |
| `strategies` | all 4 | — | Active extraction strategies |
| `autoRecallTopK` | `5` | `AGENTCORE_AUTO_RECALL_TOP_K` | Memories injected per turn (0=disabled) |
| `autoCaptureEnabled` | `true` | `AGENTCORE_AUTO_CAPTURE_ENABLED` | Auto-capture after each turn |
| `autoCaptureMinLength` | `30` | `AGENTCORE_AUTO_CAPTURE_MIN_LENGTH` | Min combined message length |
| `noiseFilterEnabled` | `true` | `AGENTCORE_NOISE_FILTER_ENABLED` | Filter greetings/heartbeats |
| `adaptiveRetrievalEnabled` | `true` | `AGENTCORE_ADAPTIVE_RETRIEVAL_ENABLED` | Skip trivial query retrieval |
| `namespaceMode` | `"per-agent"` | `AGENTCORE_NAMESPACE_MODE` | Search prefix granularity: `per-agent` = `/semantic/{actorId}` (only own data), `shared` = `/semantic` (prefix-matches all agents). AWS always stores at `/semantic/{actorId}` — this setting controls search scope, not storage |
| `showScores` | `false` | `AGENTCORE_SHOW_SCORES` | Show similarity scores |
| `scoreGapEnabled` | `true` | `AGENTCORE_SCORE_GAP_ENABLED` | Score gap detection filter |
| `scoreGapMultiplier` | `2.0` | `AGENTCORE_SCORE_GAP_MULTIPLIER` | Gap sensitivity (higher=lenient) |
| `minScoreFloor` | `0.0` | `AGENTCORE_MIN_SCORE_FLOOR` | Absolute minimum score (0=disabled) |
| `noisePatterns` | `[]` | `AGENTCORE_NOISE_PATTERNS` | Custom noise regex (comma-separated in env) |
| `bypassPatterns` | `[]` | `AGENTCORE_BYPASS_PATTERNS` | Custom bypass regex (comma-separated in env) |
| `statsCacheTtlMs` | `300000` | `AGENTCORE_STATS_CACHE_TTL_MS` | Stats cache TTL (5 min) |
| `fileSyncEnabled` | `true` | `AGENTCORE_FILE_SYNC_ENABLED` | Enable file sync to AgentCore |
| `fileSyncPaths` | `[]` | `AGENTCORE_FILE_SYNC_PATHS` | Files to sync (glob supported). Default empty — bootstrap files are already in prompt |
| `eventExpiryDays` | `90` | `AGENTCORE_EVENT_EXPIRY_DAYS` | Short-term event retention |
| `maxRetries` | `3` | `AGENTCORE_MAX_RETRIES` | AWS SDK retry attempts |
| `timeoutMs` | `10000` | `AGENTCORE_TIMEOUT_MS` | Per-request timeout |

## Best Practices

**store vs auto-capture**: Use `agentcore_store` for explicit, important facts/decisions. Auto-capture handles routine conversation extraction — it sends the last user+assistant pair as an event, and AgentCore's 4 strategies extract insights automatically.

**recall vs search**: `agentcore_recall` uses semantic search (meaning-based, may have 30-60s index delay for new records). `agentcore_search` uses list mode (no delay, no semantic ranking). Use search as fallback when recall returns empty.

**Score gap tuning**:
- `scoreGapMultiplier: 1.5` — stricter, filters more aggressively
- `scoreGapMultiplier: 3.0` — lenient, keeps more results
- For small result sets (2-3 records), gap detection has limited effect — use `minScoreFloor` as safety net

**Custom noise patterns**: Add patterns for your language/domain:
```json
{
  "noisePatterns": ["^はい$", "^了解$", "^Build succeeded"],
  "bypassPatterns": ["^Error:", "^Exception:"]
}
```
Bypass patterns take priority over noise patterns. Both are evaluated before built-in EN/ZH filters.

## File Sync

Sync local documents as semantic memory records to `/agents/{actorId}`, searchable by auto-recall.

### When to Use

OpenClaw already injects bootstrap files (SOUL.md, USER.md, TOOLS.md, AGENTS.md, IDENTITY.md, MEMORY.md, HEARTBEAT.md) into the prompt every turn. **Do not sync these files** — it creates redundant results.

File sync is for documents **not in the prompt** but needed for auto-recall semantic search:
- Knowledge documents (e.g., `docs/api-reference.md`)
- Project context files (e.g., `projects/*/context.md`)
- Custom reference material

### Configuration

`fileSyncPaths` defaults to `[]`. Set it to sync specific files:

```json
{
  "fileSyncPaths": ["docs/api-reference.md", "projects/*/context.md"]
}
```

- Supports glob wildcards (`*.md`)
- Each file is stored as a single record (no chunking)
- Files exceeding 25KB are skipped with a warning
- Synced records are tracked in `.agentcore-sync.json` (hash + recordId)
- When a file is deleted from disk, its record is automatically removed on next sync

### CLI

```bash
openclaw agentcore-sync --actor <id>
```

Manually trigger sync. Same logic as the automatic `agent_end` hook.

## Runtime Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `Connection: FAILED` | Bad credentials or memoryId | `aws sts get-caller-identity` + verify memoryId |
| Recall returns empty | Index warm-up (30-60s) | Wait and retry, or use `agentcore_search` |
| `AccessDeniedException` | Missing IAM permissions | Ensure bedrock-agentcore data plane permissions |
| Auto-recall not injecting | Adaptive retrieval skipping | Set `adaptiveRetrievalEnabled: false` to test |
| Tools not found | Plugin not loaded | Check `openclaw plugins list` and gateway logs |
| `plugins.load failed` | `~` in config paths | Use absolute paths in `openclaw.json` |
| `duplicate plugin id` | Both `install` and `load.paths` | Remove `~/.openclaw/extensions/memory-agentcore/` |
| Stats always cache miss | Cache invalidated by writes | Normal — create/delete operations clear the cache |
