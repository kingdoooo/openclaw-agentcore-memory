---
name: agentcore-memory-validation
description: Verify the memory-agentcore plugin — 25 automated tests in 7 groups, zero restarts.
---

# AgentCore Memory — Verification

Run all tests in order and report results. If a test fails, continue to the next — report everything at the end.

For usage guidance (tool reference, shared memory, config, best practices), use `agentcore-memory-guide`.

---

## Pre-check: Plugin Loaded

```bash
openclaw plugins list 2>&1 | grep "memory-agentcore"
```

Record plugin version for the report:

```bash
grep '"version"' node_modules/memory-agentcore/package.json 2>/dev/null || grep '"version"' package.json 2>/dev/null | head -1
```

If the plugin is not found, check logs:

```bash
grep -i "load failed\|duplicate plugin\|agentcore.*error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null \
  | grep -v "deliver called\|tool call\|tool done" | tail -5
```

If the plugin didn't load, STOP and troubleshoot (see Runtime Troubleshooting in `agentcore-memory-guide`).

Record the start time for duration tracking.

---

## Group A: Connection & Environment

### Test 1: Connection Status

```bash
openclaw agentcore-status 2>&1
```

**PASS** if `Connection: OK` and `Ready: true`.

### Test 2: Stats Baseline

Use `agentcore_stats`:
- scope: `"global"`

**PASS** if `"connected": true` AND `memoryId` is present AND `strategies` array is non-empty.

**Important**: Save the following from the response for later tests:
- The agent's own ID — extract from `namespace` field or config (e.g., if namespace shows `/agents/bija`, the agent ID is `bija`). If the namespace is `/global` only, check `agentcore-status` output for the agent identity.
- Note whether we're in DM mode — if the response mentions `/users/` in any namespace context, DM mode is active.

---

## Group B: CRUD

### Test 3: Store Memory

Use `agentcore_store`:
- content: `"AgentCore verification test - plugin working"`
- category: `"fact"`
- importance: `0.8`
- scope: `"global"`
- tags: `["verification"]`

**PASS** if `"stored": true` AND `recordIds` array is non-empty.

**Save** the first `recordId` — needed for Tests 4-6 and 9.

### Test 4: Recall Memory

Use `agentcore_recall`:
- query: `"AgentCore verification test"`
- limit: `3`
- scope: `"global"`

**PASS** if results contain the test record (match by content substring).

> **Known behavior**: New Memory resources may return 0 results for the first few minutes (index warm-up). If empty, verify the record exists via Test 5. Mark **PARTIAL**.

### Test 5: Search (List Mode)

Use `agentcore_search`:
- scope: `"global"`
- max_results: `5`

**PASS** if returns without error AND `count >= 1` AND the test record from Test 3 is visible.

### Test 6: Correct (In-place Update)

Use `agentcore_correct`:
- record_id: `<recordId from Test 3>`
- new_content: `"AgentCore verification - CORRECTED - plugin working correctly"`

**PASS** if `"corrected": true` AND `"method": "update"`.

### Test 7: Correct (Fallback Create)

Use `agentcore_correct`:
- record_id: `"nonexistent-verification-000000"`
- new_content: `"AgentCore verification - fallback create test"`

**PASS** if `"corrected": true` AND `"method": "create"` AND `newRecordIds` array is non-empty.

**Save** the `newRecordIds`.

**Cleanup** (execute immediately): Use `agentcore_forget` with `record_ids: [<newRecordIds>]`, `confirm: true`.

### Test 8: Share

Use `agentcore_share`:
- content: `"Shared verification: memory-agentcore is operational"`
- target_scopes: `["global"]`
- category: `"fact"`

**PASS** if `"shared": true` AND `recordIds` is non-empty.

**Save** the `recordIds` for cleanup in Test 9.

### Test 9: Forget + Verify

Delete all records created in Group B using saved `record_ids` (NOT search_query — avoids index delay):

Use `agentcore_forget`:
- record_ids: `[<recordId from Test 3>, <recordIds from Test 8>]`
- confirm: `true`

**PASS** if `"deleted": true`.

**Verify**: Use `agentcore_search` with scope `"global"` and check that none of the test strings appear.

---

## Group C: Advanced Features

### Test 10: Recall All-Namespace (No Scope)

**Step 1**: Store a record:

Use `agentcore_store`:
- content: `"All-namespace recall verification test"`
- scope: `"global"`

**Save** the `recordId`.

**Step 2**: Recall WITHOUT scope:

Use `agentcore_recall`:
- query: `"All-namespace recall verification"`
- limit: `5`
- *(do NOT pass `scope`)*

**PASS** if results contain the test record. This confirms that `agentcore_recall` without scope searches all accessible namespaces (same behavior as auto-recall).

> If result count is 0, this may be due to index warm-up. Mark **PARTIAL** and verify the record exists via `agentcore_search` with scope `"global"`.

**Cleanup**: `agentcore_forget` with `record_ids: [<recordId>]`, `confirm: true`.

### Test 11: Default Scope Detection

This test verifies the smart default scope feature. In DM sessions, store/forget default to `user:{peerId}`. In non-DM sessions, they default to `global`.

**Part A — Store without scope**:

Use `agentcore_store`:
- content: `"Default scope detection test"`
- *(do NOT pass `scope`)*

Check the `namespace` field in the response:
- If `namespace` = `/global` → **non-DM mode** detected
- If `namespace` starts with `/users/` → **DM mode** detected

**Save** the `recordId` and the detected mode.

**Part B — Forget preview without scope**:

Use `agentcore_forget`:
- search_query: `"Default scope detection"`
- confirm: `false`
- *(do NOT pass `scope`)*

Check the response. In DM mode, the preview should search within the user namespace (not global). In non-DM mode, it searches global.

**PASS** if Part A returns a `namespace` field AND Part B returns without error. Report the detected mode (DM or non-DM).

**Cleanup**: `agentcore_forget` with `record_ids: [<recordId from Part A>]`, `confirm: true`.

### Test 12: Episodic Search

Use `agentcore_episodes`:
- query: `"verification test"`
- actor_id: `<agent's own ID from Test 2>`
- top_k: `3`

May return 0 results (episodic needs prior conversation events). **PASS** if no error.

> **Important**: Always pass `actor_id` — omitting it in per-agent mode can cause permission errors.

### Test 13: Stats Cache

Use `agentcore_stats` with scope `"global"`. Note `"cacheHit"` value.

Immediately call `agentcore_stats` again with the same scope.

**PASS** if second call returns `"cacheHit": true`.

### Test 14: File Sync

```bash
openclaw agentcore-sync 2>&1
```

**PASS** if output contains `Synced` or `No changes to sync` (both are acceptable, no error).

---

## Group D: Filtering & Quality

### Test 15: Score Gap Detection

**Step 1: Seed test data**

Use `agentcore_store` to create 5 records in scope `"global"`. **Save all 5 recordIds**.

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
- scope: `"global"`

**PASS** if results return without error. If result count < 5, score gap filtering is active (irrelevant records were filtered at the score cliff). If result count = 5, scores were evenly distributed — still PASS.

**Cleanup**: `agentcore_forget` with `record_ids: [<all 5 recordIds>]`, `confirm: true`.

### Test 16: Strategy-Specific Scope

Use the agent's own ID from Test 2 (e.g., `bija`).

Use `agentcore_search`:
- scope: `"agent:<selfId>:semantic"` (e.g., `"agent:bija:semantic"`)
- max_results: `5`

**PASS** if returns without error (no permission denied). The response should only contain records from the semantic strategy namespace. Zero records is acceptable — the key assertion is that strategy-specific scope syntax is accepted and doesn't trigger a permission error.

### Test 17: Log Health Check

```bash
grep -i "agentcore.*error\|auto-capture.*error\|noise.*error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null \
  | grep -v "deliver called\|tool call\|tool done\|load failed" | tail -10
```

**PASS** if no errors appear after initial plugin load time. Ignore errors that occurred during plugin startup (e.g., first connection attempt).

---

## Group E: Purge

### Test 18: Purge Preview

Use `agentcore_forget`:
- purge_scope: `true`
- scope: `"global"`
- confirm: `false`

**PASS** if response contains `"purge_preview": true` AND `"estimated_count"` field is a number (>= 0).

### Test 19: Purge Full Cycle

> **Warning**: This test purges ALL records in the `/global` namespace. Only run if acceptable.

**Step 1**: Store 3 records in scope `"global"`. **Save all 3 recordIds**.
- `"Purge test record A"`
- `"Purge test record B"`
- `"Purge test record C"`

**Step 2**: Preview — `agentcore_forget` with `purge_scope: true`, `scope: "global"`, `confirm: false`. Verify `estimated_count >= 3`.

**Step 3**: Execute — `agentcore_forget` with `purge_scope: true`, `scope: "global"`, `confirm: true`. Verify `"purged": true`.

**Step 4**: Verify — `agentcore_search` with `scope: "global"`. Should return 0 records.

**PASS** if purged successfully and scope is empty.

### Test 20: Purge CLI (Dry Run)

```bash
openclaw agentcore-purge global
```

**PASS** if output contains `[DRY RUN] Would delete`.

> Do NOT run with `--confirm` on `global` unless you intend to wipe all data.

---

## Group F: CLI & Permissions

### Test 21: CLI Remember + Cleanup

```bash
openclaw agentcore-remember "CLI remember test from verification"
```

**PASS** if output says `Stored`.

**Cleanup**: Extract the `recordId` from the CLI output, then use `agentcore_forget` with `record_ids: [<extracted recordId>]`, `confirm: true`.

### Test 22: Permission Denied (Read)

Use `agentcore_recall`:
- query: `"permission test"`
- scope: `"user:nonexistent-verification-test"`

**PASS** if response contains an error mentioning "not in your accessible namespaces" (or similar permission denial).

**SKIP** if the scope IS accessible (e.g., `user:*` wildcard configured in `agentAccess`). To detect: if results return without error, the scope is accessible — mark **SKIP**, not FAIL.

### Test 23: Permission Denied (Write)

Use `agentcore_store`:
- content: `"Permission write test"`
- scope: `"agent:nonexistent-other-agent-test"`

**PASS** if response contains `"stored": false` AND error mentions "not in your writable namespaces" (or similar permission denial).

**SKIP** if the scope IS writable (e.g., wildcard in `writeAccess`). To detect: if `"stored": true`, mark **SKIP**, not FAIL. Clean up the record if stored.

---

## Group G: Hook Verification (Log-Based)

These tests verify the passive hooks (auto-recall and auto-capture) by checking runtime logs. The hooks should have fired during this validation session.

### Test 24: Auto-Recall Log Check

```bash
grep -i "\[agentcore\] \[recall\] done: injected" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | tail -5
```

**PASS** if at least one log line is found (auto-recall fired during this session or earlier today).

Also check the namespace count:

```bash
grep -i "\[agentcore\] \[recall\] start:" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | tail -3
```

Report the `namespaces=N` value from the log. Healthy values:
- **≥ 3** in per-agent mode (global + agent + strategies)
- **≥ 6** with cross-agent access or DM mode (adds user + agent knowledge + authorized scopes)

### Test 25: Auto-Capture Log Check

```bash
grep -i "\[agentcore\] \[capture\] done: captured" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | tail -5
```

**PASS** if at least one log line is found (auto-capture fired during prior agent turns today).

Verify the log line contains valid identifiers:
- `actorId=` should NOT be `undefined`
- `sessionId=` should NOT be `undefined`

If both fields are present and non-undefined, the hook is correctly extracting session identity.

> **Note**: Auto-capture is fire-and-forget. If the log shows `[capture] skipped:`, check the reason (e.g., `totalLen < minLength` or `noise-filtered`). These are expected for short/trivial messages, not errors.

---

## Results Report

```
=== memory-agentcore Verification ===
Plugin version: X.Y.Z
Started: HH:MM:SS

  GROUP A: Connection
   1. Connection Status:        [PASS/FAIL]
   2. Stats Baseline:           [PASS/FAIL]

  GROUP B: CRUD
   3. Store:                    [PASS/FAIL]
   4. Recall:                   [PASS/FAIL/PARTIAL]
   5. Search (List):            [PASS/FAIL]
   6. Correct (Update):         [PASS/FAIL]
   7. Correct (Fallback):       [PASS/FAIL]
   8. Share:                    [PASS/FAIL]
   9. Forget + Verify:          [PASS/FAIL]

  GROUP C: Advanced
  10. Recall All-Namespace:     [PASS/FAIL/PARTIAL]
  11. Default Scope:            [PASS/FAIL] (mode: DM|non-DM)
  12. Episodic:                 [PASS/FAIL]
  13. Stats Cache:              [PASS/FAIL]
  14. File Sync:                [PASS/FAIL]

  GROUP D: Filtering
  15. Score Gap:                [PASS/FAIL]
  16. Strategy Scope:           [PASS/FAIL]
  17. Log Health:               [PASS/FAIL]

  GROUP E: Purge
  18. Purge Preview:            [PASS/FAIL]
  19. Purge Cycle:              [PASS/FAIL]
  20. Purge CLI:                [PASS/FAIL]

  GROUP F: CLI & Permissions
  21. CLI Remember:             [PASS/FAIL]
  22. Permission (Read):        [PASS/FAIL/SKIP]
  23. Permission (Write):       [PASS/FAIL/SKIP]

  GROUP G: Hooks
  24. Auto-Recall Log:          [PASS/FAIL] (namespaces: N)
  25. Auto-Capture Log:         [PASS/FAIL]

Total: X/25 passed (Y skipped)
Duration: Xs
```
