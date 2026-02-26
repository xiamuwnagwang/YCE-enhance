# 平台注意事项

## 路径约定

**推荐使用环境变量**：
```bash
export SKILLS_ROOT=~/.agents/skills  # 或你的实际 skills 根目录
```

**各工具默认路径**：
| 工具 | 默认路径 |
|------|----------|
| OpenCode | `~/.agents/skills/yw-enhance` |
| Claude Code | `~/.claude/skills/yw-enhance` |
| Cursor | `~/.cursor/skills/yw-enhance` |

**命令格式**：
```bash
# 推荐（使用环境变量）
node $SKILLS_ROOT/yw-enhance/scripts/youwen.js enhance "..." --auto-confirm

# 或相对路径（在 skill 目录内）
node ./scripts/youwen.js enhance "..." --auto-confirm
```

## macOS

- 不要使用 `timeout` 命令包裹调用（macOS 默认无此命令）
- 如需超时控制，使用 AI Agent 内置的超时参数

## 通用

- 命令执行后检查 exit code，非 0 为失败
- 输出为结构化 JSON，AI Agent 可直接解析
- 始终使用 `--auto-confirm`，AI Agent 无法进行交互式输入
