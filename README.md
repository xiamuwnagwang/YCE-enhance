# yw-enhance

> AI 编程助手的提示词智能增强 Skill — 4-Agent 流水线深度增强你的每一次提问

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 它是什么

yw-enhance 是一个运行在 AI 编程助手中的 Skill 插件，通过 4-Agent 流水线（摘要 → 意图识别 → 联网搜索 → 综合增强）对用户提示词进行深度增强，让 AI 助手给出更精准、更有上下文的回答。

支持的 AI 编程工具：

| 工具 | 状态 |
|------|------|
| Claude Code | ✅ 完整支持 |
| OpenCode | ✅ 完整支持 |
| Cursor | ✅ 完整支持 |
| Windsurf | ✅ 完整支持 |
| Cline | ✅ 完整支持 |
| Continue | ✅ 完整支持 |
| Codium | ✅ 完整支持 |
| Aider | ✅ 完整支持 |

## 快速安装

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/xiamuwnagwang/YCE-enhance/main/install.sh | bash
```

### 手动安装

```bash
git clone https://github.com/xiamuwnagwang/YCE-enhance.git
cd YCE-enhance
bash install.sh
```

### 安装到指定工具

```bash
bash install.sh --target claude      # Claude Code
bash install.sh --target opencode    # OpenCode
bash install.sh --target cursor      # Cursor
bash install.sh --target windsurf    # Windsurf
```

## 配置

安装后运行配置脚本：

```bash
# macOS / Linux
bash scripts/setup.sh

# Windows PowerShell
.\scripts\setup.ps1
```

或手动编辑 `.env` 文件：

```env
# 后端 API 地址
YOUWEN_API_URL=https://a.aigy.de

# 兑换码（必填）
YOUWEN_TOKEN=你的兑换码

# 增强模式: agent / disabled
YOUWEN_ENHANCE_MODE=agent

# 联合搜索: true / false
YOUWEN_ENABLE_SEARCH=true

# 调用模式: smart（智能判断）/ always（每次调用）
YOUWEN_CALL_MODE=smart
```

## 使用

### 在 AI 助手中自动触发

安装配置完成后，AI 助手会根据调用模式自动增强你的提示词：

- `smart` 模式：语义模糊、缺乏上下文、需要搜索研究时自动触发
- `always` 模式：每次提问都触发增强

### 手动调用

```bash
# 基础增强
node scripts/youwen.js enhance "帮我写一个 React 登录组件"

# 带对话历史
node scripts/youwen.js enhance "优化这段代码" \
  --history "User: 我在用 React 开发后台\nAI: 好的\nUser: 表格性能很差" \
  --auto-confirm --auto-skills

# 禁用搜索（加速简单问题）
node scripts/youwen.js enhance "解释 useEffect" --auto-confirm --no-search
```

### 输出格式

```xml
<enhanced>
推荐技能：
- <用户本地-skill-名称-1>：<结合当前任务的推荐理由>
- <用户本地-skill-名称-2>：<结合当前任务的推荐理由>

增强提示词正文：
...
</enhanced>
```

说明：推荐技能名称来自用户本机实际扫描到的 `installed_skills`，不会写死固定 skill 名称。

## 更新

```bash
# 检查版本
bash install.sh --check

# 更新到最新版
bash install.sh
```

脚本会自动保留你的 `.env` 配置。

## 卸载

```bash
bash install.sh --uninstall
```

## 项目结构

```
yw-enhance/
├── install.sh              # 安装 / 更新脚本
├── quickstart.sh           # 环境检查脚本
├── SKILL.md                # Skill 元数据（AI 助手读取）
├── .env.example            # 配置模板
├── scripts/
│   ├── youwen.js           # 核心 CLI（4-Agent 流水线）
│   ├── setup.sh            # 配置脚本（macOS/Linux）
│   └── setup.ps1           # 配置脚本（Windows）
└── references/
    ├── context-strategy.md # 上下文传入规范
    ├── output-handling.md  # 输出处理规范
    ├── platform-notes.md   # 平台注意事项
    └── when-to-call.md     # 调用模式判断
```

## 系统要求

- Node.js ≥ 16
- 网络连接（访问后端 API）
- 有效的兑换码

## License

MIT
