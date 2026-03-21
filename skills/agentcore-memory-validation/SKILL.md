---
name: agentcore-memory-validation
description: Verify the memory-agentcore plugin — 19 automated tests, zero restarts.
---

# AgentCore Memory — Verification

Run all tests and report results. If a test fails, continue to the next — report everything at the end.

For usage guidance (tool reference, shared memory, config, best practices), use `agentcore-memory-guide`.

---

## Pre-check: Plugin Loaded

```bash
openclaw plugins list 2>&1 | grep "memory-agentcore"
```

If not found, check logs:

```bash
grep -i "load failed\|duplicate plugin\|agentcore.*error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null \
  | grep -v "deliver called\|tool call\|tool done" | tail -5
```

If the plugin didn't load, STOP and troubleshoot (see Runtime Troubleshooting in `agentcore-memory-guide`).

---

## Tests

### Test 1: Connection Status

```bash
openclaw agentcore-status 2>&1
```

**PASS** if `Connection: OK` and `Ready: true`.

### Test 2: Store Memory

Use `agentcore_store`:
- content: `"AgentCore verification test - plugin working"`
- category: `"fact"`
- importance: `0.8`
- scope: `"global"`
- tags: `["verification"]`

**PASS** if `"stored": true`. Save the `recordId` for later tests.

### Test 3: Recall Memory

Use `agentcore_recall`:
- query: `"AgentCore verification test"`
- limit: `3`

**PASS** if results contain the test record.

> **Known behavior**: New Memory resources may return 0 results for the first few minutes (index warm-up). If empty, verify via Test 4. Mark **PARTIAL**.

### Test 4: Search (List Mode)

Use `agentcore_search`:
- scope: `"global"`
- max_results: `5`

**PASS** if returns without error and shows the test record.

### Test 5: Correct

Use `agentcore_correct`:
- record_id: `<ID from Test 2>`
- new_content: `"AgentCore verification - CORRECTED - plugin working correctly"`

**PASS** if `"corrected": true`.

### Test 6: Stats

Use `agentcore_stats`:
- scope: `"global"`

**PASS** if `"connected": true`.

### Test 7: Share

Use `agentcore_share`:
- content: `"Shared verification: memory-agentcore is operational"`
- target_scopes: `["agent:test-agent"]`
- category: `"fact"`

**PASS** if `"shared": true`.

### Test 8: Forget (Cleanup)

1. Use `agentcore_forget`:
   - search_query: `"AgentCore verification"`
   - confirm: `true`
   - scope: `"global"`

2. Use `agentcore_forget`:
   - search_query: `"memory-agentcore is operational"`
   - confirm: `true`
   - scope: `"agent:test-agent"`

**PASS** if `"deleted": true`.

### Test 9: File Sync

```bash
openclaw agentcore-sync 2>&1
```

**PASS** if output contains `Synced` (0 or more files OK, no error).

### Test 10: CLI Remember + Cleanup

```bash
openclaw agentcore-remember "CLI remember test from verification"
```

**PASS** if output says `Stored`.

Then clean up via `agentcore_forget`:
- search_query: `"CLI remember test"`
- confirm: `true`

### Test 11: Episodic Search

Use `agentcore_episodes`:
- query: `"verification test"`
- top_k: `3`

May return 0 results (episodic needs conversation events). **PASS** if no error.

### Test 12: Runtime Error Check

```bash
grep -i "agentcore.*error\|auto-capture error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null \
  | grep -v "deliver called\|tool call\|tool done" | tail -5
```

**PASS** if no errors after plugin load time.

### Test 13: Score Gap Detection — Basic

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

### Test 14: Stats Cache

Use `agentcore_stats` (scope: `"global"`). Note `"cacheHit": false`.

Immediately call `agentcore_stats` again.

**PASS** if second call returns `"cacheHit": true`.

### Test 15: Purge — Preview

Use `agentcore_forget`:
- purge_scope: `true`
- scope: `"agent:purge-test"`
- confirm: `false`

**PASS** if response contains `"purge_preview": true` and `"estimated_count"` field.

### Test 16: Purge — Full Cycle

**Step 1**: Store 3 records in scope `"agent:purge-test"`:
- `"Purge test record A"`, `"Purge test record B"`, `"Purge test record C"`

**Step 2**: Preview — `agentcore_forget` with purge_scope: true, confirm: false. Verify `estimated_count` >= 3.

**Step 3**: Execute — `agentcore_forget` with purge_scope: true, confirm: true. Verify `"purged": true`.

**Step 4**: Verify — `agentcore_search` with scope `"agent:purge-test"`. Should return 0 records.

**PASS** if purged and scope is empty.

### Test 17: Purge — CLI

```bash
openclaw agentcore-purge global
```

**PASS** if output contains `[DRY RUN] Would delete`.

> Do NOT run with `--confirm` on `global` unless you intend to wipe all data.

### Test 18: Correct with Retry

Store `"Retry test: original content"` (scope: `"global"`), then correct with `"Retry test: CORRECTED content"`.

**PASS** if `"corrected": true, "method": "update"`.

Clean up with `agentcore_forget`: record_ids `[<ID>]`.

### Test 19: Noise Filter Defaults

```bash
grep -i "auto-capture\|noise" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | tail -10
```

**PASS** if no errors.

---

## Cleanup

Clean up Test 13 seed data — use `agentcore_forget` with confirm: true for each:
- `"dark mode monospace fonts"` (scope: global)
- `"favorite programming language TypeScript"` (scope: global)
- `"TypeScript supports generics"` (scope: global)
- `"weather in Tokyo"` (scope: global)
- `"Bananas potassium"` (scope: global)

## Results Report

```
=== memory-agentcore Verification ===

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
 13.  Score Gap:       [PASS/FAIL]
 14.  Stats Cache:     [PASS/FAIL]
 15.  Purge Preview:   [PASS/FAIL]
 16.  Purge Cycle:     [PASS/FAIL]
 17.  Purge CLI:       [PASS/FAIL]
 18.  Correct+Retry:   [PASS/FAIL]
 19.  Noise Filter:    [PASS/FAIL]

Total: X/19 passed
```
