# memory-agentcore

OpenClaw plugin for enterprise shared memory via **Amazon Bedrock AgentCore Memory**.

Registers as `kind: "general"`, coexisting with OpenClaw's built-in memory-core. The built-in memory-core manages local MEMORY.md files (offline-capable), while memory-agentcore adds cloud-based shared memory, governed extraction, and episodic learning via AgentCore.

## Features

- **Shared memory** across agents via namespace-based isolation/sharing
- **Enterprise governance**: IAM access control, CloudTrail audit, KMS encryption
- **Managed extraction**: AgentCore's built-in strategies (SEMANTIC, USER_PREFERENCE, EPISODIC, SUMMARY)
- **Episodic memory**: agents learn from past experiences
- **Auto-recall**: inject relevant memories before each agent turn
- **Auto-capture**: automatically capture conversations after each agent run
- **File sync**: sync MEMORY.md/USER.md/memory/*.md to AgentCore
- **GDPR-compliant deletion** via `agentcore_forget`
- **Bilingual noise filter** (EN/ZH) and adaptive retrieval gating

## Installation

### Option A: Let your OpenClaw agent do it (recommended)

Copy the ready-made prompts from **[docs/AGENT-DEPLOY-PROMPT.md](docs/AGENT-DEPLOY-PROMPT.md)** and send them to your agent. It will handle everything: AWS resource creation, plugin installation, configuration, and verification.

### Option B: Manual installation

```bash
# Clone to OpenClaw plugins directory
git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git ~/.openclaw/plugins/memory-agentcore
cd ~/.openclaw/plugins/memory-agentcore
npm install && npm run build
```

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for detailed manual setup, IAM permissions, and multi-agent enterprise configuration.

## Configuration

In your OpenClaw agent config:

```jsonc
{
  "plugins": {
    "allow": ["memory-agentcore"],  // Required since OpenClaw 2026.3.12+
    "entries": {
      "memory-agentcore": {
        "enabled": true,
        "config": {
          "memoryId": "MEMORY1234567890",  // Required: from CreateMemory API response
          "awsRegion": "us-east-1",
          "strategies": ["SEMANTIC", "USER_PREFERENCE", "EPISODIC", "SUMMARY"],
          "autoRecallTopK": 5,
          "autoCaptureEnabled": true,
          "noiseFilterEnabled": true,
          "fileSyncEnabled": true,
          "namespaceMode": "per-agent",
          "showScores": false
        }
      }
    }
  }
}
```

### Environment Variables

All config fields support env var override:

| Variable | Config Field |
|----------|-------------|
| `AGENTCORE_MEMORY_ID` | `memoryId` |
| `AWS_REGION` / `AGENTCORE_REGION` | `awsRegion` |
| `AWS_PROFILE` / `AGENTCORE_PROFILE` | `awsProfile` |
| `AGENTCORE_AUTO_RECALL_TOP_K` | `autoRecallTopK` |
| `AGENTCORE_AUTO_CAPTURE_ENABLED` | `autoCaptureEnabled` |
| `AGENTCORE_NOISE_FILTER_ENABLED` | `noiseFilterEnabled` |
| `AGENTCORE_FILE_SYNC_ENABLED` | `fileSyncEnabled` |
| `AGENTCORE_SHOW_SCORES` | `showScores` |

### AWS Credentials

Uses the AWS SDK credential chain (in order):
1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. Named profiles (`awsProfile` config or `AWS_PROFILE`)
3. AWS SSO
4. IAM roles (EC2, ECS, Lambda)

**Required IAM permissions** (attach to your EC2 instance role or IAM user):
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

## Tools

| Tool | Description |
|------|-------------|
| `agentcore_recall` | Semantic search through stored memories |
| `agentcore_store` | Save facts/preferences/decisions to long-term memory |
| `agentcore_forget` | Delete memories (GDPR-compliant, preview+confirm) |
| `agentcore_correct` | Update/correct existing memory (retry+fallback to create) |
| `agentcore_search` | List/filter records by namespace and strategy |
| `agentcore_stats` | Memory statistics and connection status |
| `agentcore_share` | Share memory across multiple scopes/namespaces |
| `agentcore_episodes` | Search episodic memory for past experiences |

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

## Enterprise Shared Memory

Configure multiple agents to share memory via scopes:

```jsonc
{
  "memoryId": "MEMORY1234567890",
  "namespaceMode": "shared",
  "scopes": {
    "agentAccess": {
      "tech-support": ["agent:sales-bot", "agent:refund-bot", "project:ecommerce"],
      "sales-bot": ["project:ecommerce"],
      "refund-bot": ["project:ecommerce"]
    },
    "writeAccess": {
      "tech-support": ["project:ecommerce"],
      "sales-bot": ["project:ecommerce"],
      "refund-bot": ["project:ecommerce"]
    }
  }
}
```

### Scope Format

| Scope String | AgentCore Namespace |
|-------------|---------------------|
| `global` | `/global` |
| `agent:refund-bot` | `/agents/refund-bot` |
| `project:ecommerce` | `/projects/ecommerce` |
| `user:alice` | `/users/alice` |
| `custom:team-x` | `/custom/team-x` |

## Architecture

```
Local Memory (built-in memory-core)     Cloud Memory (memory-agentcore)
  MEMORY.md, USER.md                      AgentCore Memory Service
  Always available, offline-capable       Shared, governed, online-only
       |                                        |
       +--- OpenClaw merges both into prompt ---+
```

### Lifecycle Hooks

- **`before_agent_start`**: Auto-recall - searches AgentCore, returns `{ prependContext }` with relevant memories
- **`agent_end`**: Auto-capture (fire-and-forget) - captures conversation events + syncs changed files

### Graceful Degradation

When offline or AgentCore unavailable:
- Auto-recall returns empty (local memory-core still works)
- Auto-capture silently fails (logged as warning)
- Tools return error messages (agent can inform user)

## Dependencies

- `@aws-sdk/client-bedrock-agentcore` - AWS SDK for AgentCore Memory
- `@aws-sdk/credential-providers` - AWS credential chain
- `openclaw` >= 0.2.0 (peer dependency)
