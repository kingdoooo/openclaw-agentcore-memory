---
name: agentcore-guide
description: Verify the memory-agentcore plugin and guide usage. Covers testing (basic + new features), shared memory patterns, cross-agent collaboration, and configuration reference.
---

# AgentCore Memory — Verification & Usage Guide

This skill is for **after** the plugin is installed. If the plugin is not installed yet, follow the deployment prompt in `docs/AGENT-DEPLOY-PROMPT.md`.

---

## Phase 1: Verification

Run all tests and report results. If a test fails, continue to the next — report everything at the end.

### Pre-check: Plugin Loaded

```bash
openclaw plugins list 2>&1 | grep "memory-agentcore"
```

If not found, check logs:

```bash
grep -i "load failed\|duplicate plugin\|agentcore.*error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null \
  | grep -v "deliver called\|tool call\|tool done" | tail -5
```

If the plugin didn't load, STOP and troubleshoot (see Runtime Troubleshooting at the end).

---

### Core Tests

#### Test 1: Connection Status

```bash
openclaw agentcore-status 2>&1
```

**PASS** if `Connection: OK` and `Ready: true`.

#### Test 2: Store Memory

Use `agentcore_store`:
- content: `"AgentCore verification test - plugin working"`
- category: `"fact"`
- importance: `0.8`
- scope: `"global"`
- tags: `["verification"]`

**PASS** if `"stored": true`. Save the `recordId` for later tests.

#### Test 3: Recall Memory

Use `agentcore_recall`:
- query: `"AgentCore verification test"`
- limit: `3`

**PASS** if results contain the test record.

> **Known behavior**: New Memory resources may return 0 results for the first few minutes (index warm-up). If empty, verify via Test 4. Mark **PARTIAL**.

#### Test 4: Search (List Mode)

Use `agentcore_search`:
- scope: `"global"`
- max_results: `5`

**PASS** if returns without error and shows the test record.

#### Test 5: Correct

Use `agentcore_correct`:
- record_id: `<ID from Test 2>`
- new_content: `"AgentCore verification - CORRECTED - plugin working correctly"`

**PASS** if `"corrected": true`.

#### Test 6: Stats

Use `agentcore_stats`:
- scope: `"global"`

**PASS** if `"connected": true`.

#### Test 7: Share

Use `agentcore_share`:
- content: `"Shared verification: memory-agentcore is operational"`
- target_scopes: `["agent:test-agent"]`
- category: `"fact"`

**PASS** if `"shared": true`.

#### Test 8: Forget (Cleanup)

1. Use `agentcore_forget`:
   - search_query: `"AgentCore verification"`
   - confirm: `true`
   - scope: `"global"`

2. Use `agentcore_forget`:
   - search_query: `"memory-agentcore is operational"`
   - confirm: `true`
   - scope: `"agent:test-agent"`

**PASS** if `"deleted": true`.

#### Test 9: File Sync

```bash
openclaw agentcore-sync 2>&1
```

**PASS** if output contains `Synced` (0 or more files OK, no error).

#### Test 10: CLI Remember + Cleanup

```bash
openclaw agentcore-remember "CLI remember test from verification"
```

**PASS** if output says `Stored`.

Then clean up via `agentcore_forget`:
- search_query: `"CLI remember test"`
- confirm: `true`

#### Test 11: Episodic Search

Use `agentcore_episodes`:
- query: `"verification test"`
- top_k: `3`

May return 0 results (episodic needs conversation events). **PASS** if no error.

#### Test 12: Runtime Error Check

```bash
grep -i "agentcore.*error\|auto-capture error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null \
  | grep -v "deliver called\|tool call\|tool done" | tail -5
```

**PASS** if no errors after plugin load time.

---

### New Feature Tests (v0.2)

#### Test N1: Score Gap Detection — Basic

**Step 1: Seed test data**

Use `agentcore_store` to create 5 records in scope `"global"`:
1. `"The user prefers dark mode and monospace fonts for coding"` (category: `"preference"`)
2. `"The user's favorite programming language is TypeScript"` (category: `"preference"`)
3. `"TypeScript supports generics, union types, and mapped types"` (category: `"fact"`)
4. `"The weather in Tokyo was sunny last Tuesday"` (category: `"fact"`)
5. `"Bananas are a good source of potassium"` (category: `"fact"`)

> Records 4-5 are intentionally irrelevant to create a score gap.

**Step 2: Search and observe filtering**

Use `agentcore_recall`:
- query: `"What are the user's coding preferences?"`
- limit: `5`

**PASS** if results return without error. If result count < 5, score gap filtering is active (irrelevant records were filtered at the score cliff). If result count = 5, scores were evenly distributed — still PASS.

#### Test N2: Stats Cache

Use `agentcore_stats` (scope: `"global"`). Note `"cacheHit": false`.

Immediately call `agentcore_stats` again.

**PASS** if second call returns `"cacheHit": true`.

#### Test N3: Purge — Preview

Use `agentcore_forget`:
- purge_scope: `true`
- scope: `"agent:purge-test"`
- confirm: `false`

**PASS** if response contains `"purge_preview": true` and `"estimated_count"` field.

#### Test N4: Purge — Full Cycle

**Step 1**: Store 3 records in scope `"agent:purge-test"`:
- `"Purge test record A"`, `"Purge test record B"`, `"Purge test record C"`

**Step 2**: Preview — `agentcore_forget` with purge_scope: true, confirm: false. Verify `estimated_count` >= 3.

**Step 3**: Execute — `agentcore_forget` with purge_scope: true, confirm: true. Verify `"purged": true`.

**Step 4**: Verify — `agentcore_search` with scope `"agent:purge-test"`. Should return 0 records.

**PASS** if purged and scope is empty.

#### Test N5: Purge — CLI

```bash
openclaw agentcore-purge global
```

**PASS** if output contains `[DRY RUN] Would delete`.

> Do NOT run with `--confirm` on `global` unless you intend to wipe all data.

#### Test N6: Correct with Retry

Store `"Retry test: original content"` (scope: `"global"`), then correct with `"Retry test: CORRECTED content"`.

**PASS** if `"corrected": true, "method": "update"`.

Clean up with `agentcore_forget`: record_ids `[<ID>]`.

#### Test N7: Noise Filter Defaults

```bash
grep -i "auto-capture\|noise" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | tail -10
```

**PASS** if no errors.

---

### Cleanup

Clean up Test N1 seed data — use `agentcore_forget` with confirm: true for each:
- `"dark mode monospace fonts"` (scope: global)
- `"favorite programming language TypeScript"` (scope: global)
- `"TypeScript supports generics"` (scope: global)
- `"weather in Tokyo"` (scope: global)
- `"Bananas potassium"` (scope: global)

### Results Report

```
=== memory-agentcore Verification ===

Core Tests:
  1.  Connection:      [PASS/FAIL]
  2.  Store:           [PASS/FAIL]
  3.  Recall:          [PASS/FAIL/PARTIAL]
  4.  Search/List:     [PASS/FAIL]
  5.  Correct:         [PASS/FAIL]
  6.  Stats:           [PASS/FAIL]
  7.  Share:           [PASS/FAIL]
  8.  Forget:          [PASS/FAIL]
  9.  File Sync:       [PASS/FAIL]
 10.  CLI Remember:    [PASS/FAIL]
 11.  Episodic:        [PASS/FAIL]
 12.  Error Check:     [PASS/FAIL]

New Feature Tests (v0.2):
 N1.  Score Gap:       [PASS/FAIL]
 N2.  Stats Cache:     [PASS/FAIL]
 N3.  Purge Preview:   [PASS/FAIL]
 N4.  Purge Cycle:     [PASS/FAIL]
 N5.  Purge CLI:       [PASS/FAIL]
 N6.  Correct+Retry:   [PASS/FAIL]
 N7.  Noise Filter:    [PASS/FAIL]

Total: X/19 passed
```

---

## Phase 2: Usage Guide

### Tool Quick Reference

| When to use | Tool | Key params |
|-------------|------|------------|
| Save important facts/decisions | `agentcore_store` | content, category, importance, scope, tags |
| Find relevant memories | `agentcore_recall` | query, limit, scope, strategy |
| Browse/verify records exist | `agentcore_search` | scope, max_results. No index delay — fallback if recall is empty |
| Update incorrect memories | `agentcore_correct` | record_id, new_content. Auto-retries on transient errors |
| Delete memories (GDPR) | `agentcore_forget` | record_ids, search_query (preview first with confirm=false) |
| Bulk delete entire scope | `agentcore_forget` | purge_scope=true, scope, confirm |
| Share across agents | `agentcore_share` | content, target_scopes: ["agent:bot-b", "project:xxx"] |
| Search past experiences | `agentcore_episodes` | query, actor_id, top_k |
| Check status | `agentcore_stats` | scope. Results cached for 5 min |

### Shared Memory & Cross-Agent Collaboration

#### Namespace Model

```
/global                    — All agents share. Default read/write.
/agents/<id>               — Per-agent private space. Auto-recall searches here.
/projects/<id>             — Project-level shared space.
/users/<id>                — Per-user space.
/custom/<id>               — Freeform.
```

#### Scope Parameter Syntax

All tools accept a `scope` parameter:
- `"global"` → `/global`
- `"agent:sales-bot"` → `/agents/sales-bot`
- `"project:ecommerce"` → `/projects/ecommerce`
- `"user:kent"` → `/users/kent`
- `"custom:shared-kb"` → `/custom/shared-kb`

#### Auto-Recall Behavior

The `before_agent_start` hook automatically searches these namespaces in parallel:
1. `/global` — always
2. `/agents/<current-agent-id>` — always
3. Any namespace listed in `scopes.agentAccess` for this agent

Results are merged, sorted by score, filtered by score gap detection, and injected as `<agentcore_memory>` context before each turn.

#### Cross-Agent Sharing Patterns

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
agentcore_store:  scope "project:ecommerce"  → Agent A writes
agentcore_recall: scope "project:ecommerce"  → Agent B reads
```

**Pattern 3: Access control (config-based)**

Configure in `openclaw.json` → `plugins.entries.memory-agentcore.config.scopes`:

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

### Configuration Reference

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
| `namespaceMode` | `"per-agent"` | `AGENTCORE_NAMESPACE_MODE` | Namespace isolation mode |
| `showScores` | `false` | `AGENTCORE_SHOW_SCORES` | Show similarity scores |
| `scoreGapEnabled` | `true` | `AGENTCORE_SCORE_GAP_ENABLED` | Score gap detection filter |
| `scoreGapMultiplier` | `2.0` | `AGENTCORE_SCORE_GAP_MULTIPLIER` | Gap sensitivity (higher=lenient) |
| `minScoreFloor` | `0.0` | `AGENTCORE_MIN_SCORE_FLOOR` | Absolute minimum score (0=disabled) |
| `noisePatterns` | `[]` | `AGENTCORE_NOISE_PATTERNS` | Custom noise regex (comma-separated in env) |
| `bypassPatterns` | `[]` | `AGENTCORE_BYPASS_PATTERNS` | Custom bypass regex (comma-separated in env) |
| `statsCacheTtlMs` | `300000` | `AGENTCORE_STATS_CACHE_TTL_MS` | Stats cache TTL (5 min) |
| `fileSyncEnabled` | `true` | `AGENTCORE_FILE_SYNC_ENABLED` | Sync MEMORY.md/USER.md to AgentCore |
| `eventExpiryDays` | `90` | `AGENTCORE_EVENT_EXPIRY_DAYS` | Short-term event retention |
| `maxRetries` | `3` | `AGENTCORE_MAX_RETRIES` | AWS SDK retry attempts |
| `timeoutMs` | `10000` | `AGENTCORE_TIMEOUT_MS` | Per-request timeout |

### Best Practices

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

### Runtime Troubleshooting

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
