---
name: yce
version: 3.1.0
description: |
  当任务既需要把模糊需求说清楚，又需要去代码库里把实现找出来时使用。适用于"帮我看看这块逻辑在哪""优化任务后再搜代码""增强后检索""auto search""YCE"等场景。
  需要当前外部信息、官方库文档、竞品/行业调研时用 `--mode network` 或 `--with-network`。
  只要规划不要执行时用 `--mode plan` / Y-Plan。
  代码任务必须先 yce 检索，并用 validate-yce-result 确认 result-present="true" 后才能改代码。终端出现 truncated / token limit / XML 不完整时不得声称已读完。
user-invocable: true
---

# YCE Skill

本文件是唯一执行协议。参数表、XML 示例、错误码与排障见 `references/`，不要在本文件重复。

## 不可违反的主流程

1. 确认目标项目绝对路径，不在该目录时必须传 `--cwd`。
2. 凡最终会进入 search 的调用，先把自然语言检索意图转成准确、简洁的英文 query。代码标识符、路径、命令、报错原文和字符串字面量保持不变。YCE 不会自动翻译。
3. 按下表选择 **一种** 模式，发起 **一次** YCE 调用，外层阻塞等待完成（search/auto/network ≥ 120s，plan ≥ 300s）。禁止短 timeout 轮询。
4. 把 stdout **整份写入文件**，再跑校验，不要用肉眼扫终端 XML：

```bash
OUT="$TMPDIR/yce-result.xml"
node ./scripts/yce.js "<english query>" --mode search --cwd "/absolute/path/to/project" --xml-pretty > "$OUT"
node ./scripts/validate-yce-result.mjs "$OUT"
```

5. 必须消费校验 JSON，并核对这些字段（脚本已解析，无需手读 XML）：
   - `resolved_action`
   - `search.result_present` / `network.result_present` / `plan.result_present`
   - `errors`
   - `task_context`
6. **只有** `gate.may_analyze_or_edit_code === true`（即 `<search result-present="true">`）才能继续分析或修改代码。
7. 终端、工具回传或保存文件里出现 `truncated`、`token limit`、不完整 XML、校验 `complete=false` / 退出码 `2` 时：**不得声明读取或检索完成**。必须分段 `Read` 该 XML 文件，或重新执行 YCE。引擎结果内部的 `(lines truncated)` / `(tree truncated)` 不算主机截断；以校验脚本为准。
8. `success=true` 不能代替 `result-present=true`。校验退出码 `3` 表示 XML 完整但没有可用主结果，先排障，不要改代码。

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
node ./scripts/yce.js "Locate the provider list retrieval logic" --mode search --cwd "/abs/project" --xml-pretty

# 模糊需求 + 定位（auto 若 enhance 失败，仍用原始英文 query 搜索）
node ./scripts/yce.js "Help me find where this provider is handled" --mode auto --history "User: ...\nAI: ..." --cwd "/abs/project" --xml-pretty

# 外部事实
node ./scripts/yce.js "What is the latest official React useEffect guidance" --mode network --xml-pretty

# 只规划
node ./scripts/yce.js "Migrate login sessions to Redis with backward compatibility" --mode plan --with-search --cwd "/abs/project" --language zh-CN --xml-pretty
```

更多示例：[examples.md](references/examples.md)

## 消费规则

- 校验脚本：`scripts/validate-yce-result.mjs`。退出 `0` 才允许按 `gate` 继续；`2` = 未读完；`3` = 无主结果。
- 大 XML 必须按文件分段读取，禁止把截断终端输出当成完整结果。
- MCP 结果先核对 `<yce-consume>` 的 `xml_bytes` 与收到 XML 是否一致；服务端 `complete=true` 不能代替这一步。
- `--help` 也是 XML 且 exit 0，但 `resolved-action` 为空、`INVALID_ARGS`，不是检索成功。
- 契约与标签：[xml-contract.md](references/xml-contract.md)
- 排障：[troubleshooting.md](references/troubleshooting.md)
- Windows：[windows-execution.md](references/windows-execution.md)

修改本 skill 后先跑 `python3 ./scripts/quick_validate.py`。
