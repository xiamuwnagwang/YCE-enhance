# yw-enhance

[English](./README.md) | 中文

> 面向 AI 编程助手的提示词增强工具。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 它是什么

`yw-enhance` 是一个给 AI 编程助手使用的 Skill 插件。它会通过 4-Agent 流水线来增强用户提示词：

1. 摘要提炼
2. 意图识别
3. 联网搜索
4. 最终增强

目标很直接：让助手拿到更完整的上下文、更准确的意图判断，以及更清晰的下一步执行建议。

## 核心特性

- 4-Agent 流水线，提升提示词质量
- 支持 `smart` 和 `always` 两种调用模式
- 自动发现本地 skill，并基于 AI 做技能推荐
- 输出固定的 `<enhanced>...</enhanced>` 结构，方便下游 agent 继续处理
- 可用于多个 AI 编程工具

## 支持的工具

| 工具 | 状态 |
|------|------|
| Claude Code | ✅ 支持 |
| `.agents` 共享 skills 目录 | ✅ 当 `~/.agents/skills` 存在时支持 |
| OpenCode | ✅ 支持 |
| Cursor | ✅ 支持 |
| Windsurf | ✅ 支持 |
| Cline | ✅ 支持 |
| Continue | ✅ 支持 |
| Codium | ✅ 支持 |
| Aider | ✅ 支持 |

## 快速安装

### 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/xiamuwnagwang/YCE-enhance/main/install.sh | bash
```

### 从仓库安装

```bash
git clone https://github.com/xiamuwnagwang/YCE-enhance.git
cd YCE-enhance
bash install.sh
```

### 安装到指定工具

```bash
bash install.sh --target claude
bash install.sh --target agents
bash install.sh --target opencode
bash install.sh --target cursor
bash install.sh --target windsurf
```

### Windows PowerShell

```powershell
.\install.ps1
.\install.ps1 -Target claude
.\install.ps1 -Setup
```

## 配置

安装完成后，先运行交互式配置：

```bash
bash install.sh --setup
```

```powershell
.\install.ps1 -Setup
```

你也可以手动编辑 `.env`：

```env
YOUWEN_API_URL=https://a.aigy.de
YOUWEN_TOKEN=your-redeem-code
YOUWEN_ENHANCE_MODE=agent
YOUWEN_ENABLE_SEARCH=true
YOUWEN_MGREP_API_KEY=
YOUWEN_CALL_MODE=smart
```

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `YOUWEN_API_URL` | 否 | `https://a.aigy.de` | 后端 API 地址 |
| `YOUWEN_TOKEN` | 是 | - | 兑换码 / Token |
| `YOUWEN_ENHANCE_MODE` | 否 | `agent` | 增强模式：`agent` 或 `disabled` |
| `YOUWEN_ENABLE_SEARCH` | 否 | `true` | 是否开启联网搜索 |
| `YOUWEN_MGREP_API_KEY` | 否 | 空 | 可选的 Mixedbread 语义检索 Key |
| `YOUWEN_CALL_MODE` | 否 | `smart` | 调用模式：`smart` 或 `always` |

## 使用

### 在 AI 助手中自动调用

`smart` 模式下，只有提示词含糊、上下文不足、或需要搜索研究时才会触发。  
`always` 模式下，每条用户消息都会触发。

```bash
export SKILLS_ROOT=~/.agents/skills

node $SKILLS_ROOT/yw-enhance/scripts/youwen.js enhance "Your prompt here" \
  --history "User: ...\nAI: ...\nUser: ..." \
  --auto-confirm --auto-skills
```

### 手动 CLI 示例

```bash
# 基础增强
node scripts/youwen.js enhance "Build a React login component"

# 带对话历史
node scripts/youwen.js enhance "Optimize this code" \
  --history "User: I am building an admin panel in React\nAI: Got it\nUser: The table is slow" \
  --auto-confirm --auto-skills

# 简单问题可关闭搜索
node scripts/youwen.js enhance "Explain useEffect" --auto-confirm --no-search
```

### 运行建议

- `--history` 建议传最近 3-5 轮，或者一段简短摘要
- 在 agent 环境里建议始终带上 `--auto-confirm`
- 如果你希望后端一起推荐本地 skill，就加上 `--auto-skills`
- 超时要放宽一些，因为 4-Agent 流水线通常需要 30-60 秒

## 输出格式

`stdout` 会返回一个 `<enhanced>` 结构：

```xml
<enhanced>
推荐技能：
- <user-local-skill-name-1>：<reason>
- <user-local-skill-name-2>：<reason>

增强提示词正文：
...
</enhanced>
```

说明：

- skill 名称来自本地扫描得到的 `installed_skills`
- 工具不会写死固定推荐列表
- `stderr` 里的进度日志和 token 统计不应该直接展示给最终用户

## 更新与同步

```bash
# 检查当前版本
bash install.sh --check

# 更新到最新版本
bash install.sh --install

# 同步脚本和配置到已安装目录
bash install.sh --sync

# 只同步 .env
bash install.sh --sync-env
```

```powershell
.\install.ps1 -Check
.\install.ps1
.\install.ps1 -Sync
.\install.ps1 -SyncEnv
```

## 卸载

```bash
bash install.sh --uninstall
```

```powershell
.\install.ps1 -Uninstall
```

## 项目结构

```text
yw-enhance/
├── README.md
├── README.zh-CN.md
├── SKILL.md
├── install.sh
├── install.ps1
├── scripts/
│   └── youwen.js
└── references/
    ├── context-strategy.md
    ├── output-handling.md
    └── platform-notes.md
```

## 系统要求

- Node.js 16 或更高版本
- 能访问 `https://a.aigy.de`
- 有效的兑换码 / Token

## License

MIT
