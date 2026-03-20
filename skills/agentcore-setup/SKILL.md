---
name: agentcore-setup
description: Install, configure, and verify the memory-agentcore plugin for Amazon Bedrock AgentCore Memory. Handles the full lifecycle including AWS resource creation, plugin installation, gateway restart, and post-restart verification.
---

# AgentCore Memory Plugin Setup & Verification

You are performing automated setup and verification of the `memory-agentcore` plugin.

## Prerequisites

Before starting, gather these from the user:
- **memoryId**: The AgentCore Memory resource ID (format: `name-XXXXXXXXXX`). If they don't have one, run Phase 0 first.
- **AWS region**: Which region the Memory resource is in (default: `us-west-2`)
- **Repo access**: The repo is public at `https://github.com/kingdoooo/openclaw-agentcore-memory`.

## Checkpoint System

This skill uses a checkpoint file to track progress across gateway restarts.

**FIRST**: Check if a checkpoint file exists:

```bash
cat "$HOME/.openclaw/.agentcore-setup-checkpoint" 2>/dev/null
```

- If the file contains `verify` → Skip to **Phase 2: Verification**
- If the file does not exist or is empty → Start from **Phase 0** or **Phase 1**

---

## Phase 0: AWS Resource Creation

Skip this phase if the user already has a `memoryId`.

### Step 0.1: Pre-flight

```bash
aws sts get-caller-identity 2>&1
aws --version
```

If AWS credentials fail, STOP and tell the user to configure IAM role, env vars, or AWS profile first.

### Step 0.2: Create Memory Resource

> **IMPORTANT**: The control plane API is `bedrock-agentcore-control`, NOT `bedrock-agentcore`.
> - `bedrock-agentcore-control` = control plane (create/delete/list resources)
> - `bedrock-agentcore` = data plane (read/write memory records)

Ask the user which `--region` to use, then run:

The `--memory-strategies` parameter uses **tagged union** format. Each strategy is an object with exactly one top-level key:

```bash
aws bedrock-agentcore-control create-memory \
  --name "openclaw_memory" \
  --description "OpenClaw agent memory" \
  --event-expiry-duration 90 \
  --memory-strategies \
    '{"semanticMemoryStrategy":{"name":"semantic","namespaces":["/semantic"]}}' \
    '{"userPreferenceMemoryStrategy":{"name":"preferences","namespaces":["/preferences"]}}' \
    '{"summaryMemoryStrategy":{"name":"summary","namespaces":["/summary/{sessionId}"]}}' \
    '{"episodicMemoryStrategy":{"name":"episodic","namespaces":["/episodic/{sessionId}"],"reflectionConfiguration":{"namespaces":["/episodic"]}}}' \
  --region <REGION>
```

> **⚠️ CRITICAL**: Summary and episodic strategy namespaces **MUST** contain `{sessionId}` placeholder. The API rejects the request without it.
>
> **Note**: The parameter is `--memory-strategies` (not `--strategies`). Each strategy is a separate argument, not a JSON array.
>
> **Note**: Episodic strategy **requires** `reflectionConfiguration` with a namespace that is a prefix of the episodic namespace (e.g. `/episodic` is a prefix of `/episodic/{sessionId}`). Without it, the API returns a validation error.
>
> All 4 strategies are recommended. If episodic is omitted at creation time, the plugin will still report it in logs but episodic extraction/reflection won't function on the AWS side.

Note the `memoryId` from the response.

### Step 0.3: Verify Memory is ACTIVE

```bash
aws bedrock-agentcore-control get-memory --memory-id "<MEMORY_ID>" --region <REGION>
```

Wait until `status` is `ACTIVE` before proceeding. This usually takes 30-60 seconds.

### Step 0.4: IAM Permissions

Ensure the EC2 instance role (or IAM user) has these data plane permissions:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock-agentcore:CreateEvent",
    "bedrock-agentcore:RetrieveMemoryRecords",
    "bedrock-agentcore:ListMemoryRecords",
    "bedrock-agentcore:GetMemoryRecord",
    "bedrock-agentcore:BatchCreateMemoryRecords",
    "bedrock-agentcore:BatchUpdateMemoryRecords",
    "bedrock-agentcore:DeleteMemoryRecord",
    "bedrock-agentcore:BatchDeleteMemoryRecords"
  ],
  "Resource": "arn:aws:bedrock-agentcore:*:*:memory/*"
}
```

---

## Phase 1: Installation & Configuration

### Step 1.1: Pre-flight Checks

```bash
openclaw status
aws sts get-caller-identity 2>&1
git --version
node --version  # Requires Node.js 18+
```

### Step 1.2: Clone & Build

```bash
PLUGIN_DIR="$HOME/.openclaw/plugins/memory-agentcore"

if [ -d "$PLUGIN_DIR" ]; then
  echo "Repository already exists, pulling latest..."
  cd "$PLUGIN_DIR" && git pull
else
  mkdir -p "$HOME/.openclaw/plugins"
  git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git "$PLUGIN_DIR"
fi

cd "$PLUGIN_DIR"
npm install
npm run build
```

> **⚠️ IMPORTANT**: `npm run build` (TypeScript compilation) is **required**. The plugin loads compiled JS from `dist/`, not TypeScript source.

Verify build succeeded:
```bash
ls "$PLUGIN_DIR/dist/index.js" && echo "Build OK" || echo "Build FAILED"
```

### Step 1.3: Configure Plugin

Use **load path mode** (recommended — allows updating via `git pull && npm run build` without reinstall).

> **⚠️ CRITICAL: All paths in config MUST be absolute. Do NOT use `~`.**
> Gateway runs as a Node.js process. Unlike bash, it does **NOT** expand `~`.
> Using `~` causes `plugins.load failed` error on every restart.

Determine the absolute path:
```bash
PLUGIN_DIR="$(cd "$HOME/.openclaw/plugins/memory-agentcore" && pwd)"
echo "Absolute path: $PLUGIN_DIR"
```

Now edit `~/.openclaw/openclaw.json`. You must **merge** into the existing config, not overwrite it.

Use this Python script to safely merge the plugin config:

```bash
python3 -c "
import json, os

config_path = os.path.expanduser('~/.openclaw/openclaw.json')
plugin_dir = os.path.expanduser('~/.openclaw/plugins/memory-agentcore')
plugin_dir = os.path.realpath(plugin_dir)  # Absolute path

with open(config_path, 'r') as f:
    cfg = json.load(f)

# Ensure plugins section exists
cfg.setdefault('plugins', {})
cfg['plugins'].setdefault('allow', [])
cfg['plugins'].setdefault('entries', {})

# Add to allow list if not present
if 'memory-agentcore' not in cfg['plugins']['allow']:
    cfg['plugins']['allow'].append('memory-agentcore')

# Set load path
cfg['plugins']['load'] = {'paths': [plugin_dir]}

# Set plugin config — ask user for memoryId and region
cfg['plugins']['entries']['memory-agentcore'] = {
    'enabled': True,
    'config': {
        'memoryId': '<MEMORY_ID>',
        'awsRegion': '<REGION>'
    }
}

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print('Config updated successfully')
print(f'  load.paths: [{plugin_dir}]')
print(f'  memoryId: <MEMORY_ID>')
print(f'  awsRegion: <REGION>')
"
```

**Replace `<MEMORY_ID>` and `<REGION>` with actual values before running.**

> **Alternative: `openclaw plugins install .`** (production mode) copies the plugin to `~/.openclaw/extensions/`. But do NOT use both methods — you'll get a `duplicate plugin id` warning.

### Step 1.4: Write Checkpoint & Restart

```bash
echo "verify" > "$HOME/.openclaw/.agentcore-setup-checkpoint"
```

Tell the user:

> "Plugin installed and configured. I need to restart the gateway. After restart, send me any message and I'll run verification."

Then restart:

```bash
openclaw gateway restart
```

> **Note**: Gateway defers restart until active operations complete (up to 90s). The `⚠️ 🔌 Gateway failed` message during restart is **normal** — it's the WebSocket reconnecting, not an actual failure.

---

## Phase 2: Verification

**Entry condition**: Checkpoint file contains `verify`.

### Pre-check: Verify plugin loaded

Before using agentcore tools, confirm the plugin actually loaded. If it didn't, the tools won't exist.

```bash
openclaw plugins list 2>&1 | grep "memory-agentcore"
```

If not found, check logs and troubleshoot (see Troubleshooting section) before continuing.

```bash
grep -i "load failed\|duplicate plugin\|agentcore.*error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null \
  | grep -v "deliver called\|tool call\|tool done" | tail -5
```

### Test 1: Connection Status

```bash
openclaw agentcore-status 2>&1
```

Check output contains `Connection: OK`. If `FAILED`, check AWS credentials and memoryId.

### Test 2: Tool - Store Memory

Use the `agentcore_store` tool:
- content: `"AgentCore setup verification test - installed on <today's date>"`
- category: `"fact"`
- importance: `0.8`
- scope: `"global"`
- tags: `["setup-test", "verification"]`

**PASS** if `"stored": true`. Save the `recordId` for Tests 5 and 7.

### Test 3: Tool - Recall Memory

Use the `agentcore_recall` tool:
- query: `"AgentCore setup verification test"`
- limit: `3`

**PASS** if results contain the test record.

> **Known behavior**: For newly created Memory resources, semantic search may return 0 results for the first few minutes (index warm-up). If empty, verify via `agentcore_search` (list mode). Mark **PARTIAL** if list finds data but recall is empty.

### Test 4: Tool - Search (List)

Use the `agentcore_search` tool:
- scope: `"global"`
- max_results: `5`

**PASS** if returns without error and shows the test record.

### Test 5: Tool - Correct

Use the `agentcore_correct` tool:
- record_id: `<ID from Test 2>`
- new_content: `"AgentCore setup verification - CORRECTED - plugin working correctly"`

**PASS** if `"corrected": true`.

### Test 6: Tool - Stats

Use the `agentcore_stats` tool:
- scope: `"global"`

**PASS** if `"connected": true`.

### Test 7: Tool - Share

Use the `agentcore_share` tool:
- content: `"Shared verification: memory-agentcore is operational"`
- target_scopes: `["agent:test-agent"]`
- category: `"fact"`

**PASS** if `"shared": true`.

### Test 8: Tool - Forget (Cleanup)

Clean up ALL test records:

1. Use `agentcore_forget`:
   - search_query: `"AgentCore setup verification"`
   - confirm: `true`
   - scope: `"global"`

2. Use `agentcore_forget`:
   - search_query: `"memory-agentcore is operational"`
   - confirm: `true`
   - scope: `"agent:test-agent"`

**PASS** if `"deleted": true` (or count >= 1).

### Test 9: File Sync

```bash
openclaw agentcore-sync 2>&1
```

**PASS** if output contains `Synced` (0 or more files OK, no error).

### Test 10: CLI Remember + Cleanup

```bash
openclaw agentcore-remember "CLI remember test from setup verification"
```

**PASS** if output says `Stored`.

Then clean up via `agentcore_forget`:
- search_query: `"CLI remember test"`
- confirm: `true`

### Test 11: Episodic Search

Use the `agentcore_episodes` tool:
- query: `"verification test"`
- top_k: `3`

May return 0 results (episodic needs conversation events). **PASS** if no error.

### Test 12: Runtime Error Check

```bash
# Find plugin load timestamp
LOAD_TIME=$(grep "agentcore.*Plugin loaded" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | tail -1 | grep -o '"date":"[^"]*"' | cut -d'"' -f4)
echo "Plugin loaded at: $LOAD_TIME"

# Check for errors after plugin load
grep -i "agentcore.*error\|auto-capture error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null \
  | grep -v "deliver called\|tool call\|tool done" | tail -5
```

**PASS** if no errors after plugin load time.

### Results Summary

Remove the checkpoint:

```bash
rm -f "$HOME/.openclaw/.agentcore-setup-checkpoint"
```

Report:

```
=== memory-agentcore Verification Results ===

 Pre. Plugin Load:     [PASS/FAIL]
  1.  Connection:      [PASS/FAIL]
  2.  Store Memory:    [PASS/FAIL]
  3.  Recall Memory:   [PASS/FAIL/PARTIAL]
  4.  Search/List:     [PASS/FAIL]
  5.  Correct Memory:  [PASS/FAIL]
  6.  Stats:           [PASS/FAIL]
  7.  Share Memory:    [PASS/FAIL]
  8.  Forget/Delete:   [PASS/FAIL]
  9.  File Sync:       [PASS/FAIL]
 10.  CLI Remember:    [PASS/FAIL]
 11.  Episodic Search: [PASS/FAIL]
 12.  Runtime Errors:  [PASS/FAIL]

Total: X/12 passed (Pre-check excluded from count)
```

---

## Phase 3: New Features Verification (v0.2)

Tests for features added in the score-gap/purge/retry/noise update. Run these after Phase 2 passes.

### Pre-check: Enable showScores

Several tests below need to see similarity scores. Temporarily enable `showScores` in the plugin config:

```bash
python3 -c "
import json, os
config_path = os.path.expanduser('~/.openclaw/openclaw.json')
with open(config_path, 'r') as f:
    cfg = json.load(f)
cfg['plugins']['entries']['memory-agentcore']['config']['showScores'] = True
with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print('showScores enabled')
"
```

Then restart gateway:

```bash
openclaw gateway restart
```

### Test N1: Score Gap Detection — Basic

Seed 5 records with varying relevance, then search and observe score-based filtering.

**Step 1: Seed test data**

Use `agentcore_store` to create 5 records:
1. content: `"The user prefers dark mode and monospace fonts for coding"`, category: `"preference"`, scope: `"global"`
2. content: `"The user's favorite programming language is TypeScript"`, category: `"preference"`, scope: `"global"`
3. content: `"TypeScript supports generics, union types, and mapped types"`, category: `"fact"`, scope: `"global"`
4. content: `"The weather in Tokyo was sunny last Tuesday"`, category: `"fact"`, scope: `"global"`
5. content: `"Bananas are a good source of potassium"`, category: `"fact"`, scope: `"global"`

> Records 4-5 are intentionally irrelevant to create a score gap when searching for user preferences.

**Step 2: Search and observe filtering**

Use `agentcore_recall`:
- query: `"What are the user's coding preferences?"`
- limit: `5`

**PASS criteria**:
- Tool returns results without errors
- Results include `score` field (showScores is enabled)
- If score gap filtering is active: irrelevant records (weather, bananas) may be excluded. This depends on the actual score distribution — the algorithm filters results where the score drop between adjacent results exceeds 2x the mean drop.
- Even if all 5 are returned (scores may be evenly spaced), the test passes as long as results are returned with scores visible.

> **Note**: Score gap detection is most effective when there's a clear "cliff" in relevance. With a new memory resource, the index may not produce dramatic gaps yet. The key test is that the feature doesn't break recall.

### Test N2: Score Gap Detection — Disabled

Verify that disabling score gap returns the same or more results.

**Step 1**: Temporarily disable score gap by setting environment variable:

```bash
export AGENTCORE_SCORE_GAP_ENABLED=false
```

Restart gateway, then use `agentcore_recall`:
- query: `"What are the user's coding preferences?"`
- limit: `5`

**Step 2**: Compare with Test N1 results. With gap detection disabled, the result count should be >= the count from Test N1.

**Step 3**: Re-enable (unset env var and restart):

```bash
unset AGENTCORE_SCORE_GAP_ENABLED
openclaw gateway restart
```

**PASS** if disabled mode returns >= results than enabled mode (or equal if no gap was detected).

### Test N3: Stats Cache

Call `agentcore_stats` twice in quick succession and verify cache behavior.

**Step 1**: Use `agentcore_stats` tool:
- scope: `"global"`

Note the response. It should contain `"cacheHit": false` (first call, cache cold).

**Step 2**: Immediately use `agentcore_stats` again with the same scope.

**PASS** if the second call returns `"cacheHit": true`. This confirms the 5-minute TTL in-memory cache is working.

### Test N4: Purge — Tool Preview (Dry Run)

Use `agentcore_forget` tool:
- purge_scope: `true`
- scope: `"agent:purge-test"`
- confirm: `false`

**PASS** if response contains `"purge_preview": true` and `"estimated_count"` field (likely 0 for a fresh scope). This verifies the preview mode works without deleting anything.

### Test N5: Purge — Full Cycle

**Step 1: Seed data in a test scope**

Use `agentcore_store` to create 3 records in scope `"agent:purge-test"`:
1. content: `"Purge test record A"`, scope: `"agent:purge-test"`
2. content: `"Purge test record B"`, scope: `"agent:purge-test"`
3. content: `"Purge test record C"`, scope: `"agent:purge-test"`

**Step 2: Preview purge**

Use `agentcore_forget`:
- purge_scope: `true`
- scope: `"agent:purge-test"`
- confirm: `false`

Verify `estimated_count` >= 3.

**Step 3: Execute purge**

Use `agentcore_forget`:
- purge_scope: `true`
- scope: `"agent:purge-test"`
- confirm: `true`

**PASS** if `"purged": true` and `"count"` >= 3.

**Step 4: Verify empty**

Use `agentcore_search`:
- scope: `"agent:purge-test"`
- max_results: `5`

**PASS** if returns 0 records.

### Test N6: Purge — CLI

```bash
openclaw agentcore-purge global
```

**PASS** if output contains `[DRY RUN] Would delete` (doesn't actually delete without `--confirm`).

> **⚠️ WARNING**: Do NOT run `openclaw agentcore-purge global --confirm` during testing unless you want to delete all global records. Use a dedicated test scope (e.g., `agent:purge-test`) for destructive tests.

### Test N7: Correct with Retry

The exponential backoff retry (200ms → 400ms → 800ms) is transparent — it only activates on 5xx/ThrottlingException errors. This test verifies the correct tool still works normally with the retry wrapper.

Use `agentcore_store`:
- content: `"Retry test: original content"`
- scope: `"global"`

Note the `recordId`, then use `agentcore_correct`:
- record_id: `<ID from store>`
- new_content: `"Retry test: CORRECTED content"`

**PASS** if `"corrected": true, "method": "update"`.

Then clean up:
Use `agentcore_forget`:
- record_ids: `[<ID from store>]`

### Test N8: Configurable Noise Filter — Verify Defaults

The noise filter now supports user-defined `noisePatterns` and `bypassPatterns` (both default to empty arrays). Verify the default behavior is unchanged.

Check that built-in noise filtering still works by triggering auto-capture:

1. Send a greeting message like `"hello"` in a conversation
2. Check logs for noise filter activity:

```bash
grep -i "auto-capture\|auto-recall\|noise" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | tail -10
```

**PASS** if no errors in logs. The greeting should be filtered by the built-in patterns (you should see the auto-capture not triggering for simple greetings).

### Phase 3 Cleanup

Clean up the seed data from Test N1:

Use `agentcore_forget`:
- search_query: `"dark mode monospace fonts"`
- confirm: `true`
- scope: `"global"`

Use `agentcore_forget`:
- search_query: `"favorite programming language TypeScript"`
- confirm: `true`
- scope: `"global"`

Use `agentcore_forget`:
- search_query: `"TypeScript supports generics"`
- confirm: `true`
- scope: `"global"`

Use `agentcore_forget`:
- search_query: `"weather in Tokyo"`
- confirm: `true`
- scope: `"global"`

Use `agentcore_forget`:
- search_query: `"Bananas potassium"`
- confirm: `true`
- scope: `"global"`

### Restore showScores

```bash
python3 -c "
import json, os
config_path = os.path.expanduser('~/.openclaw/openclaw.json')
with open(config_path, 'r') as f:
    cfg = json.load(f)
cfg['plugins']['entries']['memory-agentcore']['config']['showScores'] = False
with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print('showScores restored to false')
"
openclaw gateway restart
```

### Phase 3 Results

```
=== memory-agentcore New Features (v0.2) ===

 N1. Score Gap — Basic:       [PASS/FAIL]
 N2. Score Gap — Disabled:    [PASS/FAIL]
 N3. Stats Cache:             [PASS/FAIL]
 N4. Purge — Preview:         [PASS/FAIL]
 N5. Purge — Full Cycle:      [PASS/FAIL]
 N6. Purge — CLI:             [PASS/FAIL]
 N7. Correct with Retry:      [PASS/FAIL]
 N8. Noise Filter Defaults:   [PASS/FAIL]

Total: X/8 passed
```

---

## Known Issues & Troubleshooting

### Plugin Load Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `plugins.load failed` | `~` in `plugins.load.paths` | Use absolute path (`$HOME` expanded) |
| `duplicate plugin id detected` | Plugin in both `load.paths` AND `extensions/` | Remove `~/.openclaw/extensions/memory-agentcore/` |
| `missing openclaw.extensions` | Missing field in package.json | Should be fixed in latest version; run `git pull && npm run build` |
| `must have required property 'memoryId'` | Wrong config nesting | Must be `plugins.entries.memory-agentcore.config.memoryId` |

### Gateway Restart

- `⚠️ 🔌 Gateway failed` during restart = **normal** (WebSocket reconnecting)
- Gateway defers restart up to 90s for active operations
- If `config.patch` fails with `invalid config`, edit `openclaw.json` directly (Python/jq)

### AWS API

| Issue | Detail |
|-------|--------|
| Control vs data plane | Resources: `bedrock-agentcore-control`. Records: `bedrock-agentcore`. |
| SUMMARIZATION namespace | **Must** contain `{sessionId}`. API rejects without it. |
| Memory not ready | Must be `ACTIVE` before use. Poll with `get-memory`. |
| Recall returns empty | New resources need index warm-up (5-10 min). Use `agentcore_search` to verify data exists. |

### Update Workflow

```bash
cd "$HOME/.openclaw/plugins/memory-agentcore"
git pull
npm run build
openclaw gateway restart
```
