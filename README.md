# memory-agentcore

[中文文档](README_CN.md)

OpenClaw plugin for enterprise shared memory via **Amazon Bedrock AgentCore Memory**.

## Why Not Built-in Memory?

OpenClaw's built-in memory-core stores memories as local Markdown files per agent. This works well for single-agent personal use, but breaks down in enterprise multi-agent scenarios:

**Example: E-commerce with 3 agents** — A customer tells the sales agent "I prefer express shipping." Later, the fulfillment agent processes their order but doesn't know this preference. The support agent handles a complaint but has no context from previous interactions.

| Capability | Built-in memory-core | memory-agentcore |
|-----------|---------------------|-----------------|
| Storage | Local `.md` files | Cloud (AgentCore managed) |
| Cross-agent sharing | Not supported | Namespace-based sharing with IAM |
| Memory extraction | Manual (agent writes to files) | Automatic (4 built-in strategies) |
| Episodic learning | Not supported | Cross-session reflection and pattern detection |
| Access control | Filesystem permissions | IAM policies + CloudTrail audit |
| Encryption | None | KMS at rest + TLS in transit |
| Manual file deletion | Delete files manually | API-driven with audit trail |

This plugin **coexists** with memory-core — local memory still works offline, cloud memory adds sharing and governance on top.

## Features

- **Shared memory** across agents via namespace-based isolation/sharing
- **Enterprise governance**: IAM access control, CloudTrail audit, KMS encryption
- **Managed extraction**: AgentCore's built-in strategies (SEMANTIC, USER_PREFERENCE, EPISODIC, SUMMARY)
- **Episodic memory**: agents learn from past experiences with cross-episode reflections
- **Auto-recall**: inject relevant memories before each agent turn
- **Auto-capture**: automatically capture conversations after each agent run
- **File sync**: sync local documents to AgentCore for semantic search (default empty — bootstrap files already in prompt)
- **On-demand memory deletion** via `agentcore_forget`
- **Bilingual noise filter** (EN/ZH) and adaptive retrieval gating

## Prerequisites

- OpenClaw running (2026.3.12+)
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed
- AWS credentials configured on EC2: attach `BedrockAgentCoreFullAccess` managed policy to the instance role (or see [minimum permissions](#required-iam-permissions) below)
- Node.js 18+, git

## Quick Start: Agent-Driven Deploy (Recommended)

Copy the ready-made prompt from **[docs/AGENT-DEPLOY-PROMPT.md](docs/AGENT-DEPLOY-PROMPT.md)** ([中文版](docs/AGENT-DEPLOY-PROMPT.zh-CN.md)) and send to your OpenClaw agent. It handles everything automatically:

1. Create AWS AgentCore Memory resource (4 strategies)
2. Clone, build, and configure the plugin
3. Update AGENTS.md with usage guide
4. Restart gateway and run 13-step verification

**You only need to provide**: AWS region (e.g., `us-west-2`)

## Manual Setup

### Step 1: Create AgentCore Memory Resource

Create a **dedicated** Memory resource for this OpenClaw deployment. Do not reuse Memory resources from other projects — different projects may have incompatible strategies and namespaces, and their data would mix together.

> **IMPORTANT**: The control plane CLI is `bedrock-agentcore-control`, NOT `bedrock-agentcore`.

```bash
aws bedrock-agentcore-control create-memory \
  --name "openclaw_memory" \
  --description "Shared memory for OpenClaw agents" \
  --event-expiry-duration 90 \
  --memory-strategies \
    '{"semanticMemoryStrategy":{"name":"semantic","namespaces":["/semantic"]}}' \
    '{"userPreferenceMemoryStrategy":{"name":"preferences","namespaces":["/preferences"]}}' \
    '{"summaryMemoryStrategy":{"name":"summary","namespaces":["/summary/{sessionId}"]}}' \
    '{"episodicMemoryStrategy":{"name":"episodic","namespaces":["/episodic/{sessionId}"],"reflectionConfiguration":{"namespaces":["/episodic"]}}}' \
  --region us-west-2
```

> Summary and episodic namespaces **must** contain `{sessionId}`. Episodic **requires** `reflectionConfiguration`.

Wait for ACTIVE status:
```bash
aws bedrock-agentcore-control get-memory --memory-id "<ID>" --region us-west-2
```

### Step 2: Clone & Build

```bash
PLUGIN_DIR="$HOME/.openclaw/plugins/memory-agentcore"
mkdir -p "$HOME/.openclaw/plugins"
git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git "$PLUGIN_DIR"
cd "$PLUGIN_DIR"
npm install
npm run build
```

> `npm run build` is **required**. The plugin loads compiled JS from `dist/`.

### Step 3: Configure

Edit `~/.openclaw/openclaw.json`:

> **All paths must be ABSOLUTE. Do NOT use `~`** — Node.js does not expand `~`, causing `plugins.load failed`.

```json5
{
  plugins: {
    allow: ["memory-agentcore"],              // Required since OpenClaw 2026.3.12+
    load: {
      paths: ["/home/ubuntu/.openclaw/plugins/memory-agentcore"]  // ABSOLUTE path
    },
    entries: {
      "memory-agentcore": {
        enabled: true,
        config: {
          memoryId: "<YOUR_MEMORY_ID>",       // From Step 1
          awsRegion: "us-west-2"
        }
      }
    }
  }
}
```

> Do NOT also run `openclaw plugins install .` — using both `load.paths` and `install` causes `duplicate plugin id` error.

### Step 4: Restart & Verify

```bash
openclaw gateway restart

# After restart:
openclaw plugins list | grep memory-agentcore
openclaw agentcore-status
```

## Configuration Reference

### All Options

| Field | Default | Description |
|-------|---------|-------------|
| `memoryId` | **(required)** | AgentCore Memory resource ID |
| `awsRegion` | `us-east-1` | AWS region |
| `awsProfile` | - | Named AWS credential profile |
| `enabled` | `true` | Enable/disable the plugin |
| `strategies` | `["SEMANTIC","USER_PREFERENCE","EPISODIC","SUMMARY"]` | Active extraction strategies |
| `autoRecallTopK` | `5` | Memories to inject before each turn (0=disabled) |
| `autoCaptureEnabled` | `true` | Auto-capture after each agent run |
| `autoCaptureMinLength` | `30` | Min combined message length for capture |
| `noiseFilterEnabled` | `true` | Filter greetings/heartbeats before capture |
| `adaptiveRetrievalEnabled` | `true` | Skip trivial query retrieval |
| `namespaceMode` | `per-agent` | Strategy namespace isolation: `per-agent` = `/semantic/{actorId}`, `shared` = flat `/semantic` |
| `eventExpiryDays` | `90` | Short-term event retention |
| `showScores` | `false` | Include similarity scores in recalled memories |
| `fileSyncEnabled` | `true` | Enable file sync to AgentCore |
| `fileSyncPaths` | `[]` | Files to sync (glob supported). Default empty — bootstrap files are already in prompt |
| `maxRetries` | `3` | AWS SDK retry attempts |
| `timeoutMs` | `10000` | Per-request timeout |

### Environment Variables

All fields support env var override:

| Variable | Config Field |
|----------|-------------|
| `AGENTCORE_MEMORY_ID` | `memoryId` |
| `AGENTCORE_ENABLED` | `enabled` |
| `AWS_REGION` / `AGENTCORE_REGION` | `awsRegion` |
| `AWS_PROFILE` / `AGENTCORE_PROFILE` | `awsProfile` |
| `AGENTCORE_AUTO_RECALL_TOP_K` | `autoRecallTopK` |
| `AGENTCORE_AUTO_CAPTURE_ENABLED` | `autoCaptureEnabled` |
| `AGENTCORE_NOISE_FILTER_ENABLED` | `noiseFilterEnabled` |
| `AGENTCORE_FILE_SYNC_ENABLED` | `fileSyncEnabled` |
| `AGENTCORE_SHOW_SCORES` | `showScores` |

## AWS Credentials & Permissions

Uses the AWS SDK credential chain (in order):
1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. Named profiles (`awsProfile` config or `AWS_PROFILE`)
3. AWS SSO
4. IAM roles (EC2, ECS, Lambda)

### Required IAM Permissions

**Data plane** (plugin runtime — attach to EC2 instance role):
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

**Control plane** (only if agent creates Memory resources during setup):
```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock-agentcore-control:CreateMemory",
    "bedrock-agentcore-control:GetMemory",
    "bedrock-agentcore-control:ListMemories",
    "bedrock-agentcore-control:UpdateMemory"
  ],
  "Resource": "*"
}
```

## Tools

| Tool | Description |
|------|-------------|
| `agentcore_recall` | Semantic search through stored memories |
| `agentcore_store` | Save facts/preferences/decisions to long-term memory |
| `agentcore_forget` | Delete memories (preview+confirm) |
| `agentcore_correct` | Update/correct existing memory in place |
| `agentcore_search` | List/filter records by namespace and strategy |
| `agentcore_stats` | Memory statistics and connection status |
| `agentcore_share` | Share memory across multiple scopes/namespaces |
| `agentcore_episodes` | Search episodic memory for past experiences |

## Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| `agentcore-memory-validation` | `Run agentcore-memory-validation` | 19 automated tests, zero restarts |
| `agentcore-memory-guide` | `Run agentcore-memory-guide` | Tool reference, shared memory, config, best practices |

## CLI Commands

```bash
openclaw agentcore-status              # Connection check + config
openclaw agentcore-search <query>      # Semantic search
openclaw agentcore-list [--scope] [--strategy]  # List records
openclaw agentcore-forget <id>         # Delete record
openclaw agentcore-episodes <query>    # Search episodic memory
openclaw agentcore-stats [--scope]     # Strategy breakdown
openclaw agentcore-sync                # Manual file sync
openclaw agentcore-remember <fact>     # Store a fact directly
```

## Multi-Agent Enterprise Setup

Multiple agents can share memory through a single Memory resource using namespace-based scoping:

```json5
{
  plugins: {
    allow: ["memory-agentcore"],
    load: {
      paths: ["/home/ubuntu/.openclaw/plugins/memory-agentcore"]
    },
    entries: {
      "memory-agentcore": {
        enabled: true,
        config: {
          memoryId: "<YOUR_MEMORY_ID>",
          awsRegion: "us-west-2",
          namespaceMode: "shared",
          scopes: {
            agentAccess: {
              "tech-support": ["agent:sales-bot", "agent:refund-bot", "project:ecommerce"],
              "sales-bot": ["project:ecommerce"],
              "refund-bot": ["project:ecommerce"]
            },
            writeAccess: {
              "tech-support": ["project:ecommerce"],
              "sales-bot": ["project:ecommerce"],
              "refund-bot": ["project:ecommerce"]
            }
          }
        }
      }
    }
  }
}
```

Permissions are always enforced. Each agent can only access `/global` + its own namespaces (`/agents/<id>`, `/semantic/<id>`, `/episodic/<id>`, `/preferences/<id>`, `/summary/<id>`) by default. Cross-agent access requires explicit `scopes` configuration — entries are **additive** on top of defaults (no need to list `global` or `agent:<self>`). IAM policies provide server-side enforcement.

**Important**: When sharing a Memory ID across agents, each agent **must** have a unique agent ID (`agents.list[].id` in openclaw.json). Without it, all agents default to `main` and their memories merge.

### Scope Format

| Scope String | AgentCore Namespace |
|-------------|---------------------|
| `global` | `/global` |
| `agent:refund-bot` | `/agents/refund-bot` |
| `project:ecommerce` | `/projects/ecommerce` |
| `user:alice` | `/users/alice` |
| `custom:team-x` | `/custom/team-x` |

> Before modifying memory-agentcore configuration, tell your OpenClaw Agent to read the [agentcore-memory-guide](skills/agentcore-memory-guide/SKILL.md) skill first. The agent will understand the rules and handle configuration changes. See this skill for complete scope syntax reference, cross-agent sharing patterns, and troubleshooting tips.

### Namespace Architecture

Auto-capture (`createEvent`) writes to strategy namespaces. Auto-recall searches these namespaces automatically.

**Data flow** (per-agent mode, actorId = "bija", sessionId = "s1"):

```
createEvent(actorId="bija", sessionId="s1")
  └─ AWS strategies extract and store:
       SEMANTIC         → /semantic/bija           ← cross-session ✅
       USER_PREFERENCE  → /preferences/bija        ← cross-session ✅
       SUMMARY          → /summary/bija/s1         ← session-scoped
       EPISODIC episodes→ /episodic/bija/s1        ← session-scoped
       EPISODIC reflect → /episodic/bija           ← cross-session ✅

Auto-recall searches (7 namespaces minimum):
  /global + /agents/bija                           (primary, for manual store)
  /semantic/bija + /preferences/bija               (cross-session strategies)
  /episodic/bija                                   (episodic reflections)
  /summary/bija/s1 + /episodic/bija/s1             (current session only)
```

Cross-agent sharing (via `agentAccess`) adds actor-level strategy namespaces for each authorized agent (~5 extra per agent). All searches run in parallel via `Promise.allSettled`.

**Cross-session vs within-session**:

| Memory type | Cross-session? | Within-session? |
|---|---|---|
| Semantic facts | ✅ | ✅ |
| User preferences | ✅ | ✅ |
| Episodic reflections | ✅ | ✅ |
| Conversation summaries | — | ✅ |
| Individual episodes | — | ✅ |
| Manual store (`/global`) | ✅ | ✅ |

### Multi-Machine Deployment

All machines sharing memory **must**:
1. Use the **same Memory ID** (created once via AWS CLI)
2. Have AWS credentials with access to that Memory ID
3. Configure **unique agent IDs** (do not all use default `main`)
4. Share the `scopes.agentAccess` config for cross-agent read access

> Memory sharing is **impossible** across different Memory IDs. Each Memory ID is a fully isolated store.

## Architecture

```
Local Memory (built-in memory-core)     Cloud Memory (memory-agentcore)
  MEMORY.md, USER.md                      AgentCore Memory Service
  Always available, offline-capable       Shared, governed, online-only
       |                                        |
       +--- OpenClaw merges both into prompt ---+
```

### Memory Types

- **Short-term**: Raw conversation events within a session (auto-captured via `agent_end` hook)
- **Long-term**: Extracted insights across sessions, organized by 4 strategies:
  - **Semantic**: Facts and knowledge
  - **User Preference**: User choices and styles
  - **Summary**: Per-session rolling summaries
  - **Episodic**: Structured experiences with cross-episode reflections

### Lifecycle Hooks

- **`before_prompt_build`**: Auto-recall — searches AgentCore, returns `{ prependContext }` with relevant memories
- **`agent_end`**: Auto-capture (fire-and-forget) — captures last message pair + syncs changed files

### Graceful Degradation

When offline or AgentCore unavailable:
- Auto-recall returns empty (local memory-core still works)
- Auto-capture silently fails (logged as warning)
- Tools return error messages (agent can inform user)

## Updating

```bash
cd ~/.openclaw/plugins/memory-agentcore
git pull
npm run build
openclaw gateway restart
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `plugins.load failed` | `~` in config paths | Use absolute path |
| `duplicate plugin id` | Both `install` and `load.paths` | Remove `~/.openclaw/extensions/memory-agentcore/` |
| `text.trim is not a function` | Old plugin version | `git pull && npm run build && openclaw gateway restart` |
| `Connection: FAILED` | Bad credentials or memoryId | `aws sts get-caller-identity` + verify memoryId |
| Recall returns empty | Index warm-up (30-60s) | Wait and retry, or use `agentcore_search` (list mode) |
| `ValidationException: searchQuery` | Empty query | Fixed in latest; `git pull && npm run build` |
| Tools not found | Plugin not loaded | Check `openclaw plugins list` and logs |
| `missing openclaw.extensions` | Old package.json | `git pull && npm run build` |

## Dependencies

- `@aws-sdk/client-bedrock-agentcore` — AWS SDK for AgentCore Memory
- `@aws-sdk/credential-providers` — AWS credential chain
- `openclaw` >= 0.2.0 (peer dependency)
