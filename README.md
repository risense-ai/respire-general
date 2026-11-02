# respire-general

> 一个插件，任何 agent 都能用——[Agent Plugins 1.0.0](https://agent-plugins.org) 格式的 respire 本地加密记忆。

`respire-general` 是 respire（命令名 `rsrs`）的**通用接入包**：只使用 Agent Plugins 规范标准化的两类组件——
**Agent Skill** 与 **MCP server**——不带任何宿主私有清单、私有占位符或 hook 假设。任何支持该协议的客户端
（Claude Code、Codex、MiniMax Code、Qoder 等）都能发现并加载它。

插件本身不含引擎；引擎是 [`@rsrsai/cli`](https://www.npmjs.com/package/@rsrsai/cli)。数据本地加密、
端侧优先、云端 LWW 同步；不装端侧模型也完全可用。

## 为什么是“通用”

Agent Plugins v1 只定义两个可移植组件：

| 组件 | 固定位置 | 本插件提供 |
| --- | --- | --- |
| Skills | `skills/<name>/SKILL.md` | `skills/respire/SKILL.md`：完整的记忆操作法 |
| MCP servers | `mcp.json` | `rsrs mcp`：全套记忆工具的 stdio MCP server（通常 14–16 个） |

`hooks`、`commands`、`agents` 在 v1 里都**不是**可移植能力。需要自动召回/自动落库的客户端，走各自的
扩展命名空间；本仓的 [`respire-minimax-code`](../respire-minimax-code) 就是由本包生成的第一个客户端适配。

## 安装

### 1. 引擎

```bash
npm i -g @rsrsai/cli@latest
rsrs --version
```

无全局写权限时先试：

```bash
npm config set prefix ~/.npm-global
npm i -g @rsrsai/cli@latest
```

### 2. 插件

不同客户端的本地插件目录不同，把**整个 `respire-general` 目录**放进客户端要求的插件根即可：

```bash
# MiniMax Code：先找到当前 profile 的 local 目录，再把整个目录作为直接子目录拷入
mcode plugin marketplace list

# Qoder：按目录安装
qoder plugins install /abs/path/respire-general

# 其他客户端：按其文档把整个目录放进本地插件根，再重启会话
```

没有安装命令的客户端，直接复制目录到其插件目录（通常是 `~/.<client>/plugins/<name>/`），再重启会话。
客户端只要求根 `plugin.json` 与固定位置组件，不需要任何安装脚本。

### 3. 登录（首次）

去 [rsrs.rs](https://rsrs.rs) 注册 → 本机 `rsrs register`。日常 `rsrs login`；
`rsrs sync` 手动同步（autosync 常开），`rsrs status` 查态。

## 装上后得到什么

### Skill：`respire`

回答前先翻忆、收尾把新事实落库；含判后即存、标题写法、召回补查、CLI 信封解析与安全红线。
由模型按需加载，不占常驻上下文。

### MCP：`respire`

`mcp.json` 先启动一个极薄的 stdio 桥 `mcp/respire-mcp.mjs`，由它解析引擎（包括 Windows 的 `.cmd` shim），再把 stdin/stdout 原样交给 `rsrs mcp`。桥不做 JSON-RPC 解析或缓冲，协议字节不变。

`rsrs mcp` 通过 stdio 暴露全套记忆工具（通常 14–16 个，随引擎版本）：

| 工具 | 用途 |
| --- | --- |
| `memory_status` | 库就绪、登录态、条目数 |
| `memory_recall` | 语义＋词面融合召回 |
| `memory_show` | 读一条全文 |
| `memory_remember` | 判后即存；支持 `parent` / `supersedes` / `see_also` / `force` / `merge_ids` |
| `memory_update` | 改标题/正文/标签/类型/重要度 |
| `memory_list` / `memory_diary` | 近期条目 / 日记时间链 |
| `memory_chain` / `memory_tree` | 因果链 / 因果树 |
| `memory_history` | 变更审计 |
| `memory_query_log_mark` | 召回候选自评 |
| `memory_attach` | 显式改挂靠 |
| `memory_forget` / `memory_restore` | 墓碑删除 / 恢复（默认不开放） |

权限用 `RSRS_MCP_ALLOW` / `RSRS_MCP_DENY` 控制，规则见引擎文档 `respire-cli/docs/mcp-permissions.md`。

## 生成 MiniMax Code 适配包

`respire-general` 是单一事实源。改完通用部分后：

```bash
node scripts/build-minimax.mjs          # 生成 ../respire-minimax-code
node scripts/build-minimax.mjs --check  # CI：确认生成物没有漂移
```

生成器复用通用包的技能与 MCP 配置，产出 **MiniMax Plugin V1 官方格式**（mcode 0.4.0+，不含根 `plugin.json`）：

```text
respire-minimax-code/
├── .minimax-plugin/plugin.json           # 官方 V1 清单（icon/category/mcpServers/skills/hooks）
├── icon.png
├── respire.mcp.json                      # V1 MCP 文件：node ./mcp/respire-mcp.mjs
├── hooks/respire-hooks.json              # 官方 hook 文档
├── hooks/scripts/respire-hook.mjs
├── mcp/respire-mcp.mjs                   # stdio 桥（解析引擎后交给 rsrs mcp）
└── skills/respire/SKILL.md
```

**为什么不发双布局**：mcode 本地读取器优先尝试根 `plugin.json`（便携 Agent Plugins），而便携读取器固定
返回 `hooks: []`。两者同时存在时，0.4+ 会加载便携布局并静默忽略 hooks。因此 0.4+ 专用包只保留
`.minimax-plugin` V1。代价是不支持 0.3.x；需要 0.3 时用通用包（无自动 hooks）。

V1 就是官方 Marketplace 的包格式；社区 Registry 的校验器仍要求根 `plugin.json`，更适合提交
`respire-general`。V1 包在 mcode 0.6.12 上已实测：`LOCAL_MINIMAX` 识别、MCP 连接、三个 hook 全部执行。

## 验证

```bash
node scripts/validate.mjs                 # 校验本包（协议 + 技能 + MCP + 路径 + 敏感扫描）
node scripts/validate.mjs ../respire-minimax-code
node tests/run.mjs                        # 生成一致性 + hook 行为测试（不需要真引擎）
node tests/run.mjs --check                # 只校验生成物是否最新
```

`tests/run.mjs` 用假 `rsrs` 覆盖：SessionStart 三态、登录/空库/缺模型分支、`记：` 落库、
pending 候选、`store_force`、语义召回与词面兜底、`/nomem`、引擎缺失、Stop 阻塞与
`stop_hook_active` 防循环、坏输入 fail-open，以及 MCP stdio 桥的启动与透传。

## 配置（仅客户端 hook 适配层使用）

通用包不需要记忆参数配置：技能无状态，MCP 桥只读取引擎路径。hook 适配层读取：

1. `RESPITE_CONFIG`
2. `$PLUGIN_DATA/respire.config.json`
3. `$PLUGIN_ROOT/respire.config.json`

字段与默认值见 `adapters/minimax-code/README.md`（生成包内也有完整表格）。

## 设计要点

- **协议内只做协议事**：根清单严格 closed schema，不含 `skills` / `hooks` / `mcpServers` 等私有字段。
- **能力双通道**：MCP 给工具，Skill 给方法；没有 hook 的客户端也能完整使用。
- **引擎优先**：插件不打包引擎，不写安装脚本；缺引擎时由 agent 代跑 npm 安装。
- **降级是一等公民**：未登录只提示一次；空库给首日存料引导；缺模型只说明可选增强。
- **可验证**：零依赖校验器 + 假引擎行为测试 + 生成物漂移检查。

## 已知边界

- **MCP 需要 `node`**：`mcp.json` 用 `node mcp/respire-mcp.mjs` 启动；桥自己解析 `rsrs`（含 Windows `.cmd` shim），所以不依赖宿主如何解析裸命令。`node` 缺失时 MCP 起不来（rsrs 本身也是 Node CLI）。
- **不同客户端的 MCP 启动环境不同**：若客户端清洗了 `PATH`，可在 MCP 配置里给桥加 `env.RESPITE_BIN` 指向引擎绝对路径（本包 `mcp.json` 保持可移植，不写死路径）。
- **hook 适配不是协议的一部分**：只有实现了 MiniMax 扩展的客户端会自动召回/落库；其他客户端由模型按 Skill 主动调用 MCP 或 CLI。
- 本包未在全部 Agent Plugins 客户端上做真机加载验证；格式以 [规范 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md) 为准。

## 数据与网络

- 记忆正文保存在本机 `~/.rsrs`（加密）；只有登录并同步时才访问 `api.rsrs.rs`。
- 插件不收集遥测，不访问第三方服务；技能、hook 与 MCP 桥只调用本机 `rsrs`。
- 引擎安装/更新由 npm 完成，插件本身不下载二进制。

## License

MIT
