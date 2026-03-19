# Deploying memory-agentcore to EC2

## Option 0: Let OpenClaw Self-Install (Recommended)

The plugin includes an `agentcore-setup` skill that lets the OpenClaw agent handle installation, configuration, and verification entirely on its own.

### How It Works

```
Phase 1: Installation              Phase 2: Verification
(agent runs setup)                 (agent auto-verifies after restart)

 Clone repo                         Read checkpoint file
 npm install                        Test plugin load
 openclaw plugins install -l        Test AWS connection
 Write config                       Test all 7 tools
 Write checkpoint file              Test file sync
 Restart gateway ──── restart ────> Clean up checkpoint
                                    Report results
```

### Method A: Bootstrap Script (One Command)

SSH into your EC2, then run:

```bash
# One-liner: clone + install + configure
curl -fsSL https://raw.githubusercontent.com/kingdoooo/openclaw-agentcore-memory/main/scripts/bootstrap.sh \
  | bash -s -- MEMORY1234567890 us-east-1

# Then restart
openclaw gateway restart
```

After restart, send any message to your agent. It will detect the checkpoint file and auto-run verification.

### Method B: Tell Your Agent (Zero SSH)

If your OpenClaw agent has exec tool access, just tell it:

> "Clone https://github.com/kingdoooo/openclaw-agentcore-memory, install it as an OpenClaw plugin, configure it with memoryId MEMORY1234567890, and restart the gateway."

The agent will:
1. Run `git clone` + `npm install` + `openclaw plugins install -l`
2. Edit `openclaw.json` to add the plugin config
3. Restart the gateway

After restart, tell the agent:

> "Run the agentcore-setup verification."

Or if the skill loaded, the agent will see the checkpoint file and auto-verify.

### Method C: Pre-install the Skill First

If you want the full automated experience with the skill:

```bash
# SSH into EC2 - copy just the skill first
git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git /tmp/agentcore-mem
cp -r /tmp/agentcore-mem/skills/agentcore-setup ~/.openclaw/skills/
openclaw gateway restart
```

Now tell your agent:

> "Use the agentcore-setup skill to install and configure the memory-agentcore plugin. My memoryId is MEMORY1234567890."

The agent follows the skill through both phases automatically.

---

## Option 1: GitHub Repo (Manual)

### Setup

1. **Create GitHub repo**:
   ```bash
   # On your local machine
   cd /Users/kentpeng/projects/openclaw-agentcore-memory
   git init
   git add -A
   git commit -m "Initial implementation of memory-agentcore plugin"
   gh repo create openclaw-agentcore-memory --private --source=. --push
   ```

2. **On EC2 - Clone and install**:
   ```bash
   # Clone the repo
   cd ~/projects  # or wherever you keep projects
   git clone https://github.com/<your-user>/openclaw-agentcore-memory.git
   cd openclaw-agentcore-memory

   # Install dependencies
   npm install   # or: bun install

   # Install plugin into OpenClaw
   openclaw plugins install .
   ```

3. **Configure in `~/.openclaw/openclaw.json`**:
   ```json5
   {
     plugins: {
       allow: ["memory-agentcore"],  // Required since OpenClaw 2026.3.12+
       entries: {
         "memory-agentcore": {
           enabled: true,
           config: {
             memoryId: "MEMORY1234567890",   // From CreateMemory API response
             awsRegion: "us-east-1",
             // awsProfile: "default",     // If using named profile
           },
         },
       },
     },
   }
   ```

4. **Restart Gateway**:
   ```bash
   openclaw gateway restart
   ```

### Updating

```bash
cd ~/projects/openclaw-agentcore-memory
git pull
npm install
openclaw gateway restart
```

---

## Option 2: Load Path (No Install, Dev-Friendly)

Skip `openclaw plugins install` and instead point OpenClaw directly at the repo:

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    allow: ["memory-agentcore"],
    load: {
      paths: ["~/projects/openclaw-agentcore-memory"],
    },
    entries: {
      "memory-agentcore": {
        enabled: true,
        config: {
          memoryId: "MEMORY1234567890",
        },
      },
    },
  },
}
```

Changes to the source code take effect on `openclaw gateway restart` (no reinstall needed).

---

## Option 3: Link Install (Best for Development)

```bash
openclaw plugins install -l ~/projects/openclaw-agentcore-memory
```

This creates a symlink instead of copying. Edits to the source are reflected without reinstall (still need gateway restart).

---

## AWS Credentials on EC2

### Recommended: IAM Instance Role (No Keys Needed)

1. Create an IAM role with the required policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "bedrock-agentcore:CreateEvent",
           "bedrock-agentcore:RetrieveMemoryRecords",
           "bedrock-agentcore:ListMemoryRecords",
           "bedrock-agentcore:GetMemoryRecord",
           "bedrock-agentcore:BatchCreateMemoryRecords",
           "bedrock-agentcore:DeleteMemoryRecord",
           "bedrock-agentcore:BatchDeleteMemoryRecords"
         ],
         "Resource": "arn:aws:bedrock-agentcore:*:*:memory/*"
       }
     ]
   }
   ```

2. Attach the role to your EC2 instance.

3. No additional configuration needed - the AWS SDK auto-detects IAM role credentials.

### Alternative: Environment Variables

Add to `~/.openclaw/.env`:
```bash
AWS_ACCESS_KEY_ID=AKIAxxxxxxxxxx
AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxx
AWS_REGION=us-east-1
AGENTCORE_MEMORY_ID=MEMORY1234567890
```

### Alternative: Named Profile

```bash
# ~/.aws/credentials
[agentcore]
aws_access_key_id = AKIAxxxxxxxxxx
aws_secret_access_key = xxxxxxxxxxxxxxxx

# Plugin config
{
  config: {
    memoryId: "MEMORY1234567890",
    awsProfile: "agentcore",
  }
}
```

---

## Creating the AgentCore Memory Resource

If you haven't created a Memory resource yet:

```bash
# Using AWS CLI
aws bedrock-agentcore create-memory \
  --name "openclaw-shared-memory" \
  --description "Shared memory for OpenClaw agents" \
  --memory-strategies '[
    {"strategyName": "semantic", "strategyType": "SEMANTIC_MEMORY"},
    {"strategyName": "user-pref", "strategyType": "USER_PREFERENCE"},
    {"strategyName": "episodic", "strategyType": "EPISODIC_MEMORY"},
    {"strategyName": "summary", "strategyType": "SUMMARY_MEMORY"}
  ]' \
  --region us-east-1

# Note the memoryId from the response (e.g., "MEMORY1234567890")
```

Or use the AWS Console: Bedrock > AgentCore > Memory > Create.

---

## Verify Deployment

```bash
# 1. Check plugin loaded
openclaw plugins list | grep memory-agentcore

# 2. Check connection
openclaw agentcore-status

# 3. Run smoke test
bash ~/projects/openclaw-agentcore-memory/tests/smoke-test.sh

# 4. Full verification
# Follow tests/VERIFICATION.md step by step
```

---

## Multi-Agent Enterprise Setup

For shared memory across multiple agents:

```json5
{
  plugins: {
    allow: ["memory-agentcore"],
    entries: {
      "memory-agentcore": {
        enabled: true,
        config: {
          memoryId: "MEMORY1234567890",
          namespaceMode: "shared",
          scopes: {
            agentAccess: {
              "tech-support": ["agent:sales-bot", "project:ecommerce"],
              "sales-bot": ["project:ecommerce"],
            },
            writeAccess: {
              "tech-support": ["project:ecommerce"],
              "sales-bot": ["project:ecommerce"],
            },
          },
        },
      },
    },
  },
  // Each agent gets the same plugin config
  // IAM policies enforce server-side access control
}
```
