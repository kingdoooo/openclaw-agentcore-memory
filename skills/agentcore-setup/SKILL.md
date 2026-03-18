---
name: agentcore-setup
description: Install, configure, and verify the memory-agentcore plugin for Amazon Bedrock AgentCore Memory. Handles the full lifecycle including gateway restart and post-restart verification.
---

# AgentCore Memory Plugin Setup & Verification

You are performing automated setup and verification of the `memory-agentcore` plugin.

## Checkpoint System

This skill uses a checkpoint file at `~/.openclaw/.agentcore-setup-checkpoint` to track progress across gateway restarts.

**FIRST**: Check if a checkpoint file exists:

```bash
cat ~/.openclaw/.agentcore-setup-checkpoint 2>/dev/null
```

- If the file contains `verify` → Skip to **Phase 2: Verification**
- If the file does not exist or is empty → Start from **Phase 1: Installation**

---

## Phase 1: Installation & Configuration

### Step 1.1: Pre-flight Checks

Run these checks and report any failures before proceeding:

```bash
# Check OpenClaw is running
openclaw status

# Check AWS credentials are configured
aws sts get-caller-identity 2>&1

# Check git is available
git --version
```

If AWS credentials fail, STOP and tell the user:
> "AWS credentials are not configured on this machine. Please set up IAM role, env vars, or AWS profile first."

### Step 1.2: Clone Repository

```bash
if [ -d ~/projects/openclaw-agentcore-memory ]; then
  echo "Repository already exists, pulling latest..."
  cd ~/projects/openclaw-agentcore-memory && git pull
else
  mkdir -p ~/projects
  git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git ~/projects/openclaw-agentcore-memory
fi
```

### Step 1.3: Install Dependencies

```bash
cd ~/projects/openclaw-agentcore-memory
npm install 2>&1
```

If npm is not available, try `bun install`.

### Step 1.4: Install Plugin

```bash
openclaw plugins install -l ~/projects/openclaw-agentcore-memory
```

Using `-l` (link mode) so future `git pull` updates take effect without reinstall.

### Step 1.5: Configure Plugin

Ask the user for their `memoryId` if not already known. Then configure:

```bash
openclaw config set plugins.entries.memory-agentcore.enabled true
openclaw config set plugins.entries.memory-agentcore.config.memoryId "<MEMORY_ID>"
```

If `openclaw config set` doesn't support nested plugin config, edit the config file directly. Read `~/.openclaw/openclaw.json`, add the following under `plugins.entries`:

```json5
"memory-agentcore": {
  enabled: true,
  config: {
    memoryId: "<MEMORY_ID>",
    // awsRegion defaults to us-east-1
  },
}
```

**IMPORTANT**: Preserve all existing config. Only ADD the memory-agentcore entry.

### Step 1.6: Write Checkpoint & Prepare for Restart

```bash
echo "verify" > ~/.openclaw/.agentcore-setup-checkpoint
```

### Step 1.7: Restart Gateway

Tell the user:

> "Plugin installed and configured. I need to restart the gateway for the plugin to load. After restart, send me any message and I will automatically run verification."

Then execute:

```bash
openclaw gateway restart
```

The connection will drop. This is expected.

---

## Phase 2: Verification

**Entry condition**: Checkpoint file contains `verify`.

Run each test sequentially. Collect results and report a summary at the end.

### Test 1: Plugin Load

```bash
openclaw plugins list 2>/dev/null | grep -q "memory-agentcore" && echo "PASS" || echo "FAIL"
```

### Test 2: Connection Status

```bash
openclaw agentcore-status 2>&1
```

Check that output contains `Connection: OK`. If it says `FAILED`, report the error.

### Test 3: CLI Search (Baseline)

```bash
openclaw agentcore-search "setup-verification-baseline-test" 2>&1
```

Expected: `No records found` (baseline).

### Test 4: Tool - Store Memory

Use the `agentcore_store` tool:

```
content: "AgentCore setup verification test record - installed on <today's date>"
category: "fact"
importance: 0.8
scope: "global"
tags: ["setup-test", "verification"]
```

Check that the result contains `"stored": true`.

### Test 5: Tool - Recall Memory

Use the `agentcore_recall` tool:

```
query: "AgentCore setup verification test record"
limit: 3
```

Check that results contain the record from Test 4.

### Test 6: Tool - Search (List)

Use the `agentcore_search` tool:

```
scope: "global"
max_results: 5
```

Check that it returns without error.

### Test 7: Tool - Stats

Use the `agentcore_stats` tool:

```
scope: "global"
```

Check that `"connected": true`.

### Test 8: Tool - Correct

Use the `agentcore_correct` tool to update the test record from Test 4:

```
record_id: <ID from Test 4>
new_content: "AgentCore setup verification - CORRECTED - plugin working correctly"
```

Check that `"corrected": true`.

### Test 9: Tool - Share

Use the `agentcore_share` tool:

```
content: "Shared verification fact: memory-agentcore is operational"
target_scopes: ["agent:test-agent"]
category: "fact"
```

Check that `"shared": true`.

### Test 10: Tool - Forget (Cleanup)

Use the `agentcore_forget` tool to clean up all test records:

```
search_query: "AgentCore setup verification"
confirm: true
scope: "global"
```

Check that `"deleted": true`.

### Test 11: File Sync

```bash
openclaw agentcore-sync 2>&1
```

Check output contains `Synced` (0 or more files is OK, as long as no error).

### Test 12: CLI Remember

```bash
openclaw agentcore-remember "CLI remember test from setup verification"
```

Check output says `Stored`.

Then clean up:

```bash
openclaw agentcore-search "CLI remember test" --show-ids 2>&1
# Delete by ID if found
```

### Test 13: Episodic Search

Use the `agentcore_episodes` tool:

```
query: "verification test"
top_k: 3
```

May return 0 results (episodic needs time to extract). No error = pass.

### Results Summary

After all tests, remove the checkpoint:

```bash
rm -f ~/.openclaw/.agentcore-setup-checkpoint
```

Then report:

```
=== memory-agentcore Verification Results ===

 1. Plugin Load:     [PASS/FAIL]
 2. Connection:      [PASS/FAIL]
 3. CLI Search:      [PASS/FAIL]
 4. Store Memory:    [PASS/FAIL]
 5. Recall Memory:   [PASS/FAIL]
 6. Search/List:     [PASS/FAIL]
 7. Stats:           [PASS/FAIL]
 8. Correct Memory:  [PASS/FAIL]
 9. Share Memory:    [PASS/FAIL]
10. Forget/Delete:   [PASS/FAIL]
11. File Sync:       [PASS/FAIL]
12. CLI Remember:    [PASS/FAIL]
13. Episodic Search: [PASS/FAIL]

Total: X/13 passed
```

### Troubleshooting (If Tests Fail)

- **Plugin not loaded**: `openclaw plugins list`, verify `plugins.entries` config, restart gateway
- **Connection FAILED**: `aws sts get-caller-identity`, verify memoryId is correct
- **Store/Recall fail**: Check IAM permissions include `bedrock-agentcore:*`
- **File sync error**: Check workspace has MEMORY.md or USER.md files
- **Share fail**: Target scope namespace may not exist yet; this is OK for first run
