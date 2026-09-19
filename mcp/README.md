# yce-mcp

stdio MCP server，把本仓的 YCE CLI（`scripts/yce.js`）包成 6 个工具。它只负责转发：每个工具都 `spawn` 一次 `scripts/yce.js`，不复制 `scripts/lib/orchestrator.js` 的分发逻辑，也不直连引擎。模式、参数表、闸门判据仍然只有 CLI 一个来源。

MCP 版本走自己的 `2.0` 序列：当前 `2.0.0`，与 skill 版本各自独立。

## 安装与启动

```bash
cd mcp
npm install          # 依赖只装在本子包，仓根没有 package.json
node src/index.mjs   # stdio server：stdout 是 JSON-RPC，诊断全在 stderr
```

MCP 客户端配置（本仓布局，服务器自己按包相对路径找到 `../scripts/yce.js`）：

```json
{
  "mcpServers": {
    "yce": {
      "command": "node",
      "args": ["/abs/path/to/YCE-enhance/mcp/src/index.mjs"],
      "env": { "YCE_RELAY_TOKEN": "…" }
    }
  }
}
```

CLI 路径解析顺序：① 包相对 `mcp/../scripts/yce.js`；② 环境变量 `YCE_MCP_SKILL_ROOT`（YCE skill 根目录）；③ 环境变量 `YCE_JS`（指向 `scripts/yce.js`）。包相对优先是故意的——环境里的 `YCE_JS` 常指向另一份部署副本，让它优先会导致你以为在跑这个仓、其实跑的是别处。启动时 stderr 会打印实际解析到的 `cli=` 与 `resolved-by=`，照它核对。三条都找不到时服务器直接启动失败并列出尝试过的路径，不静默降级。

`npx --yes yce-mcp@latest` 这种脱离仓库的调起方式，需要把 `YCE_MCP_SKILL_ROOT` 或 `YCE_JS` 指向一份真实的 YCE skill 目录；本子包不打包 `scripts/`，也不在包内复制 CLI。

环境变量：

| 变量 | 作用 |
|------|------|
| `YCE_MCP_SKILL_ROOT` | YCE skill 根目录（内含 `scripts/yce.js`），包相对找不到时用 |
| `YCE_JS` | 直接指向 `scripts/yce.js`，优先级最低 |
| `YCE_MCP_SPAWN_TIMEOUT_MS` | 子进程硬上限，默认 30 分钟。CLI 自己管分阶段超时（search/network ≥120s、plan ≥300s），这里只防挂死 |
| CLI 自己的变量 | `YCE_RELAY_TOKEN`、`YCE_RESULT_DIR` 等原样透传给子进程 |

## 工具表

| 工具 | 转发的 CLI 调用 | 返回值 |
|------|----------------|--------|
| `yce_search` | `--mode search`（`mode=auto` 时先增强再检索），可叠 `--with-network` | 收据 JSON + 人读提示 |
| `yce_enhance` | `--mode enhance` | 收据 JSON + 人读提示 |
| `yce_network_search` | `--mode network` | 收据 JSON + 人读提示 |
| `yce_plan` | `--mode plan` | 收据 JSON + 人读提示 |
| `yce_task` | `task show\|list\|check\|done\|new` | `<yce-task>` XML 原样透传 + 人读提示 |
| `yce_read_result` | 不起子进程，按行分页读 `result_file` | 分页元信息 + 正文片段 |

## 契约映射

MCP 没有退出码可以承载 `gate.may_analyze_or_edit_code`，所以：

- 前五个工具的 **第一个内容块是完整收据 JSON**（原样透传 CLI stdout 里 `<yce-receipt>` 的 JSON，含 `gate.*`、`result_file`、`xml_bytes`、`xml_sha256`、`errors`、`reasons`、`task_context`）；第二个内容块是人读提示，写明退出码含义、闸门取值、复核命令，以及「正文在 `result_file`，文件最后一行是 `yce:eof` 哨兵，中间出现的哨兵是被引用的内容不是结尾」。
- CLI 退出码非 0 时结果标 `isError`，闸门为假不会被悄悄当成成功。
- CLI 走回退路径（写结果文件失败直接把整份 XML 打到 stdout）、`--help` / `INVALID_ARGS` 这类裸 XML 输出，工具会明说「没有收据」并把原始 stdout 给出来，不伪造收据。
- `yce_task` 是**已知偏差**：CLI 的 `task` 分支在模式解析之前就 `console.log(...)` 退出，输出是 `<yce-task>` XML，根本不产生收据。这个工具原样透传，并在提示里说明它没有 `gate.*` / `result_file`，不为它合成收据形状的对象。
- `yce_read_result` 的完整性判据从 `scripts/lib/resultGate.js` 的 `parseSentinel` 复用（只读引入，不改那两个文件）：哨兵只有在全文唯一且后面除空白无内容时才算可信。末页最后一行就是真实的 `<!-- yce:eof v=… bytes=… sha256=… -->`；元信息块给 `total_lines` / `next_offset` / `has_more` / `eof_reached` / `last_line_is_sentinel`（本页末行形状是哨兵）/ `sentinel_trusted`（判据认可这枚哨兵）/ `eof_verified`（两者都成立才算读完）/ `sentinel` / `sentinel_ambiguous`。元信息放在正文前面，所以末页返回内容的最后一行一定落在哨兵上。
- 参数校验不静默：文件不存在、路径不是绝对路径、`offset` 越界或 `< 1`、`limit < 1`、`action=check` 没传 `stage`，都返回写明原因的错误。类型与枚举由 zod schema 挡在调用之前（`-32602 Input validation error`），数值范围仍交给 CLI 判（CLI 的参数表是唯一权威，这里不复制它的上下界）。

## 设计约束

- `scripts/lib/resultGate.js`、`scripts/lib/resultSink.js` 零改动。
- 不暴露 `--stdout-xml`：那会绕开「结果落盘 + 小收据」这条契约。也不提供 `extra_args` 之类的逃生口，否则 schema 校验形同虚设。
- 子进程一律 `spawn` + argv 数组 + piped stdio：路径带空格不会被拆开，子进程的 banner 不会污染 JSON-RPC 流。
