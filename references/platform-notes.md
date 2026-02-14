# 平台注意事项

## macOS

- 不要使用 `timeout` 命令包裹调用（macOS 默认无此命令）
- 如需超时控制，使用 AI Agent 内置的超时参数

## 通用

- `<skill-dir>` 替换为实际安装路径
  - Claude Code: `~/.claude/skills/yw-enhance`
  - OpenCode: `~/.config/opencode/skill/yw-enhance`
- 命令执行后检查 exit code，非 0 为失败
- 输出为结构化 JSON，AI Agent 可直接解析
- 始终使用 `--auto-confirm`，AI Agent 无法进行交互式输入
