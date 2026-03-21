# memory-agentcore 架构与协同工作文档

本文档详细描述 memory-agentcore 插件如何与 OpenClaw 生态系统协同工作，涵盖插件 Slot 机制、企业级能力、提示词构建流程、接口设计、以及多 Agent 共享记忆架构。

---

## 目录

1. [原始对话到记忆的完整路径](#1-原始对话到记忆的完整路径)
2. [OpenClaw 两个 Plugin Slot 的区别](#2-openclaw-两个-plugin-slot-的区别)
3. [memory-core 在企业多 Agent 场景的局限性](#3-memory-core-在企业多-agent-场景的局限性)
4. [三层插件协同 — 提示词构建流程](#4-三层插件协同--提示词构建流程)
5. [memory-agentcore 接口设计与独特功能](#5-memory-agentcore-接口设计与独特功能)
6. [多 Agent 共享 Memory 详解](#6-多-agent-共享-memory-详解)

---

## 1. 原始对话到记忆的完整路径

对话数据从原始记录到可检索记忆，经历两层转化。理解这个路径是理解 memory-agentcore 定位的前提。

### 两层模型

```
原始对话记录 (Raw Conversation)
├── sessions_history — OpenClaw 本地 session 存储 (JSONL)
│   完整对话记录，所有 role 的消息，本地持久
└── AgentCore Events — AWS 云端 (90 天过期)
    auto-capture 每轮最后一对 user+assistant 消息
    作为策略提取的输入源

提炼后的记忆 (Extracted Memory)
├── MEMORY.md / memory/*.md — 用户手动策划的笔记和日志
│   由 Agent 或用户手动写入，memory-core 索引
└── AgentCore Memory Records — AWS 策略自动提取
    4 种策略: SEMANTIC, USER_PREFERENCE, EPISODIC, SUMMARY
    auto-recall 自动注入上下文
```

### 关键要点

1. **原始对话只有两个来源**：sessions_history（本地完整转录）和 AgentCore Events（云端每轮摘要）
2. **提炼后的记忆是两条平行路径**：本地 .md 文件（手动策划）和 AgentCore Memory Records（自动提取），两者都来源于原始对话
3. Events 不用于直接召回——当前 session 已在上下文窗口中；跨 session 回放由 `sessions_list` + `sessions_history` 覆盖。Events 存在的目的是喂给提取管线，而非直接检索

### sessions_history vs AgentCore Events

| 维度 | sessions_history | AgentCore Events |
|------|-----------------|-----------------|
| 内容 | 完整转录（所有消息） | 每轮最后一对 user+assistant |
| 存储 | 本地 JSONL | AWS 云端 |
| 过期 | 无（文件持久） | 90 天 |
| 访问方式 | Agent 工具（visibility 作用域） | Plugin API（namespace 作用域） |
| 跨 Agent | 有限 | 基于命名空间 |
| 用途 | 对话回放与上下文 | 喂给策略提取管线 |

---

## 2. OpenClaw 两个 Plugin Slot 的区别

**来源**: OpenClaw 插件文档 "Plugin slots" 节, OpenClaw 上下文文档 "Context engine plugins" 节

OpenClaw 有两个**独占 Slot**（同一时间只能有一个插件占据每个 Slot）：

| 对比项 | Memory Slot | Context Engine Slot |
|--------|-------------|---------------------|
| 配置路径 | `plugins.slots.memory` | `plugins.slots.contextEngine` |
| 默认引擎 | `memory-core` | `legacy` |
| 可选引擎 | `memory-lancedb` | `lossless-claw` 等第三方 |
| 插件声明 | `kind: "memory"` | `kind: "context-engine"` |
| 职责 | 长期记忆存储与检索（memory_search, memory_get） | 上下文组装、压缩、会话管理 |
| 生命周期 | 工具调用 + 自动 memory flush | Ingest → Assemble → Compact → After turn |
| 输出方式 | 按需工具调用返回结果 | `assemble()` 返回 messages + systemPromptAddition |

### Memory Slot（memory-core）职责

- 将 `MEMORY.md` 和 `memory/*.md` 索引到 SQLite 向量数据库（来源: OpenClaw memory 文档 "Vector memory search" 节）
- 在 session 启动时加载记忆文件到上下文（来源: OpenClaw memory 文档 "Memory files" 节）：
  - `MEMORY.md` — 同时也是 bootstrap file（与 AGENTS.md、USER.md 等一起由运行时加载到 system prompt），仅在 main/private session 中加载
  - `memory/YYYY-MM-DD.md` — 在 session 启动时自动读取今天和昨天的日志
- 提供 `memory_search`（混合 BM25 + 向量搜索）和 `memory_get` 工具供 Agent 按需调用（来源: OpenClaw memory 文档 "Memory tools" 节）
- 在压缩前触发自动 memory flush，提醒 agent 保存重要信息（来源: OpenClaw memory 文档 "Compaction and memory" 节）
- **注意**：memory-lancedb 是 memory-core 的替代品，额外提供 auto-recall/capture 功能（来源: OpenClaw 插件文档 "Bundled plugins" 节）

### Context Engine Slot 职责

来源: OpenClaw 上下文文档 "Context engine plugins" 节

- 控制模型在每次运行时看到什么**对话消息**
- 四个生命周期节点：
  1. **Ingest** — 新消息入库/索引
  2. **Assemble** — 在 token 预算内组装上下文，返回 messages + systemPromptAddition
  3. **Compact** — 上下文窗口满时摘要压缩
  4. **After turn** — 持久化状态、触发后台压缩
- legacy 引擎: 透传（不做额外处理，由运行时管线处理）
- lossless-claw: DAG 摘要系统，永不丢失消息

### 两者操作不同的数据

| 维度 | Memory Plugin | Context Engine |
|------|--------------|----------------|
| 管理的数据 | 工作区 .md 文件（MEMORY.md, 日志等） | 对话消息（用户/助手/工具的每一轮交互） |
| 数据生命周期 | 跨 session 持久（文件一直存在） | 按 session/conversation 组织 |
| 注入时机 | Session 启动时加载 + 按需工具调用 | 每次模型运行前 assemble() |
| 来源 | OpenClaw memory 文档 "Memory files" 节 | OpenClaw 上下文文档 "How it works" 节 |

### 协同方式

来源: context-engine 文档 "Relationship to compaction and memory" 节：

> "Memory plugins (plugins.slots.memory) are separate from context engines. Memory plugins provide search/retrieval; context engines control what the model sees. They can work together — a context engine might use memory plugin data during assembly."

**实际协同**：目前 lossless-claw 的 `assemble()` 仅使用自身 DAG 数据（来源: lossless-claw `architecture.md` "Context assembly" 节），不直接调用 memory plugin 的数据。"might use" 是 API 层面的可能性——自定义 context engine 可以在 `assemble()` 中查询 memory plugin 数据，但现有实现没有这样做。两者的协同是**并行提供**给模型：

1. Memory plugin 的记忆文件在 system prompt 区域
2. Context engine 组装的消息在 conversation messages 区域
3. Agent 在运行时可以同时调用 `memory_search` 和 `lcm_grep` 来获取不同维度的信息

---

## 3. memory-core 在企业多 Agent 场景的局限性

**来源**: OpenClaw memory 文档, `README.md:7-22`

| 局限性 | 具体表现 | 来源 |
|--------|---------|------|
| 单 Agent 隔离 | MEMORY.md "Only loaded in main, private session (never in group contexts)" | OpenClaw memory 文档 |
| 本地文件存储 | 记忆存储为 Markdown 文件在工作区内，无跨机器共享 | OpenClaw memory 文档 |
| 无跨 Agent 共享 | 无内置的多 Agent 记忆共享机制 | `README.md:13-14` |
| 无企业级访问控制 | 仅依赖文件系统权限 | `README.md:19` |
| 无审计追踪 | 无法追踪谁在何时修改了记忆 | `README.md:19` |
| 无加密 | 本地明文存储 | `README.md:20` |
| 手动提取 | Agent 自己写入文件，无自动策略提取 | `README.md:17` |

### memory-agentcore 为何适合企业

来源: `README.md:5-33`

| 能力 | memory-agentcore 方案 |
|------|---------------------|
| 存储 | AWS AgentCore 云托管 |
| 跨 Agent 共享 | 基于命名空间的隔离与共享 + IAM 策略 |
| 自动提取 | 4 种内置策略（SEMANTIC, USER_PREFERENCE, EPISODIC, SUMMARY） |
| 情境学习 | 跨会话反思和模式检测（Episodic） |
| 访问控制 | IAM 策略 + CloudTrail 审计 |
| 加密 | KMS 静态加密 + TLS 传输加密 |
| 记忆删除 | API 驱动删除，有审计记录 |

---

## 4. 三层插件协同 — 提示词构建流程

来源: OpenClaw agent loop 文档, OpenClaw 上下文文档, `src/index.ts:127-209`, lossless-claw `architecture.md`

### 4.0 提示词构建全景图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    OpenClaw Prompt Assembly                         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              SYSTEM PROMPT (系统提示词)                       │   │
│  │                                                              │   │
│  │  1. OpenClaw Base Prompt (核心指令)                          │   │
│  │     来源: OpenClaw agent loop 文档                            │   │
│  │                                                              │   │
│  │  2. Skills Prompt (技能指令)                                 │   │
│  │     来源: OpenClaw agent loop 文档                            │   │
│  │                                                              │   │
│  │  3. Bootstrap Context (引导文件)                             │   │
│  │     AGENTS.md | SOUL.md | TOOLS.md | IDENTITY.md | USER.md  │   │
│  │     + MEMORY.md (仅 main session，同时也是 bootstrap file)  │   │
│  │     + memory/今天.md + 昨天.md (session 启动时自动读取)      │   │
│  │     来源: OpenClaw agent loop 文档, memory 文档              │   │
│  │                                                              │   │
│  │  4. Context Engine -> systemPromptAddition                   │   │
│  │     (lossless-claw: "Use lcm_grep to search history...")    │   │
│  │     来源: OpenClaw 上下文文档 "System prompt addition" 节    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │         CONVERSATION MESSAGES (对话消息)                      │   │
│  │                                                              │   │
│  │  5. memory-agentcore auto-recall (自动回忆)                  │   │
│  │     <agentcore_memory> XML block                             │   │
│  │     hook: before_prompt_build -> { prependContext }            │   │
│  │     注意: prependContext 是前置到用户消息，不是独立的层       │   │
│  │     来源: src/index.ts:127-209, OpenClaw 插件文档             │   │
│  │                                                              │   │
│  │  6. Context Engine -> assemble() 返回的 messages              │   │
│  │     legacy: 原始消息 + 压缩摘要                              │   │
│  │     lossless-claw: DAG 摘要 + 最近 N 条原始消息             │   │
│  │     格式: [summary_1...summary_n, message_1...message_m]     │   │
│  │     来源: lossless-claw architecture.md "Context assembly"   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │         ON-DEMAND TOOLS (按需工具 — Agent 运行时调用)        │   │
│  │                                                              │   │
│  │  Memory Slot (memory-core):                                  │   │
│  │    memory_search — 混合 BM25+向量 搜索本地记忆文件           │   │
│  │    memory_get    — 读取特定 .md 文件/行范围                  │   │
│  │    来源: OpenClaw memory 文档 "Memory tools" 节              │   │
│  │                                                              │   │
│  │  Context Engine (lossless-claw):                             │   │
│  │    lcm_grep     — 搜索历史消息和摘要（支持跨会话）          │   │
│  │    lcm_describe — 查看特定摘要/文件的完整内容               │   │
│  │    lcm_expand_query — 深度召回：子 Agent 展开 DAG 回答问题  │   │
│  │    来源: lossless-claw agent-tools.md                        │   │
│  │                                                              │   │
│  │  memory-agentcore (general plugin):                          │   │
│  │    agentcore_recall   — 语义搜索云端记忆                     │   │
│  │    agentcore_store    — 保存到云端长期记忆                    │   │
│  │    agentcore_forget   — 记忆删除（预览->确认）                │   │
│  │    agentcore_correct  — 原地更新/纠正记忆                    │   │
│  │    agentcore_search   — 列表/过滤记录                        │   │
│  │    agentcore_episodes — 搜索情境记忆                         │   │
│  │    agentcore_share    — 跨命名空间共享                       │   │
│  │    agentcore_stats    — 连接状态/统计                        │   │
│  │    来源: README.md:216-227, src/index.ts:105-125             │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 三层各自负责什么

| 层级 | 插件 | 管理的数据 | 作用范围 | 数据流向 |
|------|------|-----------|----------|----------|
| Context Layer | lossless-claw (contextEngine slot) | 对话消息（每轮用户/助手/工具交互） | 当前 session 的消息组装；工具可跨 session 搜索 | 消息 → SQLite DAG → assemble() 返回给模型 |
| Local Memory | memory-core (memory slot) | 工作区 .md 文件（MEMORY.md, 日志等） | 跨 session 持久存在（文件一直在） | .md → session 启动时加载 + 按需工具调用 |
| Cloud Memory | memory-agentcore (general plugin) | 云端共享记忆（跨 Agent、跨机器） | 跨 Agent、跨 session、跨机器 | 对话 → AgentCore API → 4 策略提取 → auto-recall 注入 |

### 4.1 lossless-claw 的作用范围详解

> **注意**：lossless-claw 是第三方可选 Context Engine 插件，不是 OpenClaw 核心功能。以下描述基于 lossless-claw 自身的文档。

**来源**: lossless-claw `architecture.md` "Data model" 节, `agent-tools.md`

lossless-claw 永不丢失消息，但这个"不丢失"的范围需要明确：

- **每个 OpenClaw session 映射为一个 conversation**（来源: architecture.md "Every OpenClaw session maps to a conversation"）
- **DAG 摘要和上下文组装是 per-session 的**：`assemble()` 仅返回当前 conversation 的数据
- **当 session reset 时**，新 session 创建新 conversation，旧 conversation 的数据仍在 SQLite 中
- **工具支持跨 session 搜索**：`lcm_grep` 和 `lcm_expand_query` 都支持 `allConversations: true` 参数（来源: agent-tools.md "Conversation scoping" 节）

所以：
- **当前 session 内**：所有消息自动可见（通过 assemble 组装进 context）
- **跨 session**：需要 Agent 主动调用 `lcm_grep(allConversations: true)` 搜索

### 4.2 lossless-claw 与 Memory Plugin 的区别和协同

| 对比维度 | lossless-claw | memory-core |
|---------|---------------|-------------|
| 存储内容 | 原始对话消息 + DAG 摘要 | 策划性记忆文件（事实、偏好、日志） |
| 写入方式 | 自动（每条消息自动 ingest） | 手动（Agent 写入 .md 文件） |
| 搜索方式 | `lcm_grep`（regex/FTS）+ `lcm_expand_query`（子 Agent 深度召回） | `memory_search`（混合 BM25+向量语义搜索） |
| 上下文注入 | 自动（assemble 组装消息历史） | MEMORY.md 作为 bootstrap file 加载到 system prompt；日志文件在 session 启动时读取 |
| 跨 session | 工具可搜索历史会话 | 文件始终存在，始终可搜索 |
| 来源 | lossless-claw architecture.md, agent-tools.md | OpenClaw memory 文档 |

**两者何时需要协同**：

它们操作**不同维度的数据**，不需要直接调用对方的 API，而是**并行**为 Agent 提供信息：

1. **lossless-claw 负责"发生了什么"**（对话历史）— 上周讨论了什么？用了哪些命令？
2. **memory-core 负责"记住了什么"**（策划性知识）— 团队偏好是什么？架构决策记录在哪？
3. **memory-agentcore 负责"共享了什么"**（跨 Agent 云端记忆）— 其他 Agent 知道什么？客户偏好是什么？

Agent 在一次对话中可以同时使用三层的工具，例如：
- 用 `lcm_grep` 搜索 "上周讨论的部署方案"（对话历史）
- 用 `memory_search` 搜索 "部署规范"（工作区知识）
- 用 `agentcore_recall` 搜索 "部署相关的共享记忆"（云端共享）

### 数据流时序

```
用户消息到达
    |
    +---> Context Engine: ingest() 存入 SQLite (lossless-claw)
    |
    +---> Session bootstrap: 加载 MEMORY.md + 日志 + AGENTS.md 等到 system prompt
    |       (bootstrap files 在 session 初始化阶段加载，早于 hooks)
    |
    +---> before_prompt_build hook (memory-agentcore):
    |       搜索 AgentCore -> 返回 prependContext (前置到用户消息)
    |
    +---> Context Engine: assemble()
    |       组装 DAG 摘要 + 最近消息 + systemPromptAddition
    |
    +---> 模型运行
    |       可调用: memory_search, lcm_grep, agentcore_recall 等
    |
    +---> Context Engine: afterTurn()
    |       ingest 新消息, 评估是否需要压缩
    |
    +---> agent_end hook (memory-agentcore):
            auto-capture 对话 -> AgentCore (fire-and-forget)
            file-sync 本地 .md -> AgentCore
```

### 4.3 三层重叠与不可替代性

三层之间存在**部分内容重叠**，这是有意设计而非冗余。

**重叠分析**：

| 重叠内容 | 涉及的层 | 为什么重叠 | 来源 |
|---------|---------|-----------|------|
| 对话内容 | lossless-claw 存储所有消息; agentcore auto-capture 存储每轮最后一对消息 | lossless-claw 是本地 per-session; agentcore 将对话上传到云端供跨 Agent 访问 | architecture.md "Data model"; `src/index.ts:224-226` |
| 记忆文件 | memory-core 管理 MEMORY.md; agentcore file-sync 同步 MEMORY.md 到云端 | 本地版保证离线可用; 云端版供其他 Agent 和远程访问 | OpenClaw memory 文档; `src/file-sync.ts`; `README.md:33` |
| 提取的知识 | memory-core 的 MEMORY.md 是手动策划的事实/偏好; AgentCore SEMANTIC/USER_PREFERENCE 策略自动提取类似内容 | 手动策划质量高但依赖 Agent 行为; 自动提取覆盖面广但可能有噪声 | OpenClaw memory 文档 "Compaction and memory" 节; `README.md:28-29` |

**每层的不可替代价值**：

注意：lossless-claw 和 memory-core 都是本地存储，区别不在于"是否本地"，而在于**数据来源和搜索方式**：

| 层 | 管理的数据 | 不可替代的功能 | 如果去掉会怎样 | 来源 |
|----|-----------|-------------|-------------|------|
| lossless-claw | **对话消息**（每条自动 ingest） | DAG 摘要不丢失消息; Agent 可用 lcm_expand 回溯原始细节; regex/FTS 搜索对话历史 | 长对话被截断, 无法回忆早期对话细节 | architecture.md "Context assembly" |
| memory-core | **工作区文件**（Agent 策划写入的 .md + `extraPaths` 外部文档） | 语义向量搜索(BM25+向量+MMR); 索引外部 .md 目录如 `../team-docs`; session 启动零延迟加载 | 丧失策划性知识库; 无法搜索外部团队文档; 丧失语义搜索能力 | OpenClaw memory 文档 "Memory files" / "Vector memory search" / "Additional memory paths" 节 |
| memory-agentcore | **云端共享记忆**（AgentCore 托管） | **跨 Agent 共享**, IAM 访问控制, 自动 4 策略提取, KMS 加密 | Agent 之间无法共享记忆; 无企业级治理和审计 | `README.md:13-21` |

**为什么 lossless-claw 不能替代 memory-core**：

1. memory-core 可以索引**非对话内容**（外部 .md 文件, 通过 `extraPaths` 配置, 来源: OpenClaw memory 文档 "Additional memory paths" 节）
2. memory-core 的内容是 Agent **策划后的精华**（MEMORY.md = "Curated long-term memory"），不是原始对话
3. 搜索能力差异（来源: OpenClaw memory 文档 "Vector memory search" 节, lossless-claw `agent-tools.md`）：

| 搜索能力 | lossless-claw | memory-core |
|---------|--------------|-------------|
| 关键词搜索 | `lcm_grep` regex + FTS5 | `memory_search` BM25 |
| 语义向量搜索 | 无 | 支持（向量嵌入，毫秒级，来源: OpenClaw memory 文档 "Vector memory search" 节） |
| LLM 推理搜索 | `lcm_expand_query` 子 Agent（30-120s，来源: agent-tools.md） | 无 |

lossless-claw 的 `lcm_grep` 仅支持 `"regex"` 和 `"full_text"` 两种模式（来源: agent-tools.md "lcm_grep" 节），不提供向量语义搜索。`lcm_expand_query` 通过 LLM 子 Agent 实现语义级别的理解，但代价更高（~30-120 秒 vs 毫秒级向量搜索）。

**使用建议**：

- **单 Agent 个人用**: memory-core + lossless-claw 即可
- **单 Agent 需要不丢失上下文**: 加 lossless-claw
- **多 Agent 企业场景**: 加 memory-agentcore（与前两者共存，来源: `README.md:23`）

> "This plugin **coexists** with memory-core — local memory still works offline, cloud memory adds sharing and governance on top." — `README.md:23`

---

## 5. memory-agentcore 接口设计与独特功能

### 5.1 插件注册方式

来源: `src/index.ts:40-43`, OpenClaw 插件文档 "Plugin slots" 节

`kind: "general"` — 不占用 memory 或 contextEngine slot，与两者共存。这是刻意的设计：
- memory slot 已被 memory-core 占用
- contextEngine slot 可被 lossless-claw 占用
- general 类型不受 slot 独占限制

```typescript
// src/index.ts:40-43
const plugin = {
  id: "memory-agentcore",
  name: "AgentCore Memory",
  kind: "general" as const,
```

### 5.2 八个工具 — 功能与典型场景

所有工具均注册为 Agent 工具，由 LLM 根据对话上下文自动判断何时调用（来源: `src/index.ts:105-125`）。用户无需手动配置触发条件。

**常用工具**（来源: `SKILL.md:132-134` "Best Practices" 节）：

> "Use `agentcore_store` for explicit, important facts/decisions. Auto-capture handles routine conversation extraction."
>
> "`agentcore_recall` uses semantic search (meaning-based, may have 30-60s index delay). `agentcore_search` uses list mode (no delay). Use search as fallback when recall returns empty."

| 工具 | 功能 | 典型场景 | 来源 |
|------|------|----------|------|
| `agentcore_recall` | 语义搜索云端记忆 | 用户问 "上次我们讨论的API方案是什么？"，agent 需要更精确的搜索时主动调用 | `src/tools/recall.ts:13-14` |
| `agentcore_store` | 保存重要事实/决策 | 用户说 "我们决定使用 DynamoDB"，agent 识别为重要决策并保存 | `src/tools/store.ts:8-9` |
| `agentcore_forget` | 预览→确认两步删除 | 用户说 "删除关于旧项目的记忆"，agent 先预览（confirm=false）再确认删除 | `src/tools/forget.ts:8-9` |
| `agentcore_correct` | 原地更新记忆 | 用户说 "之前的截止日期说错了，应该是4月15号"，agent 找到原记录并更新 | `src/tools/correct.ts:33-34` |
| `agentcore_search` | 列表/过滤记录 | recall 返回空（索引尚未就绪），agent 用 search 作为回退 | `src/tools/search.ts:8-9` |
| `agentcore_episodes` | 搜索过去经验和模式 | Agent 遇到类似技术问题时，搜索过去处理同类问题的经验记录 | `src/tools/episodes.ts:13-14` |
| `agentcore_share` | 跨命名空间共享 | 销售 Agent 获知客户偏好后，推送到客服和履约 Agent 的命名空间 | `src/tools/share.ts:8-9` |
| `agentcore_stats` | 连接状态/统计 | 用户问 "AgentCore 连接正常吗？" 或排查问题时 | `src/tools/stats.ts:12-13` |

**注意**：`agentcore_recall` 和 `agentcore_store` 是最常用的两个工具。auto-recall hook 已在每次对话前自动注入相关记忆，auto-capture hook 已在每次对话后自动捕获。工具是对自动化的补充——当 agent 需要更精确的控制（指定 scope、strategy、主动存储重要决策）时使用。

### 5.3 两个 Hook

来源: `src/index.ts:127-285`

**before_prompt_build (Auto-Recall)** — `src/index.ts:127-203`:

```
1. 提取用户最新消息作为 query
2. 自适应检索门控（跳过问候、命令等）
3. 从 sessionKey 解析 actorId
4. resolveAccessibleNamespaces() 获取所有可访问命名空间
5. Promise.allSettled 并发搜索所有命名空间
6. 合并结果 -> 按 score 排序 -> 取 top K -> score gap 过滤
7. 格式化为 <agentcore_memory> XML block
8. 返回 { prependContext: ... }（前置到用户消息）
```

**agent_end (Auto-Capture)** — `src/index.ts:211-285`:

```
1. Fire-and-forget（void async，不阻塞 agent 完成）
2. 提取最后一对 user+assistant 消息
3. 双语噪声过滤器（EN/ZH）
4. 最小长度检查（用户消息长度 < 20 字符 或 总长度 < autoCaptureMinLength 时跳过）
5. 发送到 AgentCore createEvent API
6. 触发文件同步（fileSync.syncAll）
```

### 5.4 托管服务优势

来源: `README.md:5-33`, AWS SDK calls in `src/client.ts`

| 优势 | 说明 |
|------|------|
| 自动提取 | AgentCore 内置 4 种策略（SEMANTIC, USER_PREFERENCE, EPISODIC, SUMMARY），无需手动编写提取逻辑 |
| 托管基础设施 | 无需维护向量数据库、嵌入模型、索引管道 |
| IAM 原生 | 使用 AWS IAM 策略控制访问，CloudTrail 记录每次 API 调用 |
| KMS 加密 | 静态数据 KMS 加密 + TLS 传输加密 |
| 弹性扩展 | 无需管理存储容量、分片、副本 |
| 事件过期 | 可配置 eventExpiryDays（默认 90 天）自动清理 |
| 跨会话反思 | EPISODIC 策略支持 reflectionConfiguration，自动生成跨会话的经验总结 |

### 5.5 文件同步

来源: `src/file-sync.ts:1-166`

- SHA-256 哈希变更检测（仅同步有变化的文件）— `src/file-sync.ts:62-64`
- 默认同步: MEMORY.md, USER.md, SOUL.md, TOOLS.md, memory/*.md — `README.md:33`
- 2000 字符分块上传 — `src/file-sync.ts:19`（`CHUNK_SIZE = 2000`，操作 JS 字符串，单位是字符而非字节）
- 桥接本地记忆与云端：本地 memory-core 写入的 .md 文件自动同步到 AgentCore
- 状态持久化到 `.agentcore-sync.json`，避免重复同步 — `src/file-sync.ts:18`

---

## 6. 多 Agent 共享 Memory 详解

来源: `README.md:249-289`, `src/scopes.ts:1-96`

### 6.1 命名空间映射

来源: `src/scopes.ts:26-39`

| Scope 字符串 | AgentCore 命名空间 |
|-------------|---------------------|
| `global` | `/global` |
| `agent:<id>` | `/agents/<id>` |
| `project:<id>` | `/projects/<id>` |
| `user:<id>` | `/users/<id>` |
| `custom:<id>` | `/custom/<id>` |

```typescript
// src/scopes.ts:26-39
export function scopeToNamespace(scope: Scope): string {
  switch (scope.kind) {
    case "global":    return "/global";
    case "agent":     return `/agents/${sanitizeId(scope.id ?? "")}`;
    case "project":   return `/projects/${sanitizeId(scope.id ?? "")}`;
    case "user":      return `/users/${sanitizeId(scope.id ?? "")}`;
    case "custom":    return `/custom/${sanitizeId(scope.id ?? "")}`;
  }
}
```

### 6.2 访问控制模型

来源: `src/scopes.ts:46-82`, `README.md:249-286`

每个 Agent 默认可以访问：
- `/global`（全局共享）
- `/agents/<自己的ID>`（自己的记忆）

通过 `scopes.agentAccess` 配置额外的读权限：

```json5
{
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

`resolveAccessibleNamespaces()` 的实现（`src/scopes.ts`）：

```typescript
export function resolveAccessibleNamespaces(
  actorId: string,
  scopesConfig: ScopesConfig,
  mode: NamespaceMode,                                     // "per-agent" | "shared" | ...
): string[] {
  const ns = new Set<string>();
  ns.add("/global");                                       // 1. 始终包含 /global
  ns.add(scopeToNamespace({ kind: "agent", id: actorId })); // 2. 始终包含自己的命名空间

  // 3. 当前 agent 的策略命名空间（由 createEvent 写入）
  for (const sn of buildStrategyNamespaces(actorId, mode)) ns.add(sn);
  // per-agent → /semantic/<actorId>, /episodic/<actorId>, ...
  // shared   → /semantic, /episodic, ...

  // 4. 额外配置的读权限 — 只有 agent scope 会展开策略命名空间
  const accessList = scopesConfig.agentAccess[actorId];
  if (accessList) {
    for (const scopeStr of accessList) {
      const scope = parseScope(scopeStr);
      ns.add(scopeToNamespace(scope));
      if (scope.kind === "agent" && scope.id) {
        for (const sn of buildStrategyNamespaces(scope.id, mode)) ns.add(sn);
      }
    }
  }
  return [...ns];
}
```

### 6.3 Auto-Recall 的多命名空间搜索

来源: `src/index.ts:152-184`

```
before_prompt_build hook:
  1. 从 sessionKey 解析 actorId
  2. resolveAccessibleNamespaces(actorId, config.scopes, config.namespaceMode)
     -> ["/global", "/agents/<actorId>", "/semantic/<actorId>", "/episodic/<actorId>", ..., ...额外配置的命名空间]
  3. 对所有可访问命名空间并发 Promise.allSettled(RetrieveMemoryRecords)
  4. 合并结果 -> 按 score 排序 -> 取 top K -> score gap 过滤
  5. 格式化为 <agentcore_memory> XML block -> prependContext
```

关键代码（`src/index.ts:162-184`）：

```typescript
// Parallel search across all accessible namespaces
const results = await Promise.allSettled(
  namespaces.map((ns) =>
    client!.retrieveMemoryRecords({
      query: promptStr,
      namespace: ns,
      topK: config.autoRecallTopK,
    }),
  ),
);

const allRecords = results
  .filter((r): r is PromiseFulfilledResult<MemoryRecordResult[]> =>
    r.status === "fulfilled")
  .flatMap((r) => r.value);

// Sort by score, take top K, then apply score gap filter
allRecords.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
const topK = allRecords.slice(0, config.autoRecallTopK);
const topRecords = filterByScoreGap(topK, config);
```

### 6.4 企业场景示例

来源: `README.md:9-12`

电商 3 Agent 场景：

```
客户 --> 销售 Agent: "我偏好快递"
              |
              +-- agentcore_store(content="客户偏好快递", scope="project:ecommerce")
              |
              +-- agentcore_share(content="客户偏好快递",
                    target_scopes=["agent:fulfillment", "agent:support"])

客户 --> 履约 Agent: 处理订单
              |
              +-- auto-recall 自动搜索 /global + /agents/fulfillment + /projects/ecommerce
              |   返回: "客户偏好快递" (来自 project:ecommerce)
              |
              +-- 自动选择快递发货

客户 --> 客服 Agent: 处理投诉
              |
              +-- auto-recall 自动搜索 /global + /agents/support
              |   + agentcore_recall(query="客户交互历史", scope="project:ecommerce")
              |
              +-- 获取之前的交互上下文，提供个性化服务
```

通过 `project:ecommerce` 命名空间，三个 Agent 共享客户偏好和交互历史。

### 6.5 情境记忆（Episodic）

来源: `src/scopes.ts:84-95`, `src/tools/episodes.ts`

命名空间格式: `/strategy/episodic/actor/<actorId>[/session/<sessionId>]`

```typescript
// src/scopes.ts:84-95
export function buildEpisodicNamespace(
  actorId?: string,
  sessionId?: string,
): string {
  if (actorId && sessionId) {
    return `/strategy/episodic/actor/${sanitizeId(actorId)}/session/${sanitizeId(sessionId)}`;
  }
  if (actorId) {
    return `/strategy/episodic/actor/${sanitizeId(actorId)}`;
  }
  return "/strategy/episodic";
}
```

AgentCore 的 EPISODIC 策略：
- 自动从对话中提取结构化经验
- `reflectionConfiguration` 启用跨会话反思（来源: `README.md:72`）
- Agent 可通过 `agentcore_episodes` 工具搜索过去的经验和学习模式

### 6.6 跨命名空间共享工具

`agentcore_share`（来源: `src/tools/share.ts:8-9`）实现一次写入多个命名空间：

```typescript
// 对每个目标命名空间分别创建记录
for (const namespace of targetNamespaces) {
  const result = await client.batchCreateRecords([{
    content,
    namespaces: [namespace],
    metadata: { category, importance, source: "shared", sharedAt: ... },
  }]);
}
```

这使得一条记忆可以同时出现在多个 Agent 的 auto-recall 结果中。

---

## 附录：来源文件索引

| 文件 | 用途 | 本文引用章节 |
|------|------|-------------|
| `src/index.ts` | 插件注册、hooks、CLI | 4, 5.1, 5.2, 5.3 |
| `src/client.ts` | AWS SDK 调用 | 5.4 |
| `src/scopes.ts` | 命名空间映射与访问控制 | 6.1, 6.2, 6.5 |
| `src/config.ts` | 配置解析 | 5.3 |
| `src/file-sync.ts` | 文件同步 | 5.5 |
| `src/tools/recall.ts` | 语义搜索工具 | 5.2 |
| `src/tools/store.ts` | 存储工具 | 5.2 |
| `src/tools/forget.ts` | 删除工具 | 5.2 |
| `src/tools/correct.ts` | 更正工具 | 5.2 |
| `src/tools/search.ts` | 列表/过滤工具 | 5.2 |
| `src/tools/episodes.ts` | 情境记忆工具 | 5.2, 6.5 |
| `src/tools/share.ts` | 跨命名空间共享工具 | 5.2, 6.6 |
| `src/tools/stats.ts` | 统计工具 | 5.2 |
| `README.md` | 项目说明 | 3, 4.3, 6.4 |
| `skills/agentcore-memory-guide/SKILL.md` | 使用指南 | 5.2 |
| OpenClaw memory 文档 | 内置 memory 文档（"Memory files" / "Vector memory search" / "Additional memory paths" 等节） | 2, 3, 4.2, 4.3 |
| OpenClaw 插件文档 | 插件系统文档（"Plugin slots" / "Bundled plugins" / "Context engine plugins" 等节） | 2, 5.1 |
| OpenClaw agent loop 文档 | Agent 运行时生命周期文档 | 4 |
| OpenClaw 上下文文档 | Context Engine 概念（"How it works" / "System prompt addition" 等节） | 2 |
| lossless-claw `architecture.md` | DAG 摘要架构 | 4.1, 4.2, 4.3 |
| lossless-claw `agent-tools.md` | Agent 工具文档 | 4.1, 4.2, 4.3 |
