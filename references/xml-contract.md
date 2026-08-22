# XML 契约

结果是 XML，默认写入文件；stdout 只回 `<yce-receipt>` 小收据。不要只看 `<success>`。

## 收据 `<yce-receipt>`（stdout，schema `yce-receipt/1`）

小到主机不会截断，因此它本身可以信任。字段：

| 字段 | 含义 |
|------|------|
| `ok` / `exit_code` | 与 CLI 退出码一致：`0` 放行 / `2` 不完整 / `3` 无主结果 |
| `gate` | `may_analyze_or_edit_code` / `may_use_network_facts` / `may_present_plan` |
| `result_file` | 完整 XML 的绝对路径，细节只能从这里读 |
| `xml_bytes` / `xml_sha256` | 正文字节数与摘要，与文件尾部哨兵一致 |
| `errors` / `reasons` | 收据里的 message 可能被截短，全文在 `result_file` |
| `task_context` | 任务锚点摘要 |

## 尾部哨兵

落盘文件最后一行固定为：

```
<!-- yce:eof v=1 bytes=<正文字节数> sha256=<正文 sha256> -->
```

`bytes` / `sha256` 覆盖哨兵行之前的正文（不含分隔换行）。没读到这一行就是没读完。校验脚本会重算并比对，因此中间被省略、被改写（含等长改写）、读到半写文件都会判 `integrity: "mismatch"`。

哨兵只有满足两个条件才被信任：**全文只出现一次**，且**其后只有空白**。原因是结果正文可以合法地引用哨兵——检索本仓库就会命中 `resultGate.js`。不满足时降级为 `unverified`（`sentinel_ambiguous: true`）而不是判文件损坏，完整性交给标签配对判断。

因此：**读到的哨兵若不在文件末尾，它是正文内容，不是结尾。**

## 收据作为外部真相

哨兵是文件内的自证，理论上一份"被截到某个内嵌哨兵处"的文件可以自洽。收据不经过结果内容，所以它是唯一无法被正文伪造的来源。复核重要结果时把收据值带上：

```bash
node ./scripts/validate-yce-result.mjs <file> --expect-sha256 <xml_sha256> --expect-bytes <xml_bytes>
```

`--expect-sha256` 优先于哨兵：不符即 `mismatch` + exit 2；相符即 `verified`，即使哨兵缺失或有歧义。参数格式错误按用法错误 exit 1，不会静默放行。

`--out <file|dir>` 指定落盘位置，`YCE_RESULT_DIR` 改默认目录（缺省在系统临时目录 `yce-results/`，超过 3 天自动清理）。`--stdout-xml` 回到旧的 stdout 管道行为，此时没有哨兵保护。

| 标签 / 属性 | 含义 |
|------------|------|
| `<success>` | 任一侧产出可用结果即为 true；**不能**代替 result-present |
| `<mode>` | 传入模式 |
| `<resolved-action>` | 实际动作：`enhance` / `search` / `enhance_then_search` / `network_search` / `*_with_network` / `plan` / `search_then_plan` / … |
| `<enhanced executed success>` | 增强块；读 `<prompt>`、`<backend>`（`relay`/`local`）、`<runtime>`、`<recommended-skills>`、`<task-plan>` |
| `<search result-present>` | 代码定位主结果在 `<result>`。`empty-result="true"` 时 success 仍可能为 true |
| `<network-search result-present>` | 外部事实；evidence / summaries。不要把 URL 当仓库路径 |
| `<y-plan result-present>` | 规划正文在 `<plan>`。另有 `<backend>`、`<runtime>`、`<run-dir>`。只呈现，不自行执行 |
| `<task-context present created-now>` | 任务锚点复述 |
| `<errors>` | 即使 success=true 也要看。`EMPTY_RESULT` 表示跑完但没搜到 |

## 校验 JSON 与闸门

`validate-yce-result.mjs` 用的是与 CLI 相同的实现（`scripts/lib/resultGate.js`），所以收据和事后复核不会互相矛盾。输出：

- `ok` / `complete` / `integrity` / `truncation_detected` / `resolved_action` / `errors`
- `search.result_present` / `network.result_present` / `plan.result_present`
- `gate.may_analyze_or_edit_code`：仅当 XML 完整且 search result-present=true
- 退出码 `0` 通过；`2` 未读完；`3` 无主结果

`integrity` 三态：`verified`（哨兵或收据值重算一致）、`mismatch`（字节数或摘要不符）、`unverified`（无可信哨兵且未提供收据值，例如 `--stdout-xml` 或正文引用了哨兵）。

完整性判定按四层叠加，任一层不过即 exit 2：

0. **收据值**（`--expect-sha256` / `--expect-bytes`，可选）：唯一不来自文件的真相，优先级最高。
1. **哨兵**：重算 `bytes` / `sha256`，要求唯一且在文件末尾。能发现"中段被省略但首尾都在"。
2. **标签配对**：扫描 CDATA / 注释之外的标签栈，属性值里的 `>` 已按引号处理。首尾都在、中段丢失时栈必然不平衡，因此**即使一个截断标记都没留下**也能抓到。
3. **截断标记**：`truncated` / `token limit` 等字样，扫 `<yce>` 外侧以及 root 内 CDATA 之外。引擎结果里的 `(lines truncated)` / `(tree truncated)` 在 CDATA 内，不算主机截断。

结果正文永远在 `</yce>` 之前，所以"截断到正文中某个内嵌哨兵处"必然丢掉根闭合标签，会被第 2 层抓到。

## `--help` 与参数错误

`--help` 和参数错误仍直接打 stdout（内容很短，不存在截断风险），不落盘、不出收据。`--help` 是 XML、强制 pretty、exit 0，但 payload 是帮助结构：空 mode、空 resolved-action、`INVALID_ARGS`。不要当成检索成功。

手工调用 `vendor/yce-engine/yce-engine.mjs` 或 `scripts/prompt-enhance.js` **不会**返回 YCE XML。
