# MiniMax Code adapter

这是 `respire-general` 的客户端扩展层，用来生成 [`respire-minimax-code`](../../../respire-minimax-code)。
它只做一件事：把 MiniMax Code 的三类生命周期事件翻译成 respire 的四条动作（注入简则 / 自动召回 /
显式落库 / 存储检查）。

## 为什么需要适配层

Agent Plugins 1.0 只标准化 **skills + MCP**；hooks 属于客户端私有能力。MiniMax Code 的 hook 契约有
三个硬约束，通用层无法表达：

1. 一个 handler 的 `timeout` 只能是 **1–10 秒**的整数，超过会被静默跳过；
2. `Stop` 用 Claude 兼容的 `{"decision":"block","reason":…}` 让模型再跑一轮；
3. Windows 上 npm 的 `rsrs.cmd` 不能直接 `spawn`（需要 cmd.exe 重新解析参数），适配层改为解析
   shim 里的 `cli.js`，用当前 Node 直接执行，避免 prompt 文本进入 cmd.exe 解析器。

## 事件映射

| mcode 事件 | 适配层动作 | 输出通道 |
| --- | --- | --- |
| `SessionStart` | 注入记忆简则；一次 `rsrs status` 探测登录/库量/模型三态 | 纯文本 → `additionalContext` |
| `UserPromptSubmit` | `记：` 前缀落库；否则 `rsrs recall --titles` 标题档召回 | 纯文本 → `additionalContext` |
| `Stop` | 若本轮可能产生新事实，催一次存储 | `{"decision":"block","reason":…}` → 续跑一轮 |

`/nomem` 前缀跳过召回；`$skill: 名称` 前缀在召回前剥除；`stop_hook_active=true` 时 Stop 直接放行，
避免无限循环。

## 超时预算

| 子进程 | 上限 | 说明 |
| --- | --- | --- |
| `rsrs recall` | 4.5s | 语义召回单次预算；超时转词面兜底 |
| `rsrs diary --contains` | 整体 9s | 最多 3 个关键词，每个 ≤2.5s；只取 important |
| `rsrs remember` | 9s | 判后即存；超时回执提示手动核实/补存 |
| `rsrs status` | 6s | SessionStart 一次性探测，避免拖慢开会话 |

整个 hook 进程必须 < 10s，因此不做任何重试；所有异常 → 空 stdout + `exit 0`。

## 配置

优先级：

1. `RESPITE_CONFIG`
2. `$PLUGIN_DATA/respire.config.json`
3. `$PLUGIN_ROOT/io.minimax.mcode/respire.config.json`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `rsrs` | `""` | 引擎路径；空 = 自动探测（`RESPITE_BIN` → PATH → 常见安装目录） |
| `recall_threshold` | `0` | 召回下限；0=直出 |
| `recall_limit` | `5` | 取前 N 条 |
| `min_prompt_chars` | `2` | 过短不检索 |
| `session_rules` | `true` | 是否注入 SessionStart 简则 |
| `budget_chars` | `1500` | 单轮注入总预算 |
| `enabled` | `true` | 总开关 |
| `store_nudge_every` | `1` | Stop 节流：1=每轮、N=每 N 轮、0=关 |
| `store_force` | `false` | `记：` 落库时加 `--force`（跳过判重，慢库上更可靠；会失去候选合并提示） |
| `semantic_timeout_ms` | `4500` | 语义召回单次预算；超时后走词面兜底 |
| `lexical_fallback` | `true` | 语义超时/失败时用 `rsrs diary --contains` 词面兜底（只用 important 条） |
| `log` | `true` | `$PLUGIN_DATA/hook.log` 留痕 |
| `skip_prefixes` | `[]` | 宿主内部提示白名单 |

环境变量：`RESPITE_BIN`、`RESPITE_RSRS`、`RESPITE_LOG`、`RESPITE_NUDGE_STATE`、`RESPITE_DATA`。

## 引擎路径解析（Windows）

npm/pnpm 全局安装的 `rsrs` 是 `.cmd` shim。适配层按顺序：

1. 读取 shim，找到其中真实的 `.../cli.js`，用 `process.execPath` 启动；
2. 找不到就 fail-open（不尝试 `cmd.exe` 拼接参数，避免注入与转义问题）。

POSIX 上直接执行 `rsrs` 本身（shebang 或可执行文件）。

## 测试

`respire-general/tests/run.mjs` 会造一个假 `rsrs` shim（Windows 为 `.cmd` + `cli.js`，POSIX 为
shebang 脚本），覆盖所有分支，不需要真实记忆库，也不会写用户数据。
