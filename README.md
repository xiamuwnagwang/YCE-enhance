# yw-enhance

English | [中文](./README.zh-CN.md)

> Prompt enhancement for AI coding assistants.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What It Is

`yw-enhance` is a skill plugin for AI coding assistants. It deepens a user prompt through a 4-agent pipeline:

1. Summarization
2. Intent detection
3. Web search
4. Final prompt enhancement

The goal is simple: provide better context, better intent understanding, and better next-step suggestions for the assistant.

## Highlights

- 4-agent enhancement pipeline for better prompt quality
- `smart` and `always` call modes
- Skill auto-discovery and AI-based skill recommendation
- Structured `<enhanced>...</enhanced>` output for downstream agents
- Works across multiple AI coding tools

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

- Pass `--history` for the latest 3-5 turns or a concise summary
- Use `--auto-confirm` in agent environments
- Use `--auto-skills` when you want the backend to recommend locally installed skills
- Keep timeout settings generous because the 4-agent pipeline usually needs 30-60 seconds

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

- Skill names are taken from locally scanned `installed_skills`
- The tool does not hardcode a fixed recommendation list
- Progress logs and token stats on `stderr` should not be shown to end users

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

## Requirements

- Node.js 16 or newer
- Network access to `https://a.aigy.de`
- A valid redeem code / token

## License

MIT
