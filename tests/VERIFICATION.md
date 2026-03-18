# memory-agentcore Verification Plan

## Prerequisites

1. OpenClaw installed and running on EC2 (`openclaw status` shows healthy)
2. AWS credentials configured on the EC2 instance (IAM role, env vars, or profile)
3. An AgentCore Memory resource created in AWS (get the `memoryId`)
4. Plugin installed (see Deployment section below)

## Quick Pre-flight

```bash
# 1. Verify OpenClaw healthy
openclaw status
openclaw gateway status

# 2. Verify AWS credentials
aws sts get-caller-identity

# 3. Verify plugin loaded
openclaw plugins list | grep memory-agentcore

# 4. Verify plugin doctor
openclaw plugins doctor
```

---

## Step-by-Step Verification (9 Steps)

### Step 1: Plugin Load & Config Validation

**What**: Plugin loads without errors, config is parsed correctly.

```bash
# Check plugin appears in list
openclaw plugins list

# Check plugin info
openclaw plugins info memory-agentcore

# Check gateway logs for successful load
openclaw logs --follow --filter="agentcore"
# Expected: "[agentcore] Plugin loaded (memory=mem-xxx, region=us-east-1, strategies=SEMANTIC,...)"
```

**Pass criteria**: Plugin listed, no error logs, log shows "Plugin loaded".

---

### Step 2: Connection Status (CLI)

**What**: AWS connectivity + config display via CLI.

```bash
openclaw agentcore status
```

**Expected output**:
```
AgentCore Memory Status
  Memory ID: mem-xxxxxxxxxx
  Region:    us-east-1
  Strategies: SEMANTIC, USER_PREFERENCE, EPISODIC, SUMMARY
  Auto-recall: top 5
  Auto-capture: true
  Noise filter: true
  File sync: true
  Connection: OK
```

**Pass criteria**: `Connection: OK` (not `FAILED`).

---

### Step 3: Manual Store (Tool)

**What**: Agent can use `agentcore_store` to save a memory.

Send to the agent (via TUI, WhatsApp, or CLI):

```
Use the agentcore_store tool to save this fact: "The project deadline is March 30, 2026" with category "fact" and importance 0.9
```

**Verify via CLI**:
```bash
openclaw agentcore search "project deadline"
```

**Pass criteria**: Tool returns `{ stored: true, recordIds: [...] }`. CLI search finds the record.

---

### Step 4: Manual Recall (Tool)

**What**: Agent can use `agentcore_recall` to search stored memories.

Send to the agent:

```
Use the agentcore_recall tool to search for "deadline"
```

**Pass criteria**: Tool returns the record stored in Step 3 with matching content.

---

### Step 5: Memory Correction (Tool)

**What**: `agentcore_correct` can update an existing record.

Send to the agent:

```
Use agentcore_correct to update the record from the previous recall. Change the deadline to "April 15, 2026".
```

**Pass criteria**: Returns `{ corrected: true, method: "update" }`.

**Verify**: Recall again to confirm updated content.

---

### Step 6: Auto-Capture (agent_end Hook)

**What**: Conversations are automatically captured after each agent turn.

1. Have a meaningful conversation (NOT greetings):
   ```
   Explain the differences between DynamoDB and Aurora for a high-write workload.
   Our team decided to use DynamoDB for the event-sourcing pipeline because of its
   single-digit millisecond latency at any scale.
   ```

2. Wait a few seconds for fire-and-forget capture.

3. Verify event was created:
   ```bash
   openclaw agentcore list --strategy SEMANTIC
   ```

**Pass criteria**: List shows records extracted from the conversation (AgentCore strategies process events asynchronously, may take 30-60 seconds).

---

### Step 7: Auto-Recall (before_agent_start Hook)

**What**: Relevant memories are automatically injected before each agent turn.

1. Start a **new session** (`/new` in the agent).

2. Ask a question related to previously stored memories:
   ```
   What was the deadline for our project?
   ```

3. The agent should know the answer from auto-recalled memories WITHOUT you telling it again.

4. Check logs for confirmation:
   ```bash
   openclaw logs --follow --filter="agentcore"
   # Expected: NOT "Auto-recall skipped" for this query
   ```

**Pass criteria**: Agent answers with the deadline info from memory. Logs show auto-recall executed (no "skipped" message).

---

### Step 8: GDPR Forget (Tool)

**What**: Records can be previewed and deleted.

1. Preview deletion:
   ```
   Use agentcore_forget with search_query "deadline" to preview what would be deleted
   ```
   **Expected**: Returns preview list with record IDs.

2. Delete:
   ```
   Use agentcore_forget to delete those records by their IDs: [paste IDs from preview]
   ```
   **Expected**: `{ deleted: true, count: N }`

3. Verify deletion:
   ```bash
   openclaw agentcore search "deadline"
   ```
   **Expected**: No records found.

**Pass criteria**: Preview returns records, delete succeeds, search confirms deletion.

---

### Step 9: File Sync

**What**: Local markdown files sync to AgentCore.

1. Create or modify a memory file in the workspace:
   ```bash
   echo "# Team Preferences\n- Code reviews within 24h\n- Use TypeScript for all new services" \
     > ~/.openclaw/workspace/MEMORY.md
   ```

2. Trigger sync manually:
   ```bash
   openclaw agentcore sync
   ```
   **Expected**: `Synced 1 files.`

3. Trigger sync again (no changes):
   ```bash
   openclaw agentcore sync
   ```
   **Expected**: `Synced 0 files.` (hash hasn't changed)

4. Modify the file and sync again:
   ```bash
   echo "\n- Deploy on Fridays is forbidden" >> ~/.openclaw/workspace/MEMORY.md
   openclaw agentcore sync
   ```
   **Expected**: `Synced 1 files.` (hash changed)

**Pass criteria**: First sync = 1 file, second sync = 0 files, third sync = 1 file after modification.

---

## Optional: Advanced Verification

### Noise Filter Check

Send these and verify they are NOT captured:
```
hi
ok
/status
...
```

Then send something meaningful and verify it IS captured.

### Adaptive Retrieval Check

Check logs after sending a trivial query:
```
yes
```
Expected log: `[agentcore] Auto-recall skipped: skip pattern match`

Check logs after a real query:
```
What do we know about the architecture decisions?
```
Expected: No "skipped" log, auto-recall executes.

### Episodic Memory

```
Use agentcore_episodes to search for "error handling patterns"
```

(Requires EPISODIC strategy to have extracted episodic records from past conversations)

### Stats

```bash
openclaw agentcore stats
openclaw agentcore stats --scope agent:main
```

---

## Automated Smoke Test Script

Save as `tests/smoke-test.sh` and run on the EC2 instance:

```bash
#!/bin/bash
set -e

PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  local expected="$3"

  echo -n "  [$name] ... "
  result=$(eval "$cmd" 2>&1) || true

  if echo "$result" | grep -q "$expected"; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    echo "    Expected: $expected"
    echo "    Got: $result" | head -5
    FAIL=$((FAIL + 1))
  fi
}

echo "=== memory-agentcore Smoke Test ==="
echo ""

echo "1. Plugin Load"
check "plugin-listed" "openclaw plugins list" "memory-agentcore"

echo ""
echo "2. Connection"
check "connection-ok" "openclaw agentcore status" "Connection: OK"

echo ""
echo "3. CLI Search (baseline)"
check "search-empty" "openclaw agentcore search 'smoke-test-unique-marker-$(date +%s)'" "No records found"

echo ""
echo "4. Stats"
check "stats-connected" "openclaw agentcore stats" "SEMANTIC"

echo ""
echo "5. File Sync"
SYNC_TEST_FILE="$(mktemp)"
echo "# Smoke test $(date)" > "$SYNC_TEST_FILE"
check "sync-runs" "openclaw agentcore sync" "Synced"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Plugin not listed | Not installed or disabled | `openclaw plugins install .` + check `plugins.entries` config |
| Connection: FAILED | AWS creds invalid or memoryId wrong | `aws sts get-caller-identity`, check memoryId |
| Auto-recall skipped for everything | `adaptiveRetrievalEnabled` too aggressive | Set `autoRecallTopK: 0` to disable, or check min query length |
| Auto-capture not creating events | Noise filter blocking, or minLength too high | Check `autoCaptureMinLength`, try `noiseFilterEnabled: false` |
| File sync always 0 | Files don't exist at configured paths | Check `fileSyncPaths` matches actual file locations |
| Tools not appearing | Plugin not loaded, or gateway not restarted | `openclaw gateway restart` |
| 403 from AWS | IAM permissions missing | Ensure `bedrock-agentcore:*` permissions on the EC2 role |
