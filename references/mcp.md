# yce-mcp：stdio MCP server

把 YCE CLI 包成 MCP 工具，给只会走 MCP 的宿主用。协议正文仍是 `SKILL.md`：闸门、哨兵、读结果的规矩一条不变，MCP 只换了调用方式。子包在 `mcp/`，MCP 版本走自己的 `2.0` 序列（当前 `2.0.0`，与 skill 版本各自独立）。

## 安装

```bash
cd mcp
npm install            # 依赖只装在子包里；仓根没有 package.json
node src/index.mjs     # stdout 是 JSON-RPC，诊断在 stderr
```

客户端配置示例：

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

server 找 CLI 的顺序是「包相对 `mcp/../scripts/yce.js` → `YCE_MCP_SKILL_ROOT` → `YCE_JS`」，启动时 stderr 打印实际用的是哪一条。脱离仓库调起（例如 `npx --yes yce-mcp@latest`）必须自己把 `YCE_MCP_SKILL_ROOT` 或 `YCE_JS` 指向一份真实 skill 目录——子包不打包 `scripts/`，也不复制 CLI。子进程硬超时用 `YCE_MCP_SPAWN_TIMEOUT_MS`（默认 30 分钟），分阶段超时仍由 CLI 自己管。

## 工具表

| 工具 | 转发的 CLI 调用 | 关键参数 | 返回值 |
|------|----------------|----------|--------|
| `yce_search` | `--mode search`（`mode=auto` 先增强再检索） | `query`（必填，英文）、`cwd`、`mode`、`history`、`with_network`、`task`/`no_task`、检索调优项（`max_results`、`tree_depth`、`exclude`、`no_cache`…） | 收据 JSON + 人读提示 |
| `yce_enhance` | `--mode enhance` | `query`（必填）、`history`、`enhance_backend`、`language` | 收据 JSON + 人读提示 |
| `yce_network_search` | `--mode network` | `query`（必填）、`network_profile`、`library`、`repo` | 收据 JSON + 人读提示 |
| `yce_plan` | `--mode plan` | `query`（必填）、`cwd`、`with_search`、`search_context`、`plan_backend`、`plan_provider`/`plan_model`、`web_search`、`save` | 收据 JSON + 人读提示 |
| `yce_task` | `task show\|list\|check\|done\|new` | `action`（必填）、`task`、`stage`+`evidence`、`goal`+`accept` | `<yce-task>` XML 原样透传 + 人读提示 |
| `yce_read_result` | 不起子进程，直接分页读文件 | `result_file`（必填，绝对路径）、`offset`（默认 1）、`limit`（默认 400 行，单页另有 256 KiB 上限） | 分页元信息 + 正文片段 |

前五个工具一律 `spawn` 仓内 `scripts/yce.js`，不复制 `orchestrator.js` 的分发逻辑、不直连引擎；`--stdout-xml` 不暴露，也没有 `extra_args` 逃生口。

## 契约怎么映射

MCP 没有退出码承载 `gate.may_analyze_or_edit_code`，所以闸门改由返回值承载：

1. 第一个内容块是**完整收据 JSON**（CLI stdout 里 `<yce-receipt>` 的 JSON 原样透传，含 `gate.*`、`result_file`、`xml_bytes`、`xml_sha256`、`errors`、`reasons`、`task_context`）。
2. 第二个内容块是人读提示：退出码含义（0 放行 / 1 参数错 / 2 未读完 / 3 无主结果）、三个闸门取值、复核命令，以及「正文在 `result_file`，**文件最后一行**是 `<!-- yce:eof v=1 bytes=… sha256=… -->` 哨兵，文件中间出现的哨兵是结果正文引用的内容、不是结尾」。
3. CLI 退出码非 0 的结果标 `isError`，闸门为假不会被当成成功。
4. 没有 `<yce-receipt>` 块时（写结果文件失败的 stdout 回退、`--help`、`INVALID_ARGS`）明确说「这不是收据」并给出原始 stdout，不伪造。
5. `yce_task` 是**已知偏差**：CLI 的 `task` 分支在模式解析之前就返回，输出 `<yce-task>` XML，不产生收据。它原样透传，并写明没有 `gate.*` / `result_file`；不为它合成收据形状的对象。

## 读结果

`yce_read_result` 的元信息块放在正文**前面**，所以末页返回内容的最后一行一定落在真实哨兵上。元信息字段：`total_lines`、`offset`、`returned_lines`、`next_offset`、`has_more`、`eof_reached`、`last_line_is_sentinel`、`sentinel_trusted`、`eof_verified`、`sentinel`、`sentinel_ambiguous`、`page_byte_capped`。

三个哨兵字段分别是三件事，别混：`last_line_is_sentinel` 说本页返回的最后一行形状上就是哨兵行；`sentinel_trusted` 说这枚哨兵按 `scripts/lib/resultGate.js` 的 `parseSentinel` 判据可信（全文唯一，且后面除空白无内容）；`eof_verified` 两者都成立才为 true，只有它为 true 才算读完。判据是只读复用那个模块，`resultGate.js` 与 `resultSink.js` 零改动。

检索结果正文里引用了别处的哨兵时（例如搜到 `resultGate.js` 自己），文件会有多处哨兵：`sentinel_ambiguous=true`、`sentinel_trusted=false`，提示改用 `scripts/validate-yce-result.mjs` 带收据的 `--expect-sha256` / `--expect-bytes` 复核——收据不来自文件，能识破自洽的伪造。

参数错误一律明说，不静默：文件不存在（带路径与 errno）、路径不是绝对路径、`offset` 越界（告知可读范围）、`offset < 1`、`limit < 1`、`action=check` 少 `stage`。类型与枚举由 schema 在调用前挡下（`-32602 Input validation error`）；数值上下界仍由 CLI 判，避免和 CLI 参数表两处维护。
