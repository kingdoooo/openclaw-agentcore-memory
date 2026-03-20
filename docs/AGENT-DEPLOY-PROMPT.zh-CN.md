# OpenClaw Agent 部署指南

将下方的消息发送给你的 OpenClaw agent，它会自动完成整个安装流程。Gateway 重启后，`agentcore-guide` skill 即可用于验证和使用指导。

将 `<REGION>` 替换为你的 AWS 区域（如 `us-west-2`）。

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

阶段 0：创建 AWS MEMORY 资源

先列出已有资源：
  aws bedrock-agentcore-control list-memories --region <REGION>

为本次 OpenClaw 部署创建一个全新的 Memory 资源。不要复用其他项目的 Memory 资源 — 不同项目的 strategies 和 namespaces 可能不兼容，数据会混在一起。注意：
- CLI 服务名是 "bedrock-agentcore-control"（控制面），不是 "bedrock-agentcore"
- --memory-strategies 使用 tagged union 格式，每个 strategy 是一个独立的 JSON 参数
- Summary 和 episodic 的 namespaces 必须包含 {sessionId}
- Episodic 必须有 reflectionConfiguration（reflection namespace 必须是 episodic namespace 的前缀）

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

编辑 ~/.openclaw/openclaw.json。必须合并到现有配置中，不要覆盖。

关键：所有路径必须是绝对路径。不要在配置值中使用 ~。Node.js 不会展开 ~。

使用以下 Python 脚本。将 MEMORY_ID_HERE 替换为阶段 0 的 memoryId，REGION_HERE 替换为 AWS 区域：

  MEMORY_ID="<粘贴阶段 0 的 memoryId>"
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
| 删除记忆（GDPR） | `agentcore_forget` | 先预览（confirm=false），再删除。支持 purge_scope 批量清除 |
| 跨 Agent 共享 | `agentcore_share` | 指定 target_scopes: ["agent:other-bot", "project:xxx"] |
| 搜索过往经验 | `agentcore_episodes` | 查找跨会话的模式和反思 |
| 检查状态 | `agentcore_stats` | 连接状态 + 策略分布（缓存 5 分钟） |

### 作用域（多 Agent）

**Namespace 层级**：
- `/global` — 所有 agent 共享，默认可读写。
- `/agents/<id>` — 每个 agent 的私有空间。Auto-recall 自动搜索此空间。
- `/projects/<id>` — 项目级共享空间。
- `/users/<id>` — 用户级空间。
- `/custom/<id>` — 自定义空间。

**scope 参数语法**：`"global"`, `"agent:sales-bot"`, `"project:ecommerce"`, `"user:kent"`

**跨 Agent 共享**：
- 写入其他 namespace：`agentcore_share` + target_scopes: ["agent:other-bot"]
- 读取其他 namespace：`agentcore_recall` / `agentcore_search` + scope: "agent:other-bot"
- Auto-recall 默认搜索范围：/global + 自己的 /agents/<id> + agentAccess 配置的额外 namespace

**访问控制**（openclaw.json → plugins.entries.memory-agentcore.config.scopes）：
```json
{
  "agentAccess": { "bot-a": ["agent:bot-b", "project:shared"] },
  "writeAccess": { "bot-a": ["project:shared"] }
}
```
以上配置下，bot-a 的 auto-recall 搜索范围：/global + /agents/bot-a + /agents/bot-b + /projects/shared。
AGENTS_EOF

阶段 4：重启

  openclaw gateway restart

连接会断开，这是正常的。

重启后 agentcore-guide skill 即可使用。告知用户：

> "插件已安装。重新连接后，发送 '运行 agentcore-guide 验证' 即可执行完整验证。"
````

---

## 安装后

Gateway 重启且插件加载后，`agentcore-guide` skill 负责后续一切：

- **验证**：`Run agentcore-guide Phase 1` — 运行 20 项测试（12 项基础 + 8 项新功能）
- **使用指南**：`Run agentcore-guide Phase 2` — 工具参考、共享记忆模式、配置说明

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

## 更新插件

```bash
cd ~/.openclaw/plugins/memory-agentcore
git pull
npm run build
openclaw gateway restart
```
