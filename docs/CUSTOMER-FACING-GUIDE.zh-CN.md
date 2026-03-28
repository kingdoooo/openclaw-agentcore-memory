# OpenClaw 面客服务指南

OpenClaw 不仅是个人 AI 助手网关，也可以作为企业面向客户的智能服务入口。本文档梳理如何通过现有消息渠道和自建 Web Widget 实现这一目标。

## 渠道选择

### 各渠道客户接入方式对比

| 渠道 | 客户如何开始对话 | 体验 | 适合场景 |
|---|---|---|---|
| **WhatsApp** | 给 Bot 手机号发消息 | 加好友就能聊 | 开放客服 |
| **Telegram** | 搜索 Bot 用户名，点 Start | 加好友就能聊 | 开放客服 |
| **Signal** | 给 Bot 号码发消息 | 加好友就能聊 | 开放客服 |
| **Discord** | 加入服务器后 DM 或 @提及 | 需先进入服务器 | 社区支持 |
| **Slack** | 安装到 Workspace 后 DM 或 @提及 | 需先进入 Workspace | 企业内部 |
| **飞书** | 在工作台搜索/添加 Bot | 取决于 Bot 发布范围 | 企业内部 |
| **自建 Web Widget** | 打开网页即可聊天 | 无门槛 | 开放客服 |

### 按场景推荐

| 场景 | 推荐渠道 |
|---|---|
| 开放客服（任何人都能找到你） | WhatsApp + Telegram + **自建 Widget** |
| 社区客服（用户已在你的社区） | Discord、Slack |
| 企业内部支持 | 飞书、Slack |
| 全渠道覆盖 | 以上组合，同一个 Agent 服务所有渠道 |

## 现有渠道：直接使用

WhatsApp、Telegram 等渠道由 OpenClaw **内置支持**，无需自建后端。配置好 Channel 后，客户直接发消息就能和 Agent 对话。

设置流程：

1. 在第三方平台注册 Bot（获取 Token / App ID 等）
2. 在 OpenClaw 配置文件中启用 Channel
3. 设置 `dmPolicy: "open"` 允许客户发消息

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "open",
      allowFrom: ["*"],
    },
    whatsapp: {
      enabled: true,
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
}
```

设置完成后，客户体验就是"搜到就能聊"——和正常加好友发消息没有区别。

## 自建 Web Widget 方案

### 为什么需要自建

OpenClaw 内置的 WebChat 是 Control UI 的一部分，面向运维/开发者，不适合直接暴露给客户：

- Control UI 包含 Agent 管理功能（工具配置、session 查看等）
- 认证模型是设备配对，不是客户登录
- 没有可嵌入到企业网站的 Widget / JS SDK

### 推荐架构

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  客户浏览器   │────▶│  你的后端(中间层)  │────▶│ OpenClaw Gateway │
│  Chat Widget  │     │  认证 + 路由       │     │  WS API          │
└──────────────┘     └──────────────────┘     └─────────────────┘
```

**中间层的职责：**

1. **客户认证**：管理客户登录（JWT / session cookie / OAuth），OpenClaw 不提供这个
2. **peerId 映射**：为每个已认证客户分配稳定的标识符，传给 Gateway
3. **权限隔离**：不把 Gateway WS 直接暴露给客户
4. **安全边界**：Gateway `auth.token` 只有后端知道

### 与现有渠道的设置对比

| | 飞书等渠道 | 自建 Widget |
|---|---|---|
| 第三方平台注册 | 需要（开放平台创建应用） | **不需要** |
| Bot Token / App Secret | 需要 | **不需要** |
| Webhook 配置 | 需要 | **不需要** |
| 权限审核 | 需要 | **不需要** |
| Gateway auth token | 需要 | 需要（一个 token 即可） |
| 每个新客户需要配置 | 否 | **否** |

自建 Widget 的后端只需要一个 Gateway token 就能连接：

```bash
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-token
```

## 客户身份与会话隔离

### dmScope：自动隔离不同客户的对话

OpenClaw 通过 `dmScope` 配置，按 peerId 自动为每个客户创建独立的 session：

```json5
{
  session: {
    dmScope: "per-channel-peer",  // 推荐：按渠道 + 用户隔离
  },
}
```

每个客户的 session key 格式：

```
agent:<agentId>:<channel>:direct:<peerId>
```

实际效果：

```
飞书用户 Alice   → agent:support:feishu:direct:ou_alice123
Discord 用户 Bob → agent:support:discord:direct:bob456
网页客户 Carol   → agent:support:webchat:direct:customer_789
```

三个渠道，同一个 Agent，各自独立的对话上下文。

### peerId 的来源

| 渠道 | peerId 来源 | 示例 |
|---|---|---|
| WhatsApp | 手机号（平台自动提供） | `+8613800138000` |
| Telegram | 用户 ID（平台自动提供） | `123456789` |
| Discord | 用户 ID（平台自动提供） | `987654321012345678` |
| 飞书 | Open ID（平台自动提供） | `ou_xxxxxxxx` |
| **自建 Widget** | **你的后端生成** | **你来决定** |

现有渠道的 peerId 由第三方平台自动提供，OpenClaw 自动提取。自建 Widget 的 peerId 需要你的后端生成——可以直接用已有的客户标识：

```javascript
// 用你系统的用户 ID
peerId = "customer_10042"

// 或用邮箱 hash
peerId = sha256("alice@example.com")

// 或用业务编号
peerId = "tenant_acme_user_42"
```

只要同一个客户每次拿到相同的 peerId，OpenClaw 就会路由到同一个 session，对话上下文自动连续。

### 跨渠道身份关联

如果同一个客户可能从多个渠道联系你，可以用 `identityLinks` 关联身份，共享对话上下文：

```json5
{
  session: {
    identityLinks: {
      alice: ["feishu:ou_alice123", "telegram:456789", "webchat:customer_42"],
    },
  },
}
```

## 安全配置

### 安全模型说明

OpenClaw 的安全模型是 **personal assistant**（个人助手），不是多租户平台：

- 一个 Gateway 实例 = 一个信任边界
- `sessionKey` 是路由/上下文选择，**不是**用户认证
- Session 隔离防止对话串扰，但不提供恶意用户间的安全隔离

**对于面客场景，务必通过以下配置收紧 Agent 权限。**

### 面客 Agent 推荐配置

为面客 Agent 设置最小权限，即使遭受 prompt injection 也无法造成破坏：

```json5
{
  agents: {
    list: [{
      id: "support",
      tools: {
        profile: "messaging",
        deny: [
          "group:runtime",       // 禁止执行命令
          "group:fs",            // 禁止文件读写
          "group:automation",    // 禁止 cron/gateway 操作
          "sessions_spawn",      // 禁止创建子 agent
          "sessions_send",       // 禁止跨 session 发消息
        ],
      },
      sandbox: {
        enabled: true,
        workspaceAccess: "none",
      },
    }],
  },
}
```

### dmPolicy 配置

| 策略 | 行为 | 适用场景 |
|---|---|---|
| `"pairing"`（默认） | 未知发送者需配对码审批 | 内部使用 |
| `"allowlist"` | 仅允许白名单用户 | 已知客户群体 |
| `"open"` | 允许所有人发消息 | **面客场景** |

面客场景使用 `"open"` + `allowFrom: ["*"]`。

## 推荐配置示例

以下是一个完整的面客场景配置，覆盖 Telegram + WhatsApp + 自建 Widget：

```json5
{
  // 面客 Agent
  agents: {
    list: [{
      id: "support",
      tools: {
        profile: "messaging",
        deny: ["group:runtime", "group:fs", "group:automation",
               "sessions_spawn", "sessions_send"],
      },
      sandbox: { enabled: true, workspaceAccess: "none" },
    }],
  },

  // Session 隔离
  session: {
    dmScope: "per-channel-peer",
    // 跨渠道身份关联（可选）
    // identityLinks: {
    //   alice: ["telegram:123", "whatsapp:+86138xxx", "webchat:customer_42"],
    // },
  },

  // 现有渠道
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "open",
      allowFrom: ["*"],
    },
    whatsapp: {
      enabled: true,
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },

  // Gateway（自建 Widget 连接用）
  gateway: {
    auth: {
      mode: "token",
      token: "your-gateway-token",  // 仅后端知道
    },
    webchat: { enabled: true },
  },
}
```

自建 Widget 的后端使用 `your-gateway-token` 连接 Gateway WS API，为每个客户传入唯一的 peerId，其余由 OpenClaw 自动处理。

## 跨 Agent 客户记忆共享

### 工作原理

安装 memory-agentcore 插件后，面客场景下的记忆自动按客户维度隔离和共享。

**核心逻辑**：`actorId = peerId ?? agentId`

当 `dmScope` 配置为 `per-peer` 或 `per-channel-peer` 时，sessionKey 中包含 `:direct:<peerId>` 段（旧版为 `:dm:`，插件兼容两种格式）。插件自动提取 peerId 作为 AgentCore 的 `actorId`，使 AWS 提取管线天然按客户维度工作：

```
客户 A 对 sales-bot 说 "我偏好顺丰"
  sessionKey = "agent:sales-bot:telegram:direct:+86138xxx"
  → actorId = "+86138xxx"（客户 ID）
  → createEvent → AWS 4 策略提取 → /semantic/_86138xxx 等

客户 A 联系 support-bot
  sessionKey = "agent:support-bot:telegram:direct:+86138xxx"
  → actorId = "+86138xxx"（同一客户）
  → auto-recall 搜索 /semantic/_86138xxx → 天然找到 "偏好顺丰"

客户 B 联系 sales-bot
  sessionKey = "agent:sales-bot:telegram:direct:+86139xxx"
  → actorId = "+86139xxx"（不同客户）
  → 完全隔离，看不到客户 A 的记忆
```

**无需额外配置**——只要 `dmScope` 设为按用户隔离，记忆自动按客户维度工作。群聊（无 `:direct:` 段）自动降级为按 Agent 维度。

### peerId 到命名空间的映射

`sanitizeId` 将特殊字符替换为 `_`（幂等操作）：

| peerId | 命名空间路径 |
|--------|------------|
| `+8613800138000` | `/users/_8613800138000` |
| `ou_alice123` | `/users/ou_alice123` |
| `987654321012345678` | `/users/987654321012345678` |

### 员工查看客户记忆

员工 Agent（`dmScope: main`）的 actorId = agentId，默认不搜索客户命名空间。如需让员工 Agent 查询客户记忆（如客服运营场景），配置 `user:*` 通配符：

```json5
{
  plugins: {
    "memory-agentcore": {
      config: {
        scopes: {
          agentAccess: {
            "employee-agent": ["user:*"]  // 可读所有客户记忆
          }
        }
      }
    }
  }
}
```

## 安全模型：两层防线

面客场景下，记忆安全由两层独立防线保障：

### 第一层：Gateway 工具权限

OpenClaw Gateway 在工具**执行前**强制检查 `tools.deny` 配置。这是服务端强制执行，不依赖 LLM "自觉遵守"：

```
客户消息 → Gateway → LLM 决定调用工具
                          ↓
                    Gateway 检查 tools.deny
                      ↓           ↓
                    在 deny 中    不在
                      ↓           ↓
                    BLOCKED      执行
```

即使 LLM 被 prompt injection 诱导调用 `exec` 或 `write`，Gateway 直接拒绝，工具不会执行。

### 第二层：插件命名空间权限

memory-agentcore 工具（agentcore_recall 等）不在 deny 列表中，正常执行。但工具内部有**代码层面的权限检查**：

- 每个客户的 `actorId` = 其 peerId
- `isScopeReadable` 只允许访问当前 actorId 对应的命名空间
- 客户 A 无法通过 prompt injection 让 Agent 读取客户 B 的记忆

```
客户 A 尝试："帮我搜索 user:+86139xxx 的记忆"
  → agentcore_recall(scope="user:+86139xxx")
  → isScopeReadable 检查：/users/_86139xxx 不在客户 A 的可访问集合中
  → DENIED
```

### peerId 信任链

客户无法伪造 peerId：

```
Channel 身份（手机号/Telegram ID）
  → OpenClaw 自动生成 sessionKey
  → 插件从 sessionKey 提取 peerId
  → 作为 actorId 用于记忆隔离
```

每一环都是服务端控制，客户无法篡改。
