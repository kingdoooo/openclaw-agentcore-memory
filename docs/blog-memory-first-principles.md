# 当 AI Agent 学会"团队记忆"：一个企业级共享记忆系统的设计

## 引言：AI Agent 的"记忆困境"

大语言模型（LLM）有一个众所周知的局限——上下文窗口是有限的，我们不能在一个会话里解决所有的问题。新的任务/需求往往需要创建新的会话，规避上下文窗口限制，同时也减少“无效信息污染”，提升对话质量。Agent 在跨会话时会清空上下文而"失忆"。上一次对话中建立的理解、达成的共识、用户表达的偏好，在新会话开始时都归零了。

对于单 Agent 场景，这个问题已有成熟解法。以 OpenClaw 内置的 memory-core 为例：Agent 将重要信息写入本地 Markdown 文件（MEMORY.md、memory/*.md），通过混合 BM25 + 向量搜索实现语义检索。这种方案足以让一个个人助手"记住"你的偏好和工作上下文。

**但当场景扩展到多 Agent 协作时，情况完全不一样。**

设想一个电商平台的 Agent 团队：

```
客户对销售 Agent 说："我偏好顺丰快递"
    ↓
销售 Agent 记住了——写入自己的本地 MEMORY.md
    ↓
客户转接到履约 Agent 处理发货
    ↓
履约 Agent：完全不知道这个偏好 → 选了默认物流
    ↓
客户投诉到客服 Agent
    ↓
客服 Agent：也不知道之前发生了什么 → 重新询问客户
```

每个 Agent 都像第一天上班的新员工——和同事之间没有任何信息共享。

这不是模型能力的问题，也不是 prompt 工程的问题。这是一个**记忆架构**的问题。单 Agent 的本地记忆是"个人笔记本"，而企业多 Agent 场景需要的是"团队知识管理系统"。

就像企业从"每个人记自己的笔记"演进到"共享知识库 + 权限管控"，Agent 的记忆系统也需要同样的演进。

### 五个基本问题

Agent 记忆系统都需要回答 5 个基本问题：

| # | 基本问题 | 本质 |
|---|---------|------|
| 1 | **记什么** (Extraction) | 从对话流中提取有价值信息，过滤噪音 |
| 2 | **怎么存** (Storage) | 持久化存储，跨会话、跨设备可用 |
| 3 | **怎么找** (Retrieval) | 在正确的时机找到正确的记忆 |
| 4 | **谁能看** (Access Control) | 多 Agent / 多用户场景下的权限隔离与共享 |
| 5 | **怎么管** (Lifecycle) | 更新、纠错、遗忘、共享 |

这 5 个问题恰好也是企业知识管理的经典问题：会议纪要该记哪些要点？存在本地还是飞书文档？需要时能不能搜到？哪些人能看哪些文档？过时信息怎么归档？

最近我开发了一个OpenClaw的企业级共享记忆插件：memory-agentcore，本文以该插件为案例，逐一展开这 5 个问题的设计决策和工程实现。

---

## 第一章 架构定位：叠加而非替代

在深入 5 个问题之前，先理解 memory-agentcore 在 OpenClaw 生态中的位置。这个定位决策是整个系统设计的基石。

### 三层记忆模型

OpenClaw 的记忆体系可以理解为三个独立但协同的层：

```
┌─────────────────────────────────────────────────────────────────┐
│                    上下文层 (Context Layer)                       │
│  引擎: Context Engine (如 lossless-claw)                         │
│  数据: 对话消息（每轮用户/助手/工具交互）                         │
│  价值: 不丢失消息、DAG 摘要、长对话支持                           │
│  范围: 当前 session 内自动组装 + 工具可跨 session 搜索            │
├─────────────────────────────────────────────────────────────────┤
│                    本地记忆层 (Local Memory)                      │
│  引擎: memory-core (OpenClaw 内置)                               │
│  数据: 工作区 Markdown 文件 (MEMORY.md, memory/*.md)             │
│  价值: 离线可用、语义向量搜索(BM25+向量)、零延迟加载              │
│  范围: 跨 session 持久存在，但限于本 Agent 工作区                 │
├─────────────────────────────────────────────────────────────────┤
│                 云端共享层 (Cloud Shared Memory)                  │
│  引擎: memory-agentcore (本插件)                                 │
│  数据: 跨 Agent 共享的记忆记录 (Memory Records)                  │
│  价值: 跨 Agent 共享、企业治理、4 策略自动提取、跨设备            │
│  范围: 跨 Agent、跨 session、跨机器                               │
└─────────────────────────────────────────────────────────────────┘
```

三层各管不同维度的数据：上下文层管"**发生了什么**"（对话历史），本地记忆层管"**记住了什么**"（策划性知识），云端共享层管"**共享了什么**"（跨 Agent 知识）。

### "general" 插件：零侵入式增强

OpenClaw 的插件系统有两个独占 Slot：Memory Slot 和 Context Engine Slot。同一时间只能有一个插件占据每个 Slot。memory-core 已占用 Memory Slot，lossless-claw 可能占用 Context Engine Slot。

memory-agentcore 选择注册为 `kind: "general"` —— 不占用任何 Slot，与两者和平共存。

```typescript
const plugin = {
  id: "memory-agentcore",
  name: "AgentCore Memory",
  kind: "general" as const,  // 不占 Slot → 零侵入
  // ...
};
```

这个决策的核心逻辑：
- Memory Slot 是独占的 —— 如果占用就意味着**替换** memory-core
- 企业不可能弃用本地记忆 —— 离线韧性是刚需
- `kind: "general"` = **安装即增强，卸载不影响**

类比一下：这不是换掉原来的 Wiki，而是在 Wiki 旁边加了一层跨部门的知识共享平台。两者各司其职。

### 有意的重叠不是冗余

三层之间存在内容重叠——这是**刻意设计**而非冗余：

| 重叠的内容 | 涉及的层 | 为什么需要重叠 |
|-----------|---------|-------------|
| 对话内容 | Context Engine (本地完整) + AgentCore (云端摘要) | 本地保证不丢失，云端供跨 Agent 访问 |
| 记忆文件 | memory-core (本地索引) + AgentCore (云端共享) | 本地保证离线可用，云端供其他 Agent 检索 |
| 提取的知识 | memory-core (手动策划) + AgentCore (自动提取) | 手动质量高但依赖 Agent 行为，自动覆盖广但可能有噪声 |

每份"副本"服务的是不同的访问模式和可用性需求。这与企业数据架构中"热/温/冷"分层存储的思路是一致的。

---

## 第二章 记什么：从对话流中提炼价值

> 核心矛盾：记太多 = 噪音淹没信号；记太少 = 丢失重要信息。

### AWS 托管提取引擎

memory-agentcore 在"记什么"这个问题上做了一个关键决策：**信任 AWS 的托管提取引擎，本地专注噪音预过滤。**

AWS Bedrock AgentCore 内置 4 种提取策略（Extraction Strategy），对每次 Agent 会话的对话内容并行运行：

| 策略 | 提取什么 | 例子 |
|------|---------|------|
| **SEMANTIC** | 事实和知识 | "该 API 使用 OAuth 2.0 认证" |
| **USER_PREFERENCE** | 用户偏好和选择 | "用户偏好 Python 而非 JavaScript" |
| **EPISODIC** | 结构化经验 + 跨会话反思 | "上次部署到生产环境，回滚了 3 次" |
| **SUMMARY** | 会话级别滚动摘要 | 每个 session 的精炼总结 |

这意味着插件**不需要自建 LLM 提取管线**——不需要维护提取 prompt、微调嵌入模型、管理提取队列。4 种策略并行运行，自动化程度最高。

代价当然存在：提取逻辑是黑盒，不可定制具体提取规则。但对企业来说，"开箱即用 + 零运维"的价值通常大于"完全可控 + 高运维成本"。

### 本地噪音预过滤：三层防线

虽然提取由 AWS 托管，但**噪音预过滤是本地的**。插件在将对话发送到 AgentCore 之前，以及在检索结果注入 prompt 之前，分别经过精心设计的过滤管道。

**第一层：自适应检索门控（Adaptive Retrieval Gating）**

并非每条用户消息都值得触发一次云端检索。以下类型的消息直接跳过：

- 纯问候："你好"、"hi"
- 命令：以 `/` 开头的 slash command
- 心跳信号："..."、"."
- 纯表情：emoji
- 过短消息：英文 < 15 字符，CJK < 6 字符

但如果消息中包含记忆相关关键词（"remember"、"previously"、"记得"、"之前"），即使很短也会触发检索。这种**语言感知的门控设计**确保了不会因为"你还记得上次我们讨论的方案吗？"这类短查询而漏掉检索。

**第二层：双语噪声过滤（Bilingual Noise Filter）**

面向中国市场的 Agent 必须处理中英文混合输入。噪声过滤器覆盖了多类低价值模式：

- 问候语（"谢谢" / "thank you"）
- 心跳信号（省略号、单字符）
- LLM 自我声明（"作为 AI 助手..."）
- 拒绝回复（"抱歉我无法..."）

关键设计：运维人员可以通过配置 `bypassPatterns`（强制通过）和 `noisePatterns`（强制过滤）的正则表达式来自定义规则，无需修改代码。例如，可以配置 `"^Error:"` 作为 bypass pattern，确保错误报告永远不会被过滤掉。

**第三层：分数间隙检测（Score Gap Detection / Elbow Point）**

传统的 top-K 检索只关心"取前 N 条"，不关心结果质量的断崖式下降。例如：

```
检索结果按分数排序: [0.95, 0.92, 0.88, 0.45, 0.40]
                                      ↑
                              这里有一个断崖
```

如果简单 top-5 返回，后两条低质量结果会被注入 prompt，浪费宝贵的上下文窗口甚至引入噪声。

memory-agentcore 使用**肘点算法（Elbow Point Detection）**：

1. 计算相邻分数的跌幅序列：`[0.03, 0.04, 0.43, 0.05]`
2. 计算平均跌幅：`0.1375`
3. 阈值 = 平均跌幅 x 乘数（默认 2.0）= `0.275`
4. 第一个超过阈值的跌幅在第 3→4 位之间（0.43 > 0.275）
5. 截断：只返回前 3 条

这让系统在不同查询、不同数据分布下都能自适应地找到"质量断崖"，避免一刀切的 top-K 设定。

### Fire-and-Forget 捕获

在 `agent_end` hook 中，auto-capture 采用 fire-and-forget 模式——异步发送，不阻塞 Agent 完成：

```typescript
void (async () => {
  // 噪声过滤 → 最小长度检查 → createEvent
})();
```

这意味着即使 AgentCore API 响应慢或超时，也不影响用户体验。捕获失败只记录警告日志，不影响 Agent 的下一轮对话。

---

## 第三章 怎么存：从对话到云端的数据路径

> 核心矛盾：托管服务 = 简单但锁定；自建 = 灵活但运维重。

### Auto-Capture → Event → Memory Record

理解 memory-agentcore 的存储设计，关键在于理解数据从对话到可检索记忆的完整路径：

```
agent_end hook 触发（每轮对话结束后）
  │
  ├─ 提取最后一对 user + assistant 消息
  │     ↓ 噪声过滤 + 最小长度检查（< 80 字符总长则跳过）
  │     ↓
  ├─ client.createEvent({ actorId, sessionId, messages })
  │     │
  │     │  Event 本身不指定命名空间，只携带:
  │     │  - actorId: 当前参与者标识（员工模式=agentId，面客模式=客户peerId）
  │     │  - sessionId: 当前会话标识
  │     │  - messages: 过滤后的对话消息
  │     │
  │     └─→ AWS AgentCore 服务端接收 Event
  │           │
  │           ├─ SEMANTIC 策略 → 提取事实和知识
  │           ├─ USER_PREFERENCE 策略 → 提取用户偏好
  │           ├─ EPISODIC 策略 → 提取结构化经验
  │           └─ SUMMARY 策略 → 生成会话摘要
  │                 │
  │                 └─→ Memory Records 写入命名空间 (per-agent 模式):
  │                       /agents/{actorId}      ← primary
  │                       /semantic/{actorId}    ← SEMANTIC 提取结果
  │                       /episodic/{actorId}    ← EPISODIC 提取结果
  │                       /preferences/{actorId} ← USER_PREFERENCE 提取结果
  │                       /summary/{actorId}     ← SUMMARY 摘要
  │
  └─ 触发文件同步（如已配置 fileSyncPaths）
```

**关键设计**：插件只负责"投喂"对话 Event，具体从哪条对话中提取什么、存到哪个命名空间，全部由 AWS AgentCore 引擎根据配置的策略自动决定。

### 两层数据模型

理解 Events 和 Memory Records 的区别很重要：

| 维度 | Events | Memory Records |
|------|--------|---------------|
| 是什么 | 原始对话的每轮摘要 | 4 种策略提取后的精炼记忆 |
| 生命周期 | 90 天过期（`eventExpiryDays` 可配置） | 持久化存储（不过期） |
| 用途 | 提取管线的**输入源** | auto-recall 和工具检索的**目标** |
| 直接检索？ | 不需要——当前 session 对话已在上下文窗口中 | 是的——这是跨 session 记忆的核心 |

Events 是"原材料 - 原始对话记录"，Memory Records 是"成品 - 使用策略提取后的记忆"。Events 存在的意义是喂给提取管线，提取完成后原始 Events 可以按 TTL 自动清理。

### 全托管的基础设施

存储层面的核心选择：AWS Bedrock AgentCore 全托管。

- **存储 + 索引 + 嵌入生成**全部由 AWS 管理
- **KMS 静态加密** + TLS 传输加密
- **弹性扩展**，无需管理容量、分片、副本
- 运行时**仅 2 个依赖**：`@aws-sdk/client-bedrock-agentcore` + `@aws-sdk/credential-providers`

这意味着企业不需要额外部署向量数据库、嵌入模型服务或索引管道。代价是 AWS 平台锁定——但对于已经在 AWS 生态中的企业来说，这通常不是新增的约束。

### 文件同步（可选能力）

memory-agentcore 提供了将本地文件同步到云端的能力，但**默认不同步任何文件**：

```typescript
fileSyncEnabled: true,     // 功能开关打开
fileSyncPaths: [],          // 但路径列表为空
// OpenClaw 已通过 Project Context 注入 bootstrap 文件
// 仅在需要同步额外文件时配置
```

这个设计是因为 OpenClaw 运行时已经将 SOUL.md、USER.md 等 bootstrap 文件注入到提示词中，重复同步没有意义。文件同步的真正价值在于：将 **Project Context 之外**的文件（如 `docs/api-reference.md`、`projects/*/context.md`）同步到云端，供其他 Agent 检索。

同步机制使用 SHA-256 哈希做变更检测——只有内容实际变化的文件才会触发 API 调用，状态持久化到 `.agentcore-sync.json` 防止重复同步。

---

## 第四章 怎么找：自动召回与智能检索

> 核心矛盾：精准度 vs 延迟 vs 成本。

### Auto-Recall：无感知的自动召回

memory-agentcore 的检索核心是 `before_prompt_build` hook——在每次模型执行前自动触发，对 Agent 和用户完全透明：

```
用户消息到达
  ↓
自适应门控：是否值得检索？
  ↓（通过门控）
从 sessionKey 解析 actorId
  ↓
resolveAccessibleNamespaces(actorId, scopes, mode)
  → ["/global", "/agents/{actorId}", "/semantic/{actorId}",
     "/episodic/{actorId}", "/preferences/{actorId}",
     "/summary/{actorId}", ...额外授权的命名空间]
  ↓
Promise.allSettled — 并行搜索所有命名空间
  ↓
合并结果 → 按 score 全局排序 → top-K → 分数间隙过滤
  ↓
格式化为 <agentcore_memory> XML → prependContext 注入
```

Agent 不需要知道记忆来自哪个命名空间、经过了几层过滤——它只在 prompt 开头看到一段相关的记忆上下文。

### 多命名空间并行搜索

一个典型的 Agent（如上文的 tech-support）可能需要搜索 10+ 个命名空间：自己的 primary + 4 个策略命名空间 + global + 被授权访问的其他 Agent 和项目命名空间。

memory-agentcore 使用 `Promise.allSettled` 并行查询所有命名空间：

```typescript
const results = await Promise.allSettled(
  namespaces.map((ns) =>
    client.retrieveMemoryRecords({
      query: promptStr,
      namespace: ns,
      topK: config.autoRecallTopK,
    }),
  ),
);
```

**关键设计**：`Promise.allSettled` 而非 `Promise.all`——单个命名空间的查询失败不会导致整体失败。如果 `/projects/ecommerce` 命名空间暂时不可用，来自 `/global` 和 `/agents/{actorId}` 的结果仍然会被正常返回。

所有命名空间的结果合并后，按 score 全局排序 → 统一 top-K → 分数间隙过滤。这确保了最终注入 prompt 的记忆是**跨所有可访问来源**的最佳结果，而不是某个单一命名空间的局部最优。

### 优雅降级

作为云端依赖服务，AgentCore 的可用性不是 100%。memory-agentcore 的降级策略是：

| 场景 | 行为 | 用户影响 |
|------|------|---------|
| AgentCore 离线 | auto-recall 返回空 | 本地 memory-core 继续工作，Agent 正常运行 |
| auto-capture 失败 | 静默警告日志 | Agent 正常完成，不阻塞用户 |
| 工具调用失败 | 返回错误信息 | Agent 可告知用户，建议稍后重试 |

这意味着 memory-agentcore 是一个**纯增强层**——有它更好，没它也不崩溃。本地的 memory-core 和 Context Engine 不受任何影响。

### 与 memory-core 的互补

两个记忆系统的检索能力是互补的，而非替代的：

| 维度 | memory-core | memory-agentcore |
|------|------------|-----------------|
| 搜索类型 | 混合 BM25 + 向量语义搜索 | 语义搜索（AWS 托管） |
| 延迟 | 毫秒级（本地 SQLite） | 秒级（云端 API） |
| 范围 | 本 Agent 工作区文件 | 所有可访问命名空间（跨 Agent） |
| 触发方式 | 按需（Agent 主动调用 memory_search） | 自动（before_prompt_build）+ 按需（agentcore_recall） |

Agent 在一次对话中可以同时使用两者：`memory_search` 搜索本地策划性知识，`agentcore_recall` 搜索云端共享记忆。两者返回不同维度的信息，Agent 综合使用。

---

## 第五章 谁能看：命名空间与权限治理

> 核心矛盾：隔离 vs 共享。Agent 既需要私有记忆，又需要跨 Agent 共享。

这是企业落地的核心关切——在多 Agent 环境中，**谁能看到什么记忆，谁能写入什么记忆**？

### 层级命名空间

memory-agentcore 使用 Scope 字符串到 AgentCore 命名空间（Namespace）的映射来组织记忆：

| Scope 字符串 | 命名空间 | 典型用途 |
|-------------|---------|---------|
| `global` | `/global` | 全局共享知识——所有 Agent 可见 |
| `agent:<id>` | `/agents/<id>` | Agent 私有记忆 |
| `project:<id>` | `/projects/<id>` | 项目级共享（如电商平台知识） |
| `user:<id>` | `/users/<id>` | 用户级偏好——跨 Agent 跟随用户 |
| `custom:<id>` | `/custom/<id>` | 自定义场景（团队、部门等） |

这种设计让权限管理可以按**组织结构**灵活映射：Agent 是个人，Project 是项目组，User 是客户。

### 最小权限原则

每个 actorId 默认只能访问：
- `/global`（全局共享，始终可读可写）
- 自己的主命名空间 + 4 个策略命名空间

跨 actorId 访问需要**显式配置** `agentAccess`。

**安全回退**：无效的 scope 字符串不会导致错误或权限升级，而是回退到 `global`——最小权限。

### 面客场景：actorId = 客户 ID

AWS AgentCore 的设计意图是 `actorId` = 终端用户。memory-agentcore 遵循这个设计：

```
actorId = peerId ?? agentId
```

当 OpenClaw 的 `dmScope` 配置为 `per-peer` 或 `per-channel-peer` 时，sessionKey 包含客户标识（`:direct:<peerId>`，旧版为 `:dm:`）。插件自动提取 peerId 作为 actorId，使记忆**天然按客户维度隔离和共享**：

| 条件 | actorId | 记忆维度 |
|------|---------|---------|
| 员工助手（dmScope: main） | agentId | 按 Agent 隔离 |
| 面客 DM（dmScope: per-peer） | **peerId（客户 ID）** | **按客户隔离** |
| 群聊（无 `:direct:` 段） | agentId（降级） | 按 Agent 隔离 |

回到引言的电商场景——在面客部署下：

```
客户 A 对 sales-bot："我偏好顺丰"
  → actorId = "+86138xxx"（客户 A 的手机号）
  → AWS 提取 → 记忆写入 /semantic/_86138xxx

客户 A 联系 support-bot
  → actorId = "+86138xxx"（同一客户）
  → auto-recall 搜索 /semantic/_86138xxx → 天然找到 "偏好顺丰"
```

不同 Agent 服务同一客户时，`actorId` 相同，提取和检索自动共享——**无需配置 `agentAccess`**。

不同客户之间，`actorId` 不同，命名空间天然隔离——即使客户通过 prompt injection 尝试访问其他客户的记忆，代码层面的权限检查（`isScopeReadable`）会直接拒绝。

### 两层安全防线

面客场景下，记忆安全不依赖 LLM 行为，而是由**代码层面**的两层防线保障：

| 防线 | 负责方 | 防什么 |
|------|--------|--------|
| Gateway `tools.deny` | OpenClaw Gateway（服务端） | 阻止 Agent 调用文件/命令等危险工具 |
| 插件 `isScopeReadable/Writable` | memory-agentcore 代码 | 阻止访问当前 actorId 以外的命名空间 |

客户无法伪造 peerId——它来自 Channel 身份（手机号、Telegram ID），由 OpenClaw 写入 sessionKey，插件从 sessionKey 提取。整个链路都是服务端控制。

### 与 AWS 治理栈的集成

命名空间是**客户端**的权限控制。在此之上，AWS 原生治理栈提供了服务端的安全保障：

| 能力 | 机制 |
|------|------|
| API 级访问控制 | IAM 策略——控制哪些 AWS 身份可以调用 AgentCore API |
| 操作审计 | CloudTrail——记录每次记忆操作（谁、什么时候、做了什么） |
| 数据加密 | KMS 静态加密 + TLS 传输加密 |

对于需要满足 SOC2、HIPAA 等合规要求的企业，这些能力不是可选的附加项，而是落地的前提条件。

---

## 第六章 怎么管：记忆的全生命周期

记忆不是"写入即忘"。和企业知识管理一样，Agent 的记忆也需要更新、纠错、删除、共享——完整的生命周期管理。

### 8 个 Agent 工具

memory-agentcore 提供 8 个 LLM 可调用的工具，覆盖记忆的完整生命周期。Agent 根据对话上下文自动判断何时调用哪个工具：

| 工具 | 操作 | 典型场景 |
|------|------|---------|
| `agentcore_store` | 主动存储重要信息 | 用户说"我们决定使用 DynamoDB"，Agent 识别为关键决策并保存 |
| `agentcore_recall` | 语义搜索记忆 | 用户问"上次我们讨论的 API 方案是什么？" |
| `agentcore_correct` | 原地更新记忆 | "截止日期改了，应该是 4 月 15 号" |
| `agentcore_forget` | 删除记忆（预览→确认） | "删除关于旧项目的记忆"，支持按 ID / 按搜索 / 清空 scope 三种模式 |
| `agentcore_search` | 列表/过滤记录 | recall 因语义索引延迟返回空时的回退方案 |
| `agentcore_episodes` | 搜索情境记忆 | 遇到类似技术问题时，搜索过去处理同类问题的经验 |
| `agentcore_share` | 跨命名空间推送 | 销售 Agent 将客户偏好推送到客服和履约的命名空间 |
| `agentcore_stats` | 连接状态和统计 | 排查问题时查看各命名空间的记忆分布 |

其中 `agentcore_store` 和 `agentcore_recall` 是最常用的两个。auto-capture 和 auto-recall 已经在后台自动处理大部分场景，手动工具是对自动化的**补充**——当 Agent 需要更精确的控制（指定 scope、策略、主动存储关键决策）时使用。

### 9 个 CLI 命令

除了 Agent 工具，还有面向运维人员的 CLI 命令：

```bash
openclaw agentcore-status     # 健康检查 + 配置验证
openclaw agentcore-search     # 语义搜索
openclaw agentcore-list       # 浏览记录
openclaw agentcore-remember   # 直接存储
openclaw agentcore-forget     # 删除（带确认）
openclaw agentcore-episodes   # 搜索情境记忆
openclaw agentcore-stats      # 统计信息
openclaw agentcore-sync       # 手动触发文件同步
openclaw agentcore-purge      # 批量清理
```

这些命令降低了调试门槛——当 Agent 行为不符预期时，运维人员可以直接检查记忆内容、手动修正或清理，而不需要通过对话间接操作。

### 自动化双循环

整个系统的自动化运行靠两个 hook 驱动的循环：

```
┌─────────────────────────────────────────┐
│           召回循环 (Recall Loop)          │
│                                          │
│  before_prompt_build hook                │
│    → 自适应门控                           │
│    → 多命名空间并行搜索                   │
│    → 合并排序 + 分数间隙过滤              │
│    → <agentcore_memory> XML 注入          │
│                                          │
│  每次模型执行前自动运行                   │
└─────────────────────────────────────────┘
                ↕
┌─────────────────────────────────────────┐
│          捕获循环 (Capture Loop)          │
│                                          │
│  agent_end hook (fire-and-forget)        │
│    → 提取最后一对 user+assistant 消息     │
│    → 噪声过滤 + 最小长度检查              │
│    → createEvent → AWS 4 策略提取         │
│    → 触发文件同步（如已配置）             │
│                                          │
│  每次对话结束后自动运行                   │
└─────────────────────────────────────────┘
```

两个循环形成闭环：捕获循环将对话沉淀为记忆，召回循环将记忆注入下一次对话。手动工具（store、correct、forget、share）是对这个自动闭环的干预和补充。

### 情境记忆与跨会话反思

值得特别提到的是 EPISODIC 策略和 `agentcore_episodes` 工具。

不同于 SEMANTIC（提取事实）和 USER_PREFERENCE（提取偏好），EPISODIC 策略提取的是**结构化经验**——"上次遇到这种情况，我们是怎么处理的？结果如何？"

更强大的是 AgentCore 支持 `reflectionConfiguration`——跨会话反思。系统可以自动分析多个 session 中的模式，生成类似"最近 3 次部署都遇到了数据库迁移超时，可能需要调整超时配置"的反思性记忆。

这让 Agent 不只是"记住发生了什么"，而是能"从经验中学习"。

---

## 结语：从"工具"到"同事"

让我们回到开头的电商场景。在面客模式（`dmScope: per-peer`）+ memory-agentcore 部署后：

```
客户 A 对销售 Agent 说："我偏好顺丰快递"
    ↓
actorId = "+86138xxx"（客户 A 的手机号）
auto-capture → createEvent(actorId="+86138xxx")
    → AWS 4 策略提取 → /preferences/_86138xxx: "偏好顺丰"
    ↓
客户 A 转接到履约 Agent
    ↓
actorId = "+86138xxx"（同一客户，不同 Agent）
auto-recall 搜索 /preferences/_86138xxx
    → 天然找到 "偏好顺丰" → 选择顺丰发货
    ↓
客户 A 询问客服 Agent
    ↓
actorId = "+86138xxx"
auto-recall → 获取完整的交互上下文 → 提供连贯的服务
```

三个 Agent 共享同一份客户认知——不是因为配置了跨 Agent 共享，而是因为它们服务的是**同一个 actorId**。记忆的隔离和共享完全由"谁在说话"决定。

### 记忆是 Agent 质变的关键

| Agent 状态 | 类比 |
|-----------|------|
| 没有记忆 | 每天都是新员工 |
| 有本地记忆 | 能记笔记的个人助手 |
| 有共享记忆的 Agent 群 | **有知识管理系统的团队** |

记忆的有无，决定了 Agent 是一个"每次都从零开始的工具"，还是一个"能积累经验、能与同事协作的同事"。

### 渐进式采用路径

如果你正在考虑为 Agent 团队引入共享记忆，不需要一步到位。memory-agentcore 的架构支持渐进式采用：

**阶段 1：单 Agent + memory-core**
→ 解决个人记忆，零额外成本

**阶段 2：+ memory-agentcore（员工助手模式）**
→ 云端持久化 + 4 策略自动提取，跨设备可用

**阶段 3：多 Agent + 命名空间隔离 + 跨 Agent 共享**
→ 团队记忆，企业级治理

**阶段 4：面客模式（dmScope: per-peer）**
→ 记忆自动按客户维度隔离，跨 Agent 天然共享，安全两层防线

每个阶段都可以独立运行、独立验证价值，不需要推翻前一阶段的工作。

### 开放问题

最后，有几个这个领域尚未完全解决的问题，值得关注：

1. **记忆冲突**：两个 Agent 存储了矛盾的信息（"客户偏好顺丰" vs "客户偏好京东物流"），如何仲裁？当前依赖时间戳和人工纠正，缺乏自动冲突解决机制。

2. **记忆老化**：过时信息的自动失效。Events 有 90 天 TTL，但 Memory Records 是持久的。"去年的部署流程"如果没有被主动更新或删除，可能在今年的对话中仍然被召回。

3. **跨平台标准**：不同 Agent 框架（OpenClaw、LangChain、AutoGen...）的记忆格式和接口尚无统一标准。记忆在框架间的互通仍需要自定义集成。

这些问题没有银弹，但它们定义了这个领域的下一步方向。

---

*memory-agentcore 是一个 OpenClaw 插件，使用 Amazon Bedrock AgentCore Memory 作为后端。项目开源在 GitHub。*
