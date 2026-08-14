# 排障

先看校验 JSON 的 `resolved_action`、`errors`、`search.result_present`，以及 XML 里的 `<search><query>` 和 `<meta><dependency-paths>`。不要凭感觉猜链路。

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
| 调完 plan 直接改代码 | 误解 Y-Plan | 只呈现 `<plan>`，用户确认后再执行 |
| `NOT_DEPLOYED` | 线上还没有 enhance / plan 端点 | 不是客户端故障；search/network 仍可用 |
| stderr 提示 skill 有新版本 | 本地 version 落后 | 在**本机 yce 根目录**执行 `bash ./install.sh --install` |

安装：`bash ./install.sh --install|--setup|--check|--sync|--sync-env|--uninstall`。发布：先改 `SKILL.md` 的 `version:`，再 `bash ./scripts/build-release.sh`。
