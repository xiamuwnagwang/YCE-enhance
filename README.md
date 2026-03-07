# yw-enhance

> Prompt enhancement for AI coding assistants — English-first, with concise Chinese guidance.
>
> **中文**：这是一个给 AI 编程助手用的提示词增强 Skill，主展示英文，关键位置补充中文说明。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What It Is

`yw-enhance` is a skill plugin for AI coding assistants. It deepens a user prompt through a 4-agent pipeline:

1. Summarization
2. Intent detection
3. Web search
4. Final prompt enhancement

The goal is simple: give the assistant better context, better intent understanding, and better next-step suggestions.

**中文**：`yw-enhance` 会先理解你的问题，再按需联网补充信息，最后输出一份更适合 AI 助手继续执行的增强提示词。

## Highlights

- English-first README with Chinese helper notes.
- 4-agent enhancement pipeline for better prompt quality.
- `smart` and `always` call modes.
- Skill auto-discovery and AI-based skill recommendation.
- Structured `<enhanced>...</enhanced>` output for downstream agents.
- Works across multiple AI coding tools.

**中文**：重点能力是“增强提示词 + 推荐下一步该用哪些 skill”，适合复杂开发任务和上下文不足的提问。

## Supported Tools

| Tool | Status |
|------|--------|
| Claude Code | ✅ Supported |
| `.agents` shared skills directory | ✅ Supported when `~/.agents/skills` exists |
| OpenCode | ✅ Supported |
| Cursor | ✅ Supported |
| Windsurf | ✅ Supported |
| Cline | ✅ Supported |
| Continue | ✅ Supported |
| Codium | ✅ Supported |
| Aider | ✅ Supported |

**中文**：`agents` 目标是动态出现的，只有本机存在 `~/.agents/skills` 目录时才会显示。

## Quick Install

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/xiamuwnagwang/YCE-enhance/main/install.sh | bash
```

### Install from the repository

```bash
git clone https://github.com/xiamuwnagwang/YCE-enhance.git
cd YCE-enhance
bash install.sh
```

### Install to a specific tool

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

**中文**：如果你只想装到某一个 AI 工具，用 `--target` 或 `-Target` 最直接。

## Configuration

Run the interactive setup after installation:

```bash
bash install.sh --setup
```

```powershell
.\install.ps1 -Setup
```

You can also edit `.env` manually:

```env
YOUWEN_API_URL=https://a.aigy.de
YOUWEN_TOKEN=your-redeem-code
YOUWEN_ENHANCE_MODE=agent
YOUWEN_ENABLE_SEARCH=true
YOUWEN_MGREP_API_KEY=
YOUWEN_CALL_MODE=smart
```

### Environment variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `YOUWEN_API_URL` | No | `https://a.aigy.de` | Backend API endpoint |
| `YOUWEN_TOKEN` | Yes | - | Redeem code / token |
| `YOUWEN_ENHANCE_MODE` | No | `agent` | Enhancement mode: `agent` or `disabled` |
| `YOUWEN_ENABLE_SEARCH` | No | `true` | Enable web search |
| `YOUWEN_MGREP_API_KEY` | No | empty | Optional Mixedbread semantic search key |
| `YOUWEN_CALL_MODE` | No | `smart` | Call mode: `smart` or `always` |

**中文**：最关键的是 `YOUWEN_TOKEN`，没有它就无法正常调用后端增强能力。

## Usage

### Automatic invocation inside an AI assistant

In `smart` mode, the skill runs only when the prompt is ambiguous, lacks context, or needs research.  
In `always` mode, it runs on every user message.

```bash
export SKILLS_ROOT=~/.agents/skills

node $SKILLS_ROOT/yw-enhance/scripts/youwen.js enhance "Your prompt here" \
  --history "User: ...\nAI: ...\nUser: ..." \
  --auto-confirm --auto-skills
```

**中文**：如果接到 AI Agent 里，记得传 `--history`，这样增强结果会更准。

### Manual CLI examples

```bash
# Basic enhancement
node scripts/youwen.js enhance "Build a React login component"

# With conversation history
node scripts/youwen.js enhance "Optimize this code" \
  --history "User: I am building an admin panel in React\nAI: Got it\nUser: The table is slow" \
  --auto-confirm --auto-skills

# Skip web search for simpler prompts
node scripts/youwen.js enhance "Explain useEffect" --auto-confirm --no-search
```

### Recommended runtime behavior

- Pass `--history` for the latest 3-5 turns or a concise summary.
- Use `--auto-confirm` in agent environments.
- Use `--auto-skills` when you want the backend to recommend locally installed skills.
- Keep timeout settings generous: the 4-agent pipeline usually needs 30-60 seconds.

**中文**：不要用很短的超时轮询；这个 skill 本身就是偏“深处理”的链路。

## Output Format

`stdout` returns a single `<enhanced>` block:

```xml
<enhanced>
推荐技能：
- <user-local-skill-name-1>：<reason>
- <user-local-skill-name-2>：<reason>

增强提示词正文：
...
</enhanced>
```

Notes:

- Skill names are taken from locally scanned `installed_skills`.
- The tool does not hardcode a fixed recommendation list.
- Progress logs and token stats on `stderr` should not be shown to end users.

**中文**：真正要给后续 agent 用的是 `<enhanced>` 里的正文，不是原始用户提问。

## Update and Sync

```bash
# Check current version
bash install.sh --check

# Update to the latest version
bash install.sh --install

# Sync scripts and config to installed locations
bash install.sh --sync

# Sync only .env
bash install.sh --sync-env
```

```powershell
.\install.ps1 -Check
.\install.ps1
.\install.ps1 -Sync
.\install.ps1 -SyncEnv
```

**中文**：更新时会尽量保留已有 `.env` 配置，不用每次重填。

## Uninstall

```bash
bash install.sh --uninstall
```

```powershell
.\install.ps1 -Uninstall
```

## Project Structure

```text
yw-enhance/
├── README.md
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

**中文**：当前仓库里真正存在的就是这些主文件；旧 README 里提到的部分脚本和引用文件已经不在当前目录中。

## Requirements

- Node.js 16 or newer
- Network access to `https://a.aigy.de`
- A valid redeem code / token

**中文**：如果网络到不了后端，或者没有兑换码，增强流程就会失败。

## License

MIT
