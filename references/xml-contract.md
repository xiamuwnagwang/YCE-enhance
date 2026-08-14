# XML 契约

YCE stdout 固定是 XML，不再输出 JSON。消费前必须跑 `scripts/validate-yce-result.mjs`，不要只看 `<success>`。

| 标签 / 属性 | 含义 |
|------------|------|
| `<success>` | 任一侧产出可用结果即为 true；**不能**代替 result-present |
| `<mode>` | 传入模式 |
| `<resolved-action>` | 实际动作：`enhance` / `search` / `enhance_then_search` / `network_search` / `*_with_network` / `plan` / `search_then_plan` / … |
| `<enhanced executed success>` | 增强块；读 `<prompt>`、`<recommended-skills>`、`<task-plan>` |
| `<search result-present>` | 代码定位主结果在 `<result>`。`empty-result="true"` 时 success 仍可能为 true |
| `<network-search result-present>` | 外部事实；evidence / summaries。不要把 URL 当仓库路径 |
| `<y-plan result-present>` | 规划正文在 `<plan>`。只呈现，不自行执行 |
| `<task-context present created-now>` | 任务锚点复述 |
| `<errors>` | 即使 success=true 也要看。`EMPTY_RESULT` 表示跑完但没搜到 |

## 校验 JSON 与闸门

`validate-yce-result.mjs` 输出：

- `ok` / `complete` / `truncation_detected` / `resolved_action` / `errors`
- `search.result_present` / `network.result_present` / `plan.result_present`
- `gate.may_analyze_or_edit_code`：仅当 XML 完整且 search result-present=true
- 退出码 `0` 通过；`2` 未读完；`3` 无主结果

终端出现 `truncated`、`token limit` 或不完整 XML 时，`complete` 必为 false。不得声称已读取或检索完成。主机截断标记只认 `<yce>` 文档外侧；CDATA 内的 `token limit` / `[truncated]` / `(lines truncated)` 不算截断。MCP 的 `<yce-consume>` 带 `xml_bytes`，与收到 XML 字节数不一致视为未读完。

## `--help`

仍是 XML、强制 pretty、exit 0，但 payload 是帮助结构：空 mode、空 resolved-action、`INVALID_ARGS`。不要当成检索成功。

手工调用 `vendor/yce-engine/yce-engine.mjs` 或 `scripts/prompt-enhance.js` **不会**返回 YCE XML。
