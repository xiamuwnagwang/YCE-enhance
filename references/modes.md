# 模式与参数

`scripts/lib/orchestrator.js` 的 `resolveAction(mode, query)` 按优先级选择初始动作：

```text
mode=enhance                         → enhance
mode=search                          → search
mode=network                         → network_search
mode=plan                            → plan（--with-search 时为 search_then_plan）
命中"模糊标记"                      → enhance_then_search
命中"增强意图"                      → enhance_then_search
其他情况（含仅命中检索意图）        → search
```

联网是否执行（与初始动作独立，CLI 不做关键词猜测）：

```text
mode=network                         → 一定联网
--with-network                       → 一定联网（叠加在 enhance/search/auto 上）
其余（含普通 auto）                  → 不联网
```

## auto

- 只在提示词确实模糊（命中模糊标记）或用户显式表达增强意图时进入 `enhance_then_search`；已够明确则直接 `search`。
- 只要实际执行了增强，同一次 CLI 调用内一定继续 search：增强成功且 prompt 非空 → 用该 prompt；增强失败 / 超时 / 解析失败 / 无 prompt → 用调用前已转成英文的原始 query。
- 显式 `--mode enhance` 不会触发补偿 search。
- auto 增强默认 60s（`YCE_TIMEOUT_AUTO_ENHANCE_MS`）；显式 enhance 默认 300s（`YCE_TIMEOUT_ENHANCE_MS`）。
- 未配置 `YCE_RELAY_TOKEN` 时 auto 跳过 enhance 直接 search；显式 enhance 返回 `AUTH_ERROR`。

### 检索意图关键词

`搜索代码` `找文件` `定位实现` `在哪` `哪里` `函数` `类` `接口` `api` `组件` `模块` `provider` `route` `handler` `实现` `逻辑` `代码` `文件` `settings` `模型列表`

### 增强意图关键词

`优化提示词` `提示词增强` `增强` `改写` `整理需求` `润色` `补全上下文` `更好理解` `优化这个任务` `prompt`

### 模糊标记

`这个` `这里` `那块` `相关逻辑` `对应地方` `这块` `那个` `它` `帮我看看`

## plan

```text
plan                     → 直接规划
plan + --with-search     → 先在 --cwd 做代码检索，把 <search><result> 作为 search_context（≤30000 字符）
plan + --search-context  → 手工传入已有上下文（可与 --with-search 拼接）
plan + --with-network    → 额外客户端联网（与 Y-Plan 服务端 web search 独立）
```

Y-Plan 只规划不执行。默认超时 480s（`YCE_TIMEOUT_PLAN_MS`）。网页端 relay 只是一个调用方，不等于“只读取网页”：计划可以同时使用任务描述、会话历史、调用方传入的 `search_context` / 文件上下文、`--with-search` 产生的仓库代码上下文，以及显式启用的外部 web search。

模型后端二选一：

- `--plan-backend relay`（默认，也可写 `yce`）：规划模型走远端 YCE
- `--plan-backend local`（也可写 `cli`）：规划模型走本机 y-plan CLI / 自备模型

提示词增强同样二选一：`--enhance-backend relay|local`。

检索和联网始终走 YCE，不跟模型后端走。自备模型（`--plan-provider` / `YCE_YPLAN_*`）两种后端都能用：relay 送给远端 YCE，local 由本机 CLI 或直连 API 调用。走 local 时不需要单独配置增强 Key。

## 常用参数

| 参数 | 说明 |
|------|------|
| `<query>` | 用户问题；plan 下即任务描述 |
| `--mode <auto\|enhance\|search\|network\|plan>` | 默认 `YCE_DEFAULT_MODE`（仓内 `auto`） |
| `--with-network` | Agent 显式附加联网 |
| `--network-profile <quick\|balanced\|exhaustive>` | 默认 `balanced` |
| `--history` | 增强 / 规划强烈建议传 |
| `--cwd` | 不在目标项目目录时必须传 |
| `--with-search` / `--search-context` / `--save` | 仅 plan |
| `--plan-backend` / `--enhance-backend` | `relay`/`yce` 或 `local`/`cli`；默认读 `YCE_YPLAN_BACKEND` / `YCE_ENHANCE_BACKEND` |
| `--task` / `--no-task` | 任务锚点绑定 / 关闭 |
| `--out <file\|dir>` | 指定结果落盘位置；缺省写系统临时目录（见 `YCE_RESULT_DIR`） |
| `--stdout-xml` | 回到旧行为：完整 XML 打 stdout、不落盘、无哨兵保护，仅管道场景用 |
| `--xml-pretty` | 美化 stdout XML（落盘文件始终美化）。`--json-pretty` 只是旧别名，不会输出 JSON |
| `--no-search` | 只关闭增强阶段的外部搜索，**不会**阻止后续代码检索 |

超时默认：search 180s、network 120s、plan 480s、auto enhance 60s、explicit enhance 300s。

## 环境变量（摘要）

唯一公网密钥是 `YCE_RELAY_TOKEN`，服务根默认 `YCE_RELAY_URL=https://yce.aigy.de`。代码检索走仓内 `vendor/yce-engine`；增强走 `scripts/prompt-enhance.js`。不要把 `scripts/lib/*` 配成入口路径。

`YCE_ENABLE_PLAN` 控制是否开放 plan 能力，默认 `true`。设为 `false` 后，`--mode plan` 和 MCP `y_plan` 都不可用；安装脚本默认写入开启，可用 `bash install.sh --setup --no-plan` 或 `.\install.ps1 -Setup -NoPlan` 关闭。

`YCE_RESULT_DIR` 改结果落盘目录，缺省是系统临时目录下的 `yce-results/`，其中超过 3 天的 `yce-*.xml` 会在下次调用时自动清理。

规划/增强模型后端：`YCE_YPLAN_BACKEND`、`YCE_ENHANCE_BACKEND`（`relay` 或 `local`）。本地 CLI：`YCE_YPLAN_CLI`、`YCE_YPLAN_CONFIG`。自备模型：`YCE_ENHANCE_*` / `YCE_YPLAN_*`；relay 时需服务端放行，local 时由本机 CLI 或直连 API 使用，不再单独配增强 Key。
