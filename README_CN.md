# memory-agentcore

[English](README.md)

基于 **Amazon Bedrock AgentCore Memory** 的 OpenClaw 企业级共享记忆插件。

## 为什么需要这个插件？

OpenClaw 内置的 memory-core 将记忆存储为本地 Markdown 文件，每个 Agent 独立管理。对于单 Agent 个人使用场景足够了，但在企业多 Agent 场景下会遇到瓶颈：

**场景举例：电商多 Agent 协作** — 客户告诉销售 Agent "我偏好顺丰快递"。之后，物流 Agent 处理订单时并不知道这个偏好。客服 Agent 处理投诉时也没有之前交互的上下文。

| 能力 | 内置 memory-core | memory-agentcore |
|------|-----------------|-----------------|
| 存储方式 | 本地 `.md` 文件 | 云端（AgentCore 托管） |
| 跨 Agent 共享 | 不支持 | 基于 namespace 共享 + IAM 控制 |
| 记忆提取 | 手动（Agent 写入文件） | 自动（4 种内置策略） |
| 情景学习 | 不支持 | 跨会话反思，自动提炼模式 |
| 访问控制 | 文件系统权限 | IAM 策略 + CloudTrail 审计 |
| 加密 | 无 | KMS 静态加密 + TLS 传输加密 |
| 手动删除文件 | 手动删除文件 | API 驱动，带审计记录 |

本插件与 memory-core **共存** — 本地记忆离线可用，云端记忆在此基础上增加共享和治理能力。

## 功能特性

- **跨 Agent 共享记忆**：基于 namespace 的隔离与共享
- **企业级治理**：IAM 访问控制、CloudTrail 审计、KMS 加密
- **托管提取**：AgentCore 内置策略（语义、用户偏好、情景、摘要）
- **情景记忆**：Agent 从历史交互中学习，跨情景反思提炼洞察
- **自动召回**：每轮对话前自动注入相关记忆
- **自动捕获**：每轮对话后自动捕获对话内容
- **文件同步**：将本地文档同步到 AgentCore 用于语义搜索（默认为空 — 引导文件已在 Prompt 中）
- **按需删除记忆**：通过 `agentcore_forget` 工具
- **双语噪声过滤**（中/英）和自适应检索
- **面客模式**：自动按客户维度隔离记忆（`actorId = peerId ?? agentId`），跨 Agent 天然共享

### 两种部署模式

| 模式 | actorId | 记忆维度 | 适用场景 |
|------|---------|---------|---------|
| 员工助手（默认） | agentId | 按 Agent | `dmScope: main` |
| 面客 DM | **客户 peerId** | **按客户** | `dmScope: per-peer` |

面客模式无需额外配置——插件从 sessionKey 自动提取 peerId。详见 **[面客服务指南](docs/CUSTOMER-FACING-GUIDE.zh-CN.md)**。

**安全**：面客部署务必配合 `tools.deny`（禁用文件/命令工具）和 `sandbox`（沙箱隔离）。插件的命名空间权限检查在代码层面强制客户间隔离，prompt injection 无法绕过。

## 前提条件

- OpenClaw 运行中（2026.3.12+）
- 已安装 [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- EC2 实例角色已绑定 `BedrockAgentCoreFullAccess` 托管策略（或参考下方[最小权限配置](#所需-iam-权限)）
- Node.js 18+、git

## 快速开始：Agent 自动部署（推荐）

将 **[docs/AGENT-DEPLOY-PROMPT.zh-CN.md](docs/AGENT-DEPLOY-PROMPT.zh-CN.md)** 中的提示词复制发给你的 OpenClaw agent（[English](docs/AGENT-DEPLOY-PROMPT.md)），它会自动完成：

1. 创建 AWS AgentCore Memory 资源（4 种策略）
2. 克隆、构建、配置插件
3. 更新 AGENTS.md（添加插件使用指南）
4. 重启 Gateway 并执行 13 步验证

**你只需要提供**：AWS 区域（如 `us-west-2`）

## 手动安装

### 第 1 步：创建 AgentCore Memory 资源

为本次 OpenClaw 部署创建**专用的** Memory 资源。不要复用其他项目的 Memory —— 不同项目的策略和 namespace 可能不兼容，数据会混在一起。

> **注意**：控制面 CLI 是 `bedrock-agentcore-control`，**不是** `bedrock-agentcore`（那是数据面）。

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

> Summary 和 Episodic 的 namespace **必须**包含 `{sessionId}`。Episodic **必须**配置 `reflectionConfiguration`。

等待状态变为 ACTIVE：
```bash
aws bedrock-agentcore-control get-memory --memory-id "<ID>" --region us-west-2
```

### 第 2 步：克隆并构建

```bash
PLUGIN_DIR="$HOME/.openclaw/plugins/memory-agentcore"
mkdir -p "$HOME/.openclaw/plugins"
git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git "$PLUGIN_DIR"
cd "$PLUGIN_DIR"
npm install
npm run build
```

> `npm run build` 是**必须的**。插件从 `dist/` 加载编译后的 JS。

### 第 3 步：配置

编辑 `~/.openclaw/openclaw.json`：

> **所有路径必须是绝对路径，不能用 `~`** —— Node.js 不会展开 `~`，会导致 `plugins.load failed`。

```json5
{
  plugins: {
    allow: ["memory-agentcore"],              // OpenClaw 2026.3.12+ 必须
    load: {
      paths: ["/home/ubuntu/.openclaw/plugins/memory-agentcore"]  // 绝对路径
    },
    entries: {
      "memory-agentcore": {
        enabled: true,
        config: {
          memoryId: "<你的_MEMORY_ID>",       // 第 1 步获取
          awsRegion: "us-west-2"
        }
      }
    }
  }
}
```

> 不要同时执行 `openclaw plugins install .` —— 同时使用 `load.paths` 和 `install` 会导致 `duplicate plugin id` 错误。

### 第 4 步：重启并验证

```bash
openclaw gateway restart

# 重启后：
openclaw plugins list | grep memory-agentcore
openclaw agentcore-status
```

## 配置参考

### 全部选项

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `memoryId` | **（必填）** | AgentCore Memory 资源 ID |
| `awsRegion` | `us-east-1` | AWS 区域 |
| `awsProfile` | - | 指定 AWS 凭证 Profile |
| `enabled` | `true` | 启用/禁用插件 |
| `strategies` | `["SEMANTIC","USER_PREFERENCE","EPISODIC","SUMMARY"]` | 激活的提取策略 |
| `autoRecallTopK` | `5` | 每轮注入的记忆数（0=禁用） |
| `autoCaptureEnabled` | `true` | 自动捕获对话 |
| `autoCaptureMinLength` | `30` | 触发捕获的最小消息长度 |
| `noiseFilterEnabled` | `true` | 过滤问候/心跳等噪声 |
| `adaptiveRetrievalEnabled` | `true` | 跳过简单查询的检索 |
| `namespaceMode` | `per-agent` | 搜索前缀粒度：`per-agent` = `/semantic/{actorId}`（隔离），`shared` = `/semantic`（前缀匹配所有 agent 数据） |
| `eventExpiryDays` | `90` | 短期事件保留天数 |
| `showScores` | `false` | 召回时显示相似度分数 |
| `fileSyncEnabled` | `true` | 启用文件同步到 AgentCore |
| `fileSyncPaths` | `[]` | 同步的文件（支持 glob）。默认为空 — 引导文件已在 Prompt 中 |
| `maxRetries` | `3` | AWS SDK 重试次数 |
| `timeoutMs` | `10000` | 单次请求超时（ms） |

### 环境变量

所有字段支持环境变量覆盖：

| 变量 | 对应字段 |
|------|---------|
| `AGENTCORE_MEMORY_ID` | `memoryId` |
| `AGENTCORE_ENABLED` | `enabled` |
| `AWS_REGION` / `AGENTCORE_REGION` | `awsRegion` |
| `AWS_PROFILE` / `AGENTCORE_PROFILE` | `awsProfile` |
| `AGENTCORE_AUTO_RECALL_TOP_K` | `autoRecallTopK` |
| `AGENTCORE_AUTO_CAPTURE_ENABLED` | `autoCaptureEnabled` |
| `AGENTCORE_NOISE_FILTER_ENABLED` | `noiseFilterEnabled` |
| `AGENTCORE_FILE_SYNC_ENABLED` | `fileSyncEnabled` |
| `AGENTCORE_SHOW_SCORES` | `showScores` |

## AWS 凭证与权限

支持 AWS SDK 凭证链（按优先级）：
1. 环境变量（`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`）
2. 命名 Profile（`awsProfile` 配置或 `AWS_PROFILE`）
3. AWS SSO
4. IAM 角色（EC2、ECS、Lambda）

### 所需 IAM 权限

**数据面**（插件运行时 —— 绑定到 EC2 实例角色）：
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

**控制面**（仅在 Agent 自动创建 Memory 资源时需要）：
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

## 工具

| 工具 | 说明 |
|------|------|
| `agentcore_recall` | 语义搜索已存储的记忆 |
| `agentcore_store` | 保存事实/偏好/决策到长期记忆 |
| `agentcore_forget` | 删除记忆（支持预览+确认） |
| `agentcore_correct` | 原地更新/修正现有记忆 |
| `agentcore_search` | 按 namespace 和策略列出/筛选记录 |
| `agentcore_stats` | 记忆统计和连接状态 |
| `agentcore_share` | 跨 scope/namespace 共享记忆 |
| `agentcore_episodes` | 搜索情景记忆中的历史经验 |

## Skills

| Skill | 触发方式 | 说明 |
|-------|---------|------|
| `agentcore-memory-validation` | `运行 agentcore-memory-validation` | 19 项自动化测试，无需重启 |
| `agentcore-memory-guide` | `运行 agentcore-memory-guide` | 工具参考、共享记忆、配置、最佳实践 |

## CLI 命令

```bash
openclaw agentcore-status              # 连接检查 + 配置显示
openclaw agentcore-search <query>      # 语义搜索
openclaw agentcore-list [--scope] [--strategy]  # 列出记录
openclaw agentcore-forget <id>         # 删除记录
openclaw agentcore-episodes <query>    # 搜索情景记忆
openclaw agentcore-stats [--scope]     # 策略统计
openclaw agentcore-sync                # 手动触发文件同步
openclaw agentcore-remember <fact>     # 直接存储一条事实
```

## 多 Agent 企业共享

多个 Agent 通过同一个 Memory 资源 + namespace 实现记忆共享：

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
          memoryId: "<你的_MEMORY_ID>",
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

权限始终强制执行。每个 Agent 默认只能访问 `/global` + 自己的 namespace（`/agents/<id>`、`/semantic/<id>`、`/episodic/<id>`、`/preferences/<id>`、`/summary/<id>`）。跨 Agent 访问需要显式配置 `scopes`——条目在默认权限基础上**追加**（无需列出 `global` 或 `agent:<自己>`）。IAM 策略在服务端强制执行。

**重要**：共享 Memory ID 时，每个 Agent **必须**有唯一的 agent ID（openclaw.json 中的 `agents.list[].id`）。未设置时所有 Agent 默认为 `main`，记忆会意外合并。

### Scope 格式

| Scope 字符串 | AgentCore Namespace |
|-------------|---------------------|
| `global` | `/global` |
| `agent:refund-bot` | `/agents/refund-bot` |
| `project:ecommerce` | `/projects/ecommerce` |
| `user:alice` | `/users/alice` + 策略命名空间 |
| `user:alice:semantic` | `/semantic/alice`（单策略） |
| `custom:team-x` | `/custom/team-x` |

> 修改 memory-agentcore 配置前，请先让你的 OpenClaw Agent 查阅 [agentcore-memory-guide](skills/agentcore-memory-guide/SKILL.md) skill。Agent 理解规则后会自行完成配置修改。完整的 scope 语法参考、跨 Agent 共享模式和问题排查均在此 skill 中。

### Namespace 架构

Auto-capture（`createEvent`）写入策略 namespace，Auto-recall 自动搜索这些 namespace。

**数据流**（per-agent 模式，actorId = "bija"，sessionId = "s1"）：

```
createEvent(actorId="bija", sessionId="s1")
  └─ AWS 策略提取并存储：
       SEMANTIC         → /semantic/bija           ← 跨会话 ✅
       USER_PREFERENCE  → /preferences/bija        ← 跨会话 ✅
       SUMMARY          → /summary/bija/s1         ← 会话级
       EPISODIC episodes→ /episodic/bija/s1        ← 会话级
       EPISODIC reflect → /episodic/bija           ← 跨会话 ✅

Auto-recall 搜索（最少 7 个 namespace）：
  /global + /agents/bija                           （主 namespace，手动 store 用）
  /semantic/bija + /preferences/bija               （跨会话策略）
  /episodic/bija                                   （episodic 反思）
  /summary/bija/s1 + /episodic/bija/s1             （仅当前会话）
```

跨 Agent 共享（通过 `agentAccess`）会为每个授权 Agent 增加 actor 级策略 namespace（每个 Agent 约增加 5 个）。所有搜索通过 `Promise.allSettled` 并行执行。

**跨会话 vs 会话内**：

| 记忆类型 | 跨会话？ | 会话内？ |
|---------|---------|---------|
| 语义事实 | ✅ | ✅ |
| 用户偏好 | ✅ | ✅ |
| Episodic 反思 | ✅ | ✅ |
| 会话摘要 | — | ✅ |
| 独立 episode | — | ✅ |
| 手动 store（`/global`） | ✅ | ✅ |

### 多机部署

所有共享记忆的机器**必须**：
1. 使用**同一个 Memory ID**（通过 AWS CLI 创建一次）
2. 拥有访问该 Memory ID 的 AWS 凭证
3. 配置**唯一的 agent ID**（不要都使用默认的 `main`）
4. 共享 `scopes.agentAccess` 配置以实现跨 Agent 读取

> 不同 Memory ID 之间**无法**共享记忆。每个 Memory ID 是完全隔离的存储空间。

## 架构

```
本地记忆 (内置 memory-core)              云端记忆 (memory-agentcore)
  MEMORY.md, USER.md                      AgentCore Memory 服务
  始终可用，离线工作                        跨 Agent 共享，需联网
       |                                        |
       +--- OpenClaw 将两者合并注入到 Prompt ---+
```

### 记忆类型

- **短期记忆**：会话内的原始对话事件（通过 `agent_end` hook 自动捕获）
- **长期记忆**：跨会话提取的结构化洞察，按 4 种策略组织：
  - **语义（Semantic）**：事实和知识（"该 API 使用 OAuth 2.0"）
  - **用户偏好（User Preference）**：用户的选择和风格（"用户偏好 Python"）
  - **摘要（Summary）**：每个会话的滚动摘要
  - **情景（Episodic）**：结构化的交互经验 + 跨情景反思提炼模式

### 生命周期 Hook

- **`before_prompt_build`**：自动召回 —— 搜索 AgentCore，将相关记忆注入 Prompt
- **`agent_end`**：自动捕获（异步） —— 捕获最近一组对话 + 同步变更文件

### 优雅降级

当离线或 AgentCore 不可用时：
- 自动召回返回空（本地 memory-core 仍正常工作）
- 自动捕获静默失败（记录为警告日志）
- 工具返回错误信息（Agent 可以告知用户）

## 更新

```bash
cd ~/.openclaw/plugins/memory-agentcore
git pull
npm run build
openclaw gateway restart
```

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| `plugins.load failed` | 配置中路径使用了 `~` | 改为绝对路径 |
| `duplicate plugin id` | 同时使用了 `install` 和 `load.paths` | 删除 `~/.openclaw/extensions/memory-agentcore/` |
| `text.trim is not a function` | 插件版本过旧 | `git pull && npm run build && openclaw gateway restart` |
| `Connection: FAILED` | 凭证错误或 memoryId 不对 | `aws sts get-caller-identity` + 检查 memoryId |
| Recall 返回空 | 新数据索引延迟（30-60秒） | 等待后重试，或用 `agentcore_search`（列表模式）确认数据存在 |
| `ValidationException: searchQuery` | 空查询字符串 | 已在最新版本修复；`git pull && npm run build` |
| 找不到工具 | 插件未加载 | 检查 `openclaw plugins list` 和日志 |
| `missing openclaw.extensions` | package.json 版本过旧 | `git pull && npm run build` |

## 依赖

- `@aws-sdk/client-bedrock-agentcore` — AgentCore Memory AWS SDK
- `@aws-sdk/credential-providers` — AWS 凭证链
- `openclaw` >= 0.2.0（peer dependency）
