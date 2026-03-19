# OpenClaw Agent Deployment Prompt

Copy the prompt below and send it to your OpenClaw agent. Replace the two placeholders before sending:
- `<REGION>`: Your AWS region (e.g., `us-west-2`, `us-east-1`)
- `<MEMORY_ID>`: Your AgentCore Memory ID (skip if you don't have one — the agent will create it)

The prompt is split into **two messages** because gateway restart will disconnect the agent:
1. **Message 1**: Create AWS resource + install plugin + configure + restart
2. **Message 2**: Run verification (send after gateway restarts)

---

## Message 1: Setup

```
Help me deploy the memory-agentcore plugin. Follow these steps exactly.

PHASE 0: CREATE AWS MEMORY RESOURCE (skip if I already have a memoryId)

Check for existing resources:
  aws bedrock-agentcore-control list-memories --region <REGION>

If none exist, create one with all 4 strategies. IMPORTANT notes:
- The CLI service is "bedrock-agentcore-control" (control plane), NOT "bedrock-agentcore" (data plane)
- --memory-strategies uses tagged union format — each strategy is a separate JSON argument
- Summary and episodic namespaces MUST contain {sessionId}
- Episodic strategy REQUIRES reflectionConfiguration

  aws bedrock-agentcore-control create-memory \
    --name "openclaw_memory" \
    --description "Shared memory for OpenClaw agents" \
    --event-expiry-duration 90 \
    --memory-strategies \
      '{"semanticMemoryStrategy":{"name":"semantic","namespaces":["/semantic"]}}' \
      '{"userPreferenceMemoryStrategy":{"name":"preferences","namespaces":["/preferences"]}}' \
      '{"summaryMemoryStrategy":{"name":"summary","namespaces":["/summary/{sessionId}"]}}' \
      '{"episodicMemoryStrategy":{"name":"episodic","namespaces":["/episodic/{sessionId}"],"reflectionConfiguration":{"namespaces":["/episodic"]}}}' \
    --region <REGION>

If the CLI parameter format doesn't match, run: aws bedrock-agentcore-control create-memory help

Wait for status ACTIVE:
  aws bedrock-agentcore-control get-memory --memory-id "<ID>" --region <REGION>

Note the memoryId from the response.

PHASE 1: INSTALL PLUGIN

Clone and build:
  PLUGIN_DIR="$HOME/.openclaw/plugins/memory-agentcore"
  mkdir -p "$HOME/.openclaw/plugins"
  git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git "$PLUGIN_DIR"
  cd "$PLUGIN_DIR"
  npm install
  npm run build
  ls dist/index.js && echo "Build OK"

IMPORTANT: npm run build is required. The plugin loads compiled JS from dist/.

PHASE 2: CONFIGURE

Edit ~/.openclaw/openclaw.json. MERGE into existing config, do not overwrite.

CRITICAL: All paths must be ABSOLUTE. Do NOT use ~ in config. Node.js does not expand ~.

Add these entries:
- plugins.allow: append "memory-agentcore" to the array
- plugins.load.paths: set to the absolute path of the plugin directory
- plugins.entries.memory-agentcore: enabled true, config with memoryId and awsRegion

If the config file uses JSON5, you can edit directly. Otherwise use a Python script:

  python3 -c "
  import json, os
  config_path = os.path.expanduser('~/.openclaw/openclaw.json')
  plugin_dir = os.path.realpath(os.path.expanduser('~/.openclaw/plugins/memory-agentcore'))
  with open(config_path, 'r') as f:
      cfg = json.load(f)
  cfg.setdefault('plugins', {})
  cfg['plugins'].setdefault('allow', [])
  cfg['plugins'].setdefault('entries', {})
  if 'memory-agentcore' not in cfg['plugins']['allow']:
      cfg['plugins']['allow'].append('memory-agentcore')
  cfg['plugins']['load'] = {'paths': [plugin_dir]}
  cfg['plugins']['entries']['memory-agentcore'] = {
      'enabled': True,
      'config': {'memoryId': '<MEMORY_ID>', 'awsRegion': '<REGION>'}
  }
  with open(config_path, 'w') as f:
      json.dump(cfg, f, indent=2, ensure_ascii=False)
  print('Done')
  "

Replace <MEMORY_ID> and <REGION> with actual values.

WARNING: Do NOT also run "openclaw plugins install ." — using both install and load.paths causes "duplicate plugin id" error. Use load.paths only.

PHASE 3: RESTART

  openclaw gateway restart

The connection will drop. This is normal. After restart, I'll send you the verification steps.
```

---

## Message 2: Verify (send after gateway restarts)

```
Run the memory-agentcore verification. Test each item and report PASS/FAIL:

1. openclaw plugins list — confirm memory-agentcore loaded
2. openclaw agentcore-status — confirm Connection: OK, Ready: true
3. Use agentcore_store tool: content "Verification test", category "fact", importance 0.8
4. Use agentcore_recall tool: query "Verification test" (may be PARTIAL if index not ready — use agentcore_search to confirm data exists)
5. Use agentcore_search tool: scope "global", max_results 5
6. Use agentcore_correct tool: update the record from step 3 with new_content "Verification - CORRECTED"
7. Use agentcore_share tool: content "Shared test", target_scopes ["agent:test"]
8. Use agentcore_stats tool: scope "global", confirm connected: true
9. Use agentcore_forget tool: search_query "Verification", confirm true — clean up test data
10. openclaw agentcore-sync — test file sync
11. openclaw agentcore-remember "CLI store test" — test CLI storage
12. Use agentcore_episodes tool: query "test", top_k 3 (0 results OK, no error = PASS)
13. Check logs for errors: grep -i "agentcore.*error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5

Report results:
=== memory-agentcore Verification ===
 1. Plugin Load:    [PASS/FAIL]
 2. Connection:     [PASS/FAIL]
 3. Store:          [PASS/FAIL]
 4. Recall:         [PASS/FAIL/PARTIAL]
 5. Search/List:    [PASS/FAIL]
 6. Correct:        [PASS/FAIL]
 7. Share:          [PASS/FAIL]
 8. Stats:          [PASS/FAIL]
 9. Forget:         [PASS/FAIL]
10. File Sync:      [PASS/FAIL]
11. CLI Remember:   [PASS/FAIL]
12. Episodic:       [PASS/FAIL]
13. Error Check:    [PASS/FAIL]
Total: X/13 passed
```

---

## Troubleshooting Reference

If the agent encounters issues, these are the known pitfalls:

| Problem | Cause | Fix |
|---------|-------|-----|
| `plugins.load failed` | `~` in paths | Use absolute path |
| `duplicate plugin id` | Both `install` and `load.paths` active | Remove `~/.openclaw/extensions/memory-agentcore/` |
| `text.trim is not a function` | Old plugin version | `git pull && npm run build && openclaw gateway restart` |
| `Connection: FAILED` | Bad credentials or memoryId | `aws sts get-caller-identity` and verify memoryId |
| Recall returns empty | Index warm-up (30-60s for new data) | Wait and retry, or use `agentcore_search` (list mode) |
| `ValidationException: searchQuery` | Empty query string | Fixed in latest version; `git pull && npm run build` |
| Tools not found | Plugin not loaded | Check `openclaw plugins list` and logs |
| Strategy not working | Missing from create-memory | Use `update-memory` to add missing strategy |

## Updating

After code updates are pushed to GitHub:

```bash
cd ~/.openclaw/plugins/memory-agentcore
git pull
npm run build
openclaw gateway restart
```
