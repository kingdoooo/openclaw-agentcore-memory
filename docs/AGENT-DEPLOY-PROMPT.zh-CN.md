# OpenClaw Agent 部署指南

将下方的消息发送给你的 OpenClaw agent，它会自动完成整个安装流程。Gateway 重启后，两个 skill 可用：`agentcore-memory-validation`（19 项自动化测试）和 `agentcore-memory-guide`（使用指南）。

将 `<REGION>` 替换为你的 AWS 区域（如 `us-west-2`）。

> **注意**：Memory 资源是区域性的。如果要加入其他区域的已有 Memory，`<REGION>` 必须是该 Memory 所在的区域，而非你的本地默认区域。

---

## 部署消息

````
帮我部署 memory-agentcore 插件。严格按照以下阶段执行。

前置检查：开始前验证所有前置条件，运行以下全部命令并报告失败项：

  aws sts get-caller-identity        # 必须成功 — 确认 AWS 凭证
  aws bedrock-agentcore-control list-memories --region <REGION> 2>&1 | head -5  # 不能出现 AccessDenied
  node --version                     # 需要 v18+
  npm --version                      # 必须已安装
  git --version                      # 必须已安装

如果 aws 命令出现 AccessDenied 或 UnrecognizedClientException，停止并告知用户需要配置 AWS 凭证，确保该区域已启用 bedrock-agentcore 权限。
如果 Node.js 未安装或版本低于 18，停止并告知用户需要升级。也可以询问用户是否需要代为安装。
如果 Git 未安装，停止并告知用户需要安装。也可以询问用户是否需要代为安装。

阶段 0：创建或加入 MEMORY 资源

跨 Agent 共享记忆只能在同一个 Memory ID 内实现。不同的 Memory ID 完全隔离，无法跨 Memory ID 共享。

重要：Memory 资源是区域性的。在 us-west-2 创建的 Memory 只能在 us-west-2 中
访问和使用。插件的 awsRegion 配置必须与 Memory 所在区域一致。

先列出已有资源：
  aws bedrock-agentcore-control list-memories --region <REGION>

询问用户："这是一个全新的独立 Agent，还是需要与现有 Agent 共享记忆？"

  选项 A：创建新 Memory（独立部署或组内首个 Agent）
    → 执行下方的 create-memory 命令，保存生成的 Memory ID。

  选项 B：加入已有 Memory（与其他 Agent 共享）
    → 向用户索要已有的 Memory ID 和它所在的区域。
    → 如果 Memory 的区域与 <REGION> 不同，后续所有命令都使用 Memory 的区域
      （相应更新 REGION）。
    → 策略模板是 Memory 级别的配置，不是 Agent 级别的。
      共享同一 Memory ID 的所有 Agent 自动使用相同的策略。
    → 跳过 create-memory，在阶段 2 直接使用该 Memory ID。
    → 验证已有 Memory：
      aws bedrock-agentcore-control get-memory --memory-id "<ID>" --region <MEMORY_REGION>
    → 如果用户不知道区域，提供以下扫描命令作为备选（不要默认执行）：
      for R in us-east-1 us-west-2 eu-west-1 eu-central-1 ap-northeast-1 ap-southeast-1; do
        echo "--- $R ---"
        aws bedrock-agentcore-control list-memories --region $R 2>/dev/null | grep -i memoryId || echo "(none)"
      done
    → 确认 Memory ID 和区域后直接跳到阶段 1。

--- 如果创建新 Memory 资源 ---

不要复用其他项目的 Memory 资源 — 不同项目的 strategies 和 namespaces 可能不兼容，数据会混在一起。注意：
- CLI 服务名是 "bedrock-agentcore-control"（控制面），不是 "bedrock-agentcore"
- --memory-strategies 使用 tagged union 格式，每个 strategy 是一个独立的 JSON 参数
- Summary 和 episodic 的 namespaces 必须包含 {sessionId}（AWS 对会话级策略的要求）
- Episodic 必须有 reflectionConfiguration（reflection namespace 必须是 episodic namespace 的前缀）
- Namespace 模板支持变量：{actorId}、{sessionId}、{memoryStrategyId}
- 根据 namespaceMode 配置选择以下两种方案之一

方案 A：按 Agent 隔离（namespaceMode: "per-agent"，默认）
每个 agent 的记忆存储在独立的 namespace 路径下。推荐用于多 agent 部署。

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

方案 B：共享 namespace（namespaceMode: "shared"）
所有 agent 共享相同的 namespace 路径。更简单但 agent 之间没有隔离。

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

如果参数格式报错，运行：aws bedrock-agentcore-control create-memory help

等待状态变为 ACTIVE：
  aws bedrock-agentcore-control get-memory --memory-id "<ID>" --region <REGION>

记下响应中的 memoryId — 阶段 2 会用到。memoryId 格式类似 "openclaw_memory-XXXXXXXXXX"。

阶段 1：安装插件

  PLUGIN_DIR="$HOME/.openclaw/plugins/memory-agentcore"
  mkdir -p "$HOME/.openclaw/plugins"
  git clone https://github.com/kingdoooo/openclaw-agentcore-memory.git "$PLUGIN_DIR"
  cd "$PLUGIN_DIR"
  npm install
  npm run build
  ls dist/index.js && echo "Build OK"

重要：npm run build 是必须的，插件加载的是 dist/ 下的编译产物。
如果 npm install 失败，检查 Node.js 版本（需要 v18+）和网络连通性。
如果 npm run build 失败，检查输出中的 TypeScript 错误。

阶段 2：配置

重要 — AGENT ID 检查（当多个 Agent 共享同一 Memory ID 时）：
共享 Memory ID 的每个 Agent 必须有唯一的 agent ID，在 openclaw.json 的 agents.list[].id 中设置。
如果没有设置唯一 ID，所有 Agent 默认使用 actorId "main"，记忆会意外合并。

检查当前 agents 列表：
  python3 -c "import json; cfg=json.load(open('$HOME/.openclaw/openclaw.json')); agents=cfg.get('agents',{}).get('list',[]); print(json.dumps([{'name':a.get('name','?'), 'id':a.get('id','(未设置, 默认为 main)')} for a in agents], indent=2) if agents else '未配置 agents（默认为 main）')"

如果未设置唯一 ID 且要加入已有 Memory：
  1. 向用户展示当前的 agents 列表。
  2. 询问需要为哪个 agent 设置 ID，以及使用什么 ID。
  3. 通过 openclaw config.patch 设置（保留注释和格式）：
     AGENT_INDEX=0   # agents.list[] 中的索引 — 询问用户是哪个
     AGENT_ID="<期望的唯一 agent ID>"
     openclaw config.patch "{\"agents\":{\"list\":{\"$AGENT_INDEX\":{\"id\":\"$AGENT_ID\"}}}}"

警告：不要设置 agents.defaults.id — OpenClaw 不支持此字段，Gateway 会拒绝该配置。
警告：不要盲目修改 agents.list[0] — 如果存在多个 agent，必须询问用户要更新哪个。

编辑 ~/.openclaw/openclaw.json。必须合并到现有配置中，不要覆盖。

关键：所有路径必须是绝对路径。不要在配置值中使用 ~。Node.js 不会展开 ~。

通过 openclaw config.patch 配置插件（保留注释和格式）：

  MEMORY_ID="<粘贴阶段 0 的 memoryId>"
  REGION="<REGION>"   # 必须是 Memory 所在的区域（新建时相同，加入时可能不同）
  PLUGIN_DIR="$(realpath $HOME/.openclaw/plugins/memory-agentcore)"

  # 添加插件到允许列表
  openclaw config.patch '{"plugins":{"allow":["memory-agentcore"]}}'

  # 设置插件加载路径
  openclaw config.patch "{\"plugins\":{\"load\":{\"paths\":[\"$PLUGIN_DIR\"]}}}"

  # 设置插件配置（memoryId、awsRegion）
  openclaw config.patch "{\"plugins\":{\"entries\":{\"memory-agentcore\":{\"enabled\":true,\"config\":{\"memoryId\":\"$MEMORY_ID\",\"awsRegion\":\"$REGION\"}}}}}"

验证配置是否正确写入：
  python3 -c "import json; cfg=json.load(open('$HOME/.openclaw/openclaw.json')); e=cfg['plugins']['entries']['memory-agentcore']; print(f'memoryId={e[\"config\"][\"memoryId\"]}'); print(f'path={cfg[\"plugins\"][\"load\"][\"paths\"][0]}'); assert not e['config']['memoryId'].startswith('<'), 'ERROR: memoryId still has placeholder!'; assert '~' not in cfg['plugins']['load']['paths'][0], 'ERROR: path contains ~!'"

警告：不要同时运行 "openclaw plugins install ." — install 和 load.paths 同时使用会导致 "duplicate plugin id" 错误。

阶段 3：更新 AGENTS.MD

将以下内容追加到 workspace 的 AGENTS.md 文件（通常在 ~/.openclaw/workspace/AGENTS.md）。不要覆盖已有内容，只追加：

cat >> "$(openclaw config get agents.defaults.workspace 2>/dev/null || echo "$HOME/.openclaw/workspace")/AGENTS.md" << 'AGENTS_EOF'

## AgentCore Memory（云端跨会话记忆）

你的记忆分为两层：
- **短期记忆**：会话内的原始对话事件（每轮自动捕获）
- **长期记忆**：跨会话持久化的提取洞察，按 4 个策略组织：
  - **Semantic**：事实和知识（"该 API 使用 OAuth 2.0"）
  - **User Preference**：用户偏好和风格（"用户偏好 Python 而非 Java"）
  - **Summary**：每会话滚动摘要
  - **Episodic**：结构化经验，含跨 episode 的反思和模式

### 工具

| 使用场景 | 工具 | 说明 |
|---------|------|------|
| 保存重要事实/决策 | `agentcore_store` | 直接写入长期记忆 |
| 查找相关记忆 | `agentcore_recall` | 语义搜索，新记录有 30-60 秒索引延迟 |
| 验证数据存在 / 浏览记录 | `agentcore_search` | 列表模式，无延迟。recall 为空时的回退方案 |
| 更新错误记忆 | `agentcore_correct` | 原地更新，瞬态错误自动重试 |
| 删除记忆 | `agentcore_forget` | 先预览（confirm=false），再删除。支持 purge_scope 批量清除 |
| 跨 Agent 共享 | `agentcore_share` | 指定 target_scopes: ["agent:other-bot", "project:xxx"] |
| 搜索过往经验 | `agentcore_episodes` | 查找跨会话的模式和反思 |
| 检查状态 | `agentcore_stats` | 连接状态 + 策略分布（缓存 5 分钟） |

### Namespace 架构

**两类 namespace**：

1. **主 namespace** — 用于手动工具（`agentcore_store`、`agentcore_share`）：
   - `/global` — 所有 agent 共享，手动 store 的默认目标。
   - `/agents/<id>` — Agent 专属空间。
   - `/projects/<id>`、`/users/<id>`、`/custom/<id>` — 作用域空间。

2. **策略 namespace** — 由 AWS 从 `createEvent` 自动提取填充：
   - `/semantic/<id>` — 事实和知识（跨会话）
   - `/preferences/<id>` — 用户偏好（跨会话）
   - `/summary/<id>/<sessionId>` — 每会话摘要（会话级）
   - `/episodic/<id>/<sessionId>` — 每会话 episode（会话级）
   - `/episodic/<id>` — Episodic 反思（跨会话）

**Auto-recall 搜索范围**：`/global`、`/agents/<id>`、自身所有策略 namespace、当前会话的 summary/episodic，以及所有授权 agent 的策略 namespace。

**scope 参数语法**：`"global"`, `"agent:sales-bot"`, `"project:ecommerce"`, `"user:kent"`

**跨 Agent 共享**：
- 写入其他 namespace：`agentcore_share` + target_scopes: ["agent:other-bot"]
- 读取其他 namespace：`agentcore_recall` / `agentcore_search` + scope: "agent:other-bot"
- Auto-recall 自动包含授权 agent：配置下方的 `agentAccess`

**访问控制**（openclaw.json → plugins.entries.memory-agentcore.config.scopes）：
```json
{
  "agentAccess": { "bot-a": ["agent:bot-b", "project:shared"] },
  "writeAccess": { "bot-a": ["project:shared"] }
}
```
以上配置下，bot-a 的 auto-recall 搜索自身所有 namespace + bot-b 的策略 namespace + /projects/shared。

**重要**：共享 Memory ID 时，Agent ID（agents.list[].id）必须唯一。未设置时所有 Agent 默认为 "main"。
AGENTS_EOF

阶段 4：重启

  openclaw gateway restart

连接会断开，这是正常的。

重启后 agentcore-memory-validation skill 即可使用。告知用户：

> "插件已安装。重新连接后，发送 '运行 agentcore-memory-validation' 即可执行完整验证。"
````

---

## 安装后

Gateway 重启且插件加载后：

- **验证**：`运行 agentcore-memory-validation` — 19 项自动化测试，无需重启
- **使用指南**：`运行 agentcore-memory-guide` — 工具参考、共享记忆、配置、最佳实践

---

## 故障排查（安装相关）

| 问题 | 原因 | 解决方法 |
|------|------|---------|
| `plugins.load failed` | 配置路径中使用了 `~` | 使用绝对路径（shell 中 `$HOME` 会展开，Node.js 中 `~` 不会） |
| `duplicate plugin id` | 同时使用了 `install` 和 `load.paths` | 删除 `~/.openclaw/extensions/memory-agentcore/` |
| `text.trim is not a function` | 插件版本过旧 | `git pull && npm run build && openclaw gateway restart` |
| `Connection: FAILED` | 凭证错误或 memoryId 错误 | `aws sts get-caller-identity` + 检查配置中的 memoryId |
| `npm run build` 失败 | Node.js < v18 | 升级到 Node.js v18+ |
| 配置占位符未替换 | 配置中仍是 `<MEMORY_ID>` | 用实际的 memoryId 重新运行阶段 2 |
| `AccessDeniedException` | 缺少 IAM 权限 | 确认该区域已启用 bedrock-agentcore |
| 加入后 `Connection: FAILED` | Memory 在其他区域 | 用 `get-memory --region <正确区域>` 验证，更新配置中的 `awsRegion` |

## 更新插件

```bash
cd ~/.openclaw/plugins/memory-agentcore
git pull
npm run build
openclaw gateway restart
```
