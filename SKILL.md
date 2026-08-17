---
name: yce
version: 3.3.0
description: |
  当任务既需要把模糊需求说清楚，又需要去代码库里把实现找出来时使用。适用于"帮我看看这块逻辑在哪""优化任务后再搜代码""增强后检索""auto search""YCE"等场景。
  需要当前外部信息、官方库文档、竞品/行业调研时用 `--mode network` 或 `--with-network`。
  只要规划不要执行时用 `--mode plan` / Y-Plan。
  代码任务必须先 yce 检索：CLI 退出码 0 且收据 gate.may_analyze_or_edit_code=true 才能改代码。结果在 result_file 里，不在终端；没读到文件末尾的 yce:eof 哨兵就不算读完。
user-invocable: true
---

# YCE Skill

本文件是唯一执行协议。参数表、XML 示例、错误码与排障见 `references/`，不要在本文件重复。

## 不可违反的主流程

1. 确认目标项目绝对路径，不在该目录时必须传 `--cwd`。
2. 凡最终会进入 search 的调用，先把自然语言检索意图转成准确、简洁的英文 query。代码标识符、路径、命令、报错原文和字符串字面量保持不变。YCE 不会自动翻译。
3. 按下表选择 **一种** 模式，发起 **一次** YCE 调用，外层阻塞等待完成（search/auto/network ≥ 120s，plan ≥ 300s）。禁止短 timeout 轮询。
4. 直接调用即可。结果自动落盘，stdout 只回一份小收据，**不要**再自己重定向 stdout：

```bash
node ./scripts/yce.js "<english query>" --mode search --cwd "/absolute/path/to/project"
```

5. **退出码就是闸门**，不需要额外一步校验：
   - `0` = 完整且拿到主结果，按收据 `gate` 继续
   - `2` = 输出不完整，重跑，不得使用
   - `3` = 完整但无主结果，先看 `errors` 排障，不要改代码
6. 读收据 `<yce-receipt>` 的 `gate`、`result_file`、`xml_bytes`、`errors`、`reasons`、`task_context`。**只有** `gate.may_analyze_or_edit_code === true`（即 `<search result-present="true">`）才能分析或修改代码。`success=true` 不能代替 `result-present=true`。
7. 需要结果细节时 `Read` 收据里的 `result_file`（可分段读）。**文件最后一行**是 `<!-- yce:eof v=1 bytes=… sha256=… -->`；没读到这一行就是没读完，不得声称已读完。读到的哨兵若不在文件末尾，那是结果正文引用的文本，不是结尾。复核时把收据里的值带上（收据不来自文件，能识破自洽的伪造）：

```bash
node ./scripts/validate-yce-result.mjs "<result_file>" --expect-sha256 <xml_sha256> --expect-bytes <xml_bytes>
```

8. 出现 `truncated`、`token limit`、`integrity` 不是 `verified`、退出码 `2` 时：**不得声明读取或检索完成**，重读文件或重跑 YCE。引擎结果内部的 `(lines truncated)` / `(tree truncated)` 不算主机截断；以退出码为准。

## 模式决策（唯一权威）

| 条件 | 动作 |
|------|------|
| 明确代码定位 | `search` |
| 需求模糊且需要定位 | `auto` |
| 需要外部资料 | `network`；若同时要定位代码则 `search`/`auto` + `--with-network` |
| 只要规划、不要执行 | `plan`；要贴代码则 `plan --with-search --cwd <项目>` |
| `auto` 增强失败 | 同一次调用仍必须用**原始英文 query** 搜索；不得停在增强错误上 |

补充（不另开规则）：
- `auto` 只在提示词模糊或用户明确要增强时才 enhance；已够具体则直接 search。无 `YCE_RELAY_TOKEN` / 无 `prompt_enhance` 权益时不要空跑 enhance。
- CLI **不会**按关键词自动联网。联网由调用方显式传 `--mode network` 或 `--with-network`。
- `plan` 只产出 Markdown 计划，不改文件、不跑命令。拿到计划后是否执行由用户决定。
- 详情：[modes.md](references/modes.md)、[network-search.md](references/network-search.md)

## 敏感信息

禁止：
- 把 `config.yaml`、Cookie、JWT、CSRF、密钥、密码放进 YCE query
- 把凭据写入测试输出、日志或最终回复
- 用真实凭据做普通单元测试
- 未经明确授权执行真实付费或生产操作

真实外部探测必须单独标记为 opt-in smoke test。

## 任务锚点（摘要）

增强返回 `task_context.created_now=true` 时立刻记下 id 与 goal。上下文被压缩后，第一步是 `node ./scripts/yce.js task show --cwd <项目>`。宣称完成前必须 `task done`。完整协议：[task-anchors.md](references/task-anchors.md)

## 最小调用

在 **YCE skill 根目录**执行：

```bash
# 定位
node ./scripts/yce.js "Locate the provider list retrieval logic" --mode search --cwd "/abs/project"

# 模糊需求 + 定位（auto 若 enhance 失败，仍用原始英文 query 搜索）
node ./scripts/yce.js "Help me find where this provider is handled" --mode auto --history "User: ...\nAI: ..." --cwd "/abs/project"

# 外部事实
node ./scripts/yce.js "What is the latest official React useEffect guidance" --mode network

# 只规划
node ./scripts/yce.js "Migrate login sessions to Redis with backward compatibility" --mode plan --with-search --cwd "/abs/project" --language zh-CN
```

指定落盘位置用 `--out <file|dir>`；只有需要管道时才用 `--stdout-xml`（此时主机可能截断，风险自负）。

更多示例：[examples.md](references/examples.md)

## 消费规则

- CLI 退出码与 `scripts/validate-yce-result.mjs` 同一套语义：`0` 放行，`2` 未读完，`3` 无主结果。
- 完整结果只在 `result_file`。按文件分段读，读到 `yce:eof` 哨兵为止；禁止把终端内容当完整结果。
- MCP 结果先核对 `<yce-consume>` 的 `xml_bytes` 与收到 XML 是否一致；服务端 `complete=true` 不能代替这一步。
- `--help` 也是 XML 且 exit 0，但 `resolved-action` 为空、`INVALID_ARGS`，不是检索成功。
- 契约与标签：[xml-contract.md](references/xml-contract.md)
- 排障：[troubleshooting.md](references/troubleshooting.md)
- Windows：[windows-execution.md](references/windows-execution.md)

修改本 skill 后先跑 `python3 ./scripts/quick_validate.py`。
