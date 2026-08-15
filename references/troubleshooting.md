# 排障

先看收据的 `exit_code`、`reasons`、`errors`、`resolved_action`，再按需读 `result_file` 里的 `<search><query>` 和 `<meta><dependency-paths>`。不要凭感觉猜链路。

| 退出码 | 含义 | 处理 |
|--------|------|------|
| `0` | 完整且有主结果 | 按 `gate` 继续 |
| `1` | 参数或执行错误 | 看 stdout 的 `INVALID_ARGS` / `EXEC_ERROR` |
| `2` | 输出不完整 | 重读 `result_file` 或重跑；看 `reasons` 里的 `structure:` / `sentinel` |
| `3` | 完整但无主结果 | 先排 `errors`，不要改代码 |

| 症状 | 原因 | 处理 |
|------|------|------|
| 空结果或搜到别的项目 | 没传 `--cwd` | 显式绝对路径 |
| `TIMEOUT` | 外层短 timeout 轮询 | 一次阻塞等待；search/auto ≥ 120s，plan ≥ 300s |
| 加了 `--no-search` 仍在搜代码 | 该参数只关增强阶段外部搜索 | 只要增强就用 `--mode enhance` |
| success=true 但没定位到代码 | 空结果时 success 仍可能为 true | 看 `result-present` 和校验退出码 3 |
| `PARSE_ERROR` / 没有 `<enhanced>` | 增强输出被污染 | `--raw-events`；核对 `YCE_PROMPT_ENHANCE_SCRIPT` |
| `DEPENDENCY_NOT_FOUND` | yce-engine 或 node_modules 缺失 | 核对 `meta.dependency_paths` |
| `AUTH_ERROR` | 未配 `YCE_RELAY_TOKEN` 或 relay 不可用 | `install.sh --setup`；`yce-engine.mjs --check-key` |
| `UPSTREAM_ERROR` / resource_exhausted | 远端资源耗尽 | 可开 `YCE_LOCAL_FALLBACK=true` |
| `--help` 被当成成功 | exit 0 且是 XML | 空 resolved-action + `INVALID_ARGS` |
| `integrity: "mismatch"` | 文件被改写、读到半写文件、中段被省略 | 重跑 YCE；不要用这份文件 |
| `reasons` 出现 `receipt sha256 mismatch` | 文件与收据不是同一份 | 用收据里的 `result_file`；必要时重跑 |
| `reasons` 出现 `structure:` | 标签栈不平衡，内容有缺失 | 同上，重跑 |
| `integrity: "unverified"` + `sentinel_ambiguous` | 正文引用了哨兵（如检索到 YCE 自身源码） | 不是故障；要确定性就带 `--expect-sha256` |
| 读到哨兵却还有后续内容 | 那是正文引用的文本，不是文件结尾 | 继续往下读到最后一行 |
| 找不到 `result_file` | 临时目录被清理（超过 3 天自动删） | 重跑；要长期留存用 `--out <path>` |
| stderr 提示无法写入结果文件 | 目标目录不可写 | 设 `YCE_RESULT_DIR` 或 `--out` 到可写路径 |
| 调完 plan 直接改代码 | 误解 Y-Plan | 只呈现 `<plan>`，用户确认后再执行 |
| `NOT_DEPLOYED` | 线上还没有 enhance / plan 端点 | 不是客户端故障；search/network 仍可用 |
| stderr 提示 skill 有新版本 | 本地 version 落后 | 在**本机 yce 根目录**执行 `bash ./install.sh --install` |

安装：`bash ./install.sh --install|--setup|--check|--sync|--sync-env|--uninstall`。发布：先改 `SKILL.md` 的 `version:`，再 `bash ./scripts/build-release.sh`。
