# 任务锚点

任务卡存放在项目 `.yce/tasks/<id>.json`（goal 一经建卡不可变；active 卡 7 天未更新自动归档；与 MCP 共享同一目录）。

## 开工

跑 `enhance` / `auto` 后，若 XML 返回 `<task-context created-now="true">`：

1. 立刻把 `<id>`、`<goal>`、阶段验收记入自己的计划 / todo
2. 后续中途调用显式带 `--task <id>`
3. 阶段完成即 `task check <n> --task <id> --evidence "<可检验的证据>"`

## 压缩恢复

发现上下文被压缩 / 摘要后，第一个动作必须是：

```bash
node ./scripts/yce.js task show --cwd <项目>
```

以卡上的 goal 与验收原文为准，不要凭残留记忆重构目标。

## 完成

宣称完成前必须 `task done`。未过验收会返回 `<unmet>` 并 exit 1；确要跳过用 `--force`。

## 零配合兜底

即使 agent 不做簿记：增强产出锚点时自动建卡；之后每次 search/auto/enhance/plan 的 XML 都会带 `<task-context>` 复述活跃卡。`--no-task` 可关闭本次建卡与复述。
