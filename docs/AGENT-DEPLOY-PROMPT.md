# OpenClaw Agent Deployment Prompt

Send the message below to your OpenClaw agent. It handles the full installation. After gateway restarts, two skills become available: `agentcore-memory-validation` (19 automated tests) and `agentcore-memory-guide` (usage reference).

Replace `<REGION>` with your AWS region (e.g., `us-west-2`).

---

## Deploy Message

````
Help me deploy the memory-agentcore plugin. Follow these phases exactly.

PRE-CHECK: Verify prerequisites before starting. Run ALL of these and report any failures:

  aws sts get-caller-identity        # Must succeed — confirms AWS credentials
  aws bedrock-agentcore-control list-memories --region <REGION> 2>&1 | head -5  # Must not show AccessDenied
  node --version                     # Must be v18+
  npm --version                      # Must be installed
  git --version                      # Must be installed

If aws commands fail with AccessDenied or UnrecognizedClientException, STOP and tell the user to configure AWS credentials and ensure bedrock-agentcore permissions are enabled in the region.
If Node.js is not installed or the installed version is below 18, stop and notify the user that they need to upgrade Node.js. Alternatively, ask if they would like you to handle the installation on their behalf.
If Git is not installed, stop and notify the user that they need to install Git. Alternatively, ask if they would like you to handle the installation on their behalf.

PHASE 0: CREATE OR JOIN MEMORY RESOURCE

Memory sharing across agents works ONLY within the same Memory ID. Different Memory IDs are fully isolated — there is no cross-Memory-ID sharing.

List existing resources to see what's already there:
  aws bedrock-agentcore-control list-memories --region <REGION>

ASK THE USER: "Is this a new standalone agent, or should it share memory with existing agents?"

  Option A: Create NEW Memory (standalone or first agent in a group)
    → Run create-memory command below, then save the resulting Memory ID.

  Option B: Join EXISTING Memory (share with other agents)
    → Ask user for the existing Memory ID.
    → Strategy templates are defined at the MEMORY level, not per-agent.
      All agents sharing a Memory ID use the same strategies automatically.
    → Skip create-memory, use provided Memory ID directly in Phase 2.
    → To verify the existing Memory, run:
      aws bedrock-agentcore-control get-memory --memory-id "<ID>" --region <REGION>
    → SKIP to PHASE 1 after confirming the Memory ID.

--- If creating a NEW Memory resource ---

Do not reuse Memory resources from other projects — different projects may have incompatible strategies and namespaces, and their data would mix together. IMPORTANT:
- CLI service is "bedrock-agentcore-control" (control plane), NOT "bedrock-agentcore"
- --memory-strategies uses tagged union format, each strategy is a separate JSON argument
- Summary and episodic namespaces MUST contain {sessionId} (AWS requirement for session-level strategies)
- Episodic REQUIRES reflectionConfiguration (reflection namespace must be a prefix of the episodic namespace)
- Namespace templates support variables: {actorId}, {sessionId}, {memoryStrategyId}
- Choose ONE of the two options below based on your namespaceMode config

Option A: Per-agent isolation (namespaceMode: "per-agent", default)
Each agent's memories are stored in separate namespace paths. Recommended for multi-agent deployments.

  aws bedrock-agentcore-control create-memory \
    --name "openclaw_memory" \
    --description "Shared memory for OpenClaw agents" \
    --event-expiry-duration 90 \
    --memory-strategies \
      '{"semanticMemoryStrategy":{"name":"semantic","namespaces":["/semantic/{actorId}"]}}' \
      '{"userPreferenceMemoryStrategy":{"name":"preferences","namespaces":["/preferences/{actorId}"]}}' \
      '{"summaryMemoryStrategy":{"name":"summary","namespaces":["/summary/{actorId}/{sessionId}"]}}' \
      '{"episodicMemoryStrategy":{"name":"episodic","namespaces":["/episodic/{actorId}/{sessionId}"],"reflectionConfiguration":{"namespaces":["/episodic/{actorId}"]}}}' \
    --region <REGION>

Option B: Shared namespaces (namespaceMode: "shared")
All agents share the same namespace paths. Simpler but no isolation between agents.

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

Save the memoryId from the response — you will need it in Phase 2. The memoryId looks like "openclaw_memory-XXXXXXXXXX".

PHASE 1: INSTALL PLUGIN

  PLUGIN_DIR="$HOME/.openclaw/plugins/memory-agentcore"
  mkdir -p "$HOME/.openclaw/plugins"
  git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git "$PLUGIN_DIR"
  cd "$PLUGIN_DIR"
  npm install
  npm run build
  ls dist/index.js && echo "Build OK"

IMPORTANT: npm run build is required. The plugin loads compiled JS from dist/.
If npm install fails, check Node.js version (v18+ required) and network connectivity.
If npm run build fails, check for TypeScript errors in the output.

PHASE 2: CONFIGURE

IMPORTANT — AGENT ID CHECK (when sharing a Memory ID across agents):
Each agent sharing a Memory ID MUST have a unique agent ID, set via agents.list[].id in openclaw.json.
Without a unique ID, all agents default to actorId "main" and their memories merge unintentionally.

Check current agent ID:
  python3 -c "import json; cfg=json.load(open('$HOME/.openclaw/openclaw.json')); agents=cfg.get('agents',{}).get('list',[]); print([a.get('id','(no id, defaults to main)') for a in agents] if agents else 'No agents configured (defaults to main)')"

If no unique ID is set and you are joining an existing Memory, ask the user what agent ID to use.

Edit ~/.openclaw/openclaw.json. MERGE into existing config, do not overwrite.

CRITICAL: All paths must be ABSOLUTE. Do NOT use ~ in config values. Node.js does not expand ~.

Use this Python script. Replace MEMORY_ID_HERE with the memoryId from Phase 0, and REGION_HERE with your AWS region:

  MEMORY_ID="<paste memoryId from Phase 0>"
  REGION="<REGION>"
  python3 -c "
  import json, os, sys
  memory_id = sys.argv[1]
  region = sys.argv[2]
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
      'config': {'memoryId': memory_id, 'awsRegion': region}
  }
  with open(config_path, 'w') as f:
      json.dump(cfg, f, indent=2, ensure_ascii=False)
  print(f'Done. memoryId={memory_id}, region={region}, path={plugin_dir}')
  " "$MEMORY_ID" "$REGION"

Verify the config was written correctly:
  python3 -c "import json; cfg=json.load(open('$HOME/.openclaw/openclaw.json')); e=cfg['plugins']['entries']['memory-agentcore']; print(f'memoryId={e[\"config\"][\"memoryId\"]}'); print(f'path={cfg[\"plugins\"][\"load\"][\"paths\"][0]}'); assert not e['config']['memoryId'].startswith('<'), 'ERROR: memoryId still has placeholder!'; assert '~' not in cfg['plugins']['load']['paths'][0], 'ERROR: path contains ~!'"

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
| Update incorrect memories | `agentcore_correct` | Updates in place, auto-retries on transient errors |
| Delete memories | `agentcore_forget` | Preview first (confirm=false), then delete. Supports purge_scope for bulk deletion |
| Share across agents | `agentcore_share` | Specify target_scopes: ["agent:other-bot", "project:xxx"] |
| Search past experiences | `agentcore_episodes` | Finds patterns and reflections across sessions |
| Check status | `agentcore_stats` | Connection health + strategy breakdown (cached 5 min) |

### Namespace Architecture

**Two types of namespaces**:

1. **Primary namespaces** — for manual tool use (`agentcore_store`, `agentcore_share`):
   - `/global` — All agents share. Default for manual store.
   - `/agents/<id>` — Per-agent space.
   - `/projects/<id>`, `/users/<id>`, `/custom/<id>` — Scoped spaces.

2. **Strategy namespaces** — auto-populated by AWS from `createEvent`:
   - `/semantic/<id>` — Facts and knowledge (cross-session)
   - `/preferences/<id>` — User preferences (cross-session)
   - `/summary/<id>/<sessionId>` — Per-session summaries (session-scoped)
   - `/episodic/<id>/<sessionId>` — Per-session episodes (session-scoped)
   - `/episodic/<id>` — Episodic reflections (cross-session)

**Auto-recall searches all of**: `/global`, `/agents/<id>`, all strategy namespaces for own agent, current session summary/episodic, plus all authorized agents' strategy namespaces.

**scope parameter syntax**: `"global"`, `"agent:sales-bot"`, `"project:ecommerce"`, `"user:kent"`

**Cross-agent sharing**:
- Write to other namespace: `agentcore_share` with target_scopes: ["agent:other-bot"]
- Read from other namespace: `agentcore_recall` / `agentcore_search` with scope: "agent:other-bot"
- Auto-recall includes authorized agents: configure `agentAccess` below

**Access control** (openclaw.json → plugins.entries.memory-agentcore.config.scopes):
```json
{
  "agentAccess": { "bot-a": ["agent:bot-b", "project:shared"] },
  "writeAccess": { "bot-a": ["project:shared"] }
}
```
With this config, bot-a's auto-recall searches all its own namespaces + bot-b's strategy namespaces + /projects/shared.

**Important**: Agent ID (agents.list[].id) must be unique when sharing a Memory ID. All agents default to "main" if not set.
AGENTS_EOF

PHASE 4: RESTART

  openclaw gateway restart

Connection will drop. This is normal.

After restart, the agentcore-memory-validation skill is available. Tell the user:

> "Plugin installed. After reconnection, send me: '运行 agentcore-memory-validation' to run full verification."
````

---

## Post-Install

After the gateway restarts and the plugin is loaded:

- **Verify**: `Run agentcore-memory-validation` — 19 automated tests, zero restarts
- **Usage guide**: `Run agentcore-memory-guide` — tool reference, shared memory, config, best practices

---

## Troubleshooting (Installation)

| Problem | Cause | Fix |
|---------|-------|-----|
| `plugins.load failed` | `~` in config paths | Use absolute path (`$HOME` expands in shell, `~` does not in Node.js) |
| `duplicate plugin id` | Both `install` and `load.paths` | Remove `~/.openclaw/extensions/memory-agentcore/` |
| `text.trim is not a function` | Old plugin version | `git pull && npm run build && openclaw gateway restart` |
| `Connection: FAILED` | Bad credentials or memoryId | `aws sts get-caller-identity` + verify memoryId in config |
| `npm run build` fails | Node.js < v18 | Upgrade to Node.js v18+ |
| Config placeholder not replaced | `<MEMORY_ID>` still in config | Re-run Phase 2 with actual memoryId |
| `AccessDeniedException` | Missing IAM permissions | Ensure bedrock-agentcore is available in your region |

## Updating

```bash
cd ~/.openclaw/plugins/memory-agentcore
git pull
npm run build
openclaw gateway restart
```
