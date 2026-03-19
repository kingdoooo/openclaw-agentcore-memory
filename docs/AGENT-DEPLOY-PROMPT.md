# OpenClaw Agent Deployment Prompt

One prompt to deploy the memory-agentcore plugin. Send **Message 1** to your agent. After gateway restarts, send **Message 2**.

Replace `<REGION>` with your AWS region (e.g., `us-west-2`).

---

## Message 1: Deploy

````
Help me deploy the memory-agentcore plugin. Follow these phases exactly.

PHASE 0: CREATE AWS MEMORY RESOURCE

Check for existing resources:
  aws bedrock-agentcore-control list-memories --region <REGION>

If none exist, create one. IMPORTANT:
- CLI service is "bedrock-agentcore-control" (control plane), NOT "bedrock-agentcore"
- --memory-strategies uses tagged union format, each strategy is a separate JSON argument
- Summary and episodic namespaces MUST contain {sessionId}
- Episodic REQUIRES reflectionConfiguration

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

If parameter format errors occur, run: aws bedrock-agentcore-control create-memory help

Wait for ACTIVE status:
  aws bedrock-agentcore-control get-memory --memory-id "<ID>" --region <REGION>

Note the memoryId from the response.

PHASE 1: INSTALL PLUGIN

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

CRITICAL: All paths must be ABSOLUTE. Do NOT use ~ in config values. Node.js does not expand ~.

Use this Python script (replace <MEMORY_ID> and <REGION> with actual values first):

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

WARNING: Do NOT also run "openclaw plugins install ." — using both install and load.paths causes "duplicate plugin id" error.

PHASE 3: UPDATE AGENTS.MD

Append the following to the workspace AGENTS.md file (usually ~/.openclaw/workspace/AGENTS.md). Do NOT overwrite existing content, only append:

cat >> "$(openclaw config get agents.defaults.workspace 2>/dev/null || echo "$HOME/.openclaw/workspace")/AGENTS.md" << 'AGENTS_EOF'

## AgentCore Memory (cloud-backed, cross-session)

Your memory has two layers:
- **Short-term**: Raw conversation events within a session (auto-captured after each turn)
- **Long-term**: Extracted insights that persist across sessions, organized by 4 strategies:
  - **Semantic**: Facts and knowledge ("The API uses OAuth 2.0")
  - **User Preference**: User choices and styles ("User prefers Python over Java")
  - **Summary**: Per-session rolling summaries
  - **Episodic**: Structured experiences with cross-episode reflections and patterns

### Tools

| When to use | Tool | Notes |
|------------|------|-------|
| Save important facts/decisions | `agentcore_store` | Immediate write to long-term memory |
| Find relevant memories | `agentcore_recall` | Semantic search. New records have 30-60s index delay |
| Verify data exists / browse records | `agentcore_search` | List mode, no delay. Fallback if recall returns empty |
| Update incorrect memories | `agentcore_correct` | Updates record in place, preserving ID |
| Delete memories (GDPR) | `agentcore_forget` | Preview first (confirm=false), then delete |
| Share across agents | `agentcore_share` | Specify target_scopes: ["agent:other-bot", "project:xxx"] |
| Search past experiences | `agentcore_episodes` | Finds patterns and reflections across sessions |
| Check status | `agentcore_stats` | Connection health + strategy breakdown |

### Scoping (multi-agent)

- Each agent's memories live in its own namespace (/agents/<id>)
- All agents can read/write /global
- Use agentcore_share to explicitly share to other agents' namespaces
- Use scope parameter in recall/search to target specific namespaces
AGENTS_EOF

PHASE 4: RESTART

  openclaw gateway restart

Connection will drop. This is normal. After restart I'll send verification steps.
````

---

## Message 2: Verify (send after gateway restarts)

````
Run the memory-agentcore verification. Test each item and report PASS/FAIL:

1. openclaw plugins list — confirm memory-agentcore loaded
2. openclaw agentcore-status — confirm Connection: OK, Ready: true
3. Use agentcore_store tool: content "Verification test", category "fact", importance 0.8
4. Use agentcore_recall tool: query "Verification test" (PARTIAL OK if index not ready, verify with agentcore_search)
5. Use agentcore_search tool: scope "global", max_results 5
6. Use agentcore_correct tool: update record from step 3, new_content "Verification - CORRECTED"
7. Use agentcore_share tool: content "Shared test", target_scopes ["agent:test"]
8. Use agentcore_stats tool: confirm connected: true
9. Use agentcore_forget tool: search_query "Verification", confirm true — cleanup
10. openclaw agentcore-sync — test file sync
11. openclaw agentcore-remember "CLI store test" — test CLI storage
12. Use agentcore_episodes tool: query "test", top_k 3 (0 results OK, no error = PASS)
13. Check logs: grep -i "agentcore.*error" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5

Report:
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

If any test fails, report the specific error.
````

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `plugins.load failed` | `~` in config paths | Use absolute path |
| `duplicate plugin id` | Both `install` and `load.paths` | Remove `~/.openclaw/extensions/memory-agentcore/` |
| `text.trim is not a function` | Old plugin version | `git pull && npm run build && openclaw gateway restart` |
| `Connection: FAILED` | Bad credentials or memoryId | `aws sts get-caller-identity` + verify memoryId |
| Recall returns empty | Index warm-up (30-60s) | Wait and retry, or use `agentcore_search` |
| `ValidationException: searchQuery` | Empty query | Fixed in latest; `git pull && npm run build` |
| Tools not found | Plugin not loaded | Check `openclaw plugins list` and logs |

## Updating

```bash
cd ~/.openclaw/plugins/memory-agentcore
git pull
npm run build
openclaw gateway restart
```
