---
name: yw-enhance
version: 1.4.0
description: |
  提示词智能增强 Skill。对用户提示词进行深度增强，内置多源搜索能力
  支持两种调用模式（通过 YOUWEN_CALL_MODE 配置）：
  - `always`：每次收到用户消息后必须先调用增强，再基于增强结果回答。
  - `smart`（默认）：仅在语义模糊、缺乏上下文、涉及搜索/研究时自动调用。
  【强制规则】调用时必须通过 --history 传入当前会话上下文（最近 3-5 轮或摘要）。
  【强制规则】命令执行需 30-60s，必须设置充足超时（timeout ≥ 90s）并一次阻塞等待结果，禁止短 timeout 轮询。stderr 进度和 token 统计不展示给用户。
  触发词：优化提示词、增强提示词、enhance prompt、youwen、优问、enhance、提示词优化、prompt enhance、prompt optimize
  smart 模式额外触发：语义模糊、指代不清、缺乏上下文的技术提问、需要搜索研究的问题、复杂架构设计讨论、实时信息、最新新闻、技术文档查询、开源项目调研
  跳过场景：意图明确且上下文充分、纯闲聊/打招呼、简单确认（是/否/好的/继续）、文件/git/系统操作指令、纯数学计算
  调用示例：node <skill-dir>/scripts/youwen.js enhance "用户原始提示词" --history "User: ...\nAI: ...\nUser: ..." --auto-confirm --auto-skills
user-invocable: true
---

# 提示词智能增强


## 快速调用（AI Agent 复制即用）


**📌 路径说明**：命令使用相对路径 `./scripts/`，表示相对于 skill 根目录。
- 设置环境变量：`export SKILLS_ROOT=~/.agents/skills`
- 实际调用：`node $SKILLS_ROOT/yw-enhance/scripts/youwen.js ...`

**📌 安装说明**：
- 安装到 `.agents` 目录：`bash install.sh --target agents`（需要 `~/.agents/skills` 目录存在）
- 安装到其他工具：`bash install.sh --target claude` / `cursor` / `windsurf` 等
- `agents` 选项会动态检测 `~/.agents/skills` 目录，不存在时不显示该选项

```bash
node $SKILLS_ROOT/yw-enhance/scripts/youwen.js enhance "用户提示词" \
  --history "User: ...\nAI: ...\nUser: ..." \
  --auto-confirm --auto-skills
```

- 超时设置 ≥ 90s（4-Agent 流水线需要 30-60s）
- 一次阻塞等待结果，禁止短 timeout 轮询
- macOS 下不要用 `timeout` 命令包裹

## 调用判断（smart 模式决策树）

```
用户消息 → 是否包含触发词？ → 是 → 调用
                ↓ 否
         语义模糊/指代不清？ → 是 → 调用
                ↓ 否
         缺乏上下文的技术提问？ → 是 → 调用
                ↓ 否
         需要搜索/研究/实时信息？ → 是 → 调用
                ↓ 否
         复杂架构/设计讨论？ → 是 → 调用
                ↓ 否
         跳过（直接回答）
```

## 输出处理

stdout 输出 XML 标签格式（仅一个 `<enhanced>` 标签）：

```xml
<enhanced>
推荐技能：
- <用户本地-skill-名称-1>：推荐理由
- <用户本地-skill-名称-2>：推荐理由

增强提示词正文：
...
</enhanced>
```

说明：
- “推荐技能”小节中的工具名来自**用户本机实际扫描到的 installed_skills**。
- 不再输出 `<auto-skills>` 标签。

AI Agent 处理步骤：
1. 读取 `<enhanced>` 内容作为增强结果
2. 从开头“推荐技能”小节提取推荐工具（按需调用）
3. 使用“增强提示词正文”继续回答用户（而非原始提示词）
4. stderr 进度信息和 `--- Token 统计 ---` 不展示给用户
5. exit code 非 0 → 失败，直接用原始提示词回答

## 参数说明

| 参数 | 必须 | 说明 |
|------|:---:|------|
| `--history <text>` | ✅ | 对话上下文，格式：`User: ...\nAI: ...\nUser: ...` |
| `--auto-confirm` | ✅ | 跳过交互式确认（AI Agent 无法交互输入） |
| `--auto-skills` | ✅ | 自动注入可用 skill 上下文 |
| `--no-search` | 可选 | 禁用搜索（简单问题可加此参数加速） |
| `--token <code>` | 可选 | 兑换码，覆盖环境变量 `YOUWEN_TOKEN` |
| `--force` | 可选 | 强制执行（忽略 disabled 模式） |

## 上下文传入策略

| 对话长度 | 策略 |
|---------|------|
| < 2000 字 | 直接传入完整对话 |
| > 2000 字 | 最近 3-5 轮 + 关键上下文摘要 |
| 涉及代码 | 将关键代码片段包含在 history 中 |
| 首轮对话 | history 留空或传入项目背景信息 |

## 配置

环境变量通过 `<skill-dir>/.env` 配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `YOUWEN_CALL_MODE` | `smart`（智能判断）/ `always`（每次调用） | `smart` |
| `YOUWEN_API_URL` | 后端地址 | `https://a.aigy.de` |
| `YOUWEN_TOKEN` | 兑换码 | 空 |
| `YOUWEN_ENHANCE_MODE` | `agent` / `disabled` | `agent` |
| `YOUWEN_ENABLE_SEARCH` | `true` / `false` | `true` |
| `YOUWEN_MGREP_API_KEY` | 语义检索增强 Key | 空 |

## Skill 智能推荐机制

yw-enhance 会自动扫描已安装的所有 skill，并由**后端 AI 智能推荐**与当前任务最相关的 skill。

### 推荐原理

1. **前端扫描**：自动扫描主流 AI 编程工具的 skill 目录：
   - `~/.claude/skills` (Claude Desktop)
   - `~/.config/opencode/skills` (OpenCode)
   - `~/.agents/skills` (通用跨工具共享目录)
   - `~/.cursor/skills` (Cursor)
   - `~/.codeium/windsurf/skills` (Windsurf)
   - `~/.cline/skills` (Cline)
   - `~/.gemini/skills` (Gemini CLI / Gemini Code Assist)
   - `~/.copilot/skills` (GitHub Copilot)
2. **上下文注入**：将所有 skill 的元信息（name, description, triggers, quickStart）传给后端
3. **AI 决策**：后端 AI 根据用户提示词和会话上下文，智能推荐 3-8 个最相关的 skill
4. **开头直出**：推荐结果直接出现在 `<enhanced>` 开头“推荐技能”小节中（每行“工具名：推荐理由”）
5. **名称约束**：展示名称仅允许来自用户本机扫描到的 `installed_skills.name`（不使用内置固定示例名）

### 推荐输出格式

```text
推荐技能：
- <用户本地-skill-名称-1>：<结合当前任务的推荐理由>
- <用户本地-skill-名称-2>：<结合当前任务的推荐理由>
```

### 优势

- **动态适配**：推荐随用户任务变化，不会推荐无关 skill
- **零配置**：无需手动维护配置文件，AI 自动决策
- **高调用率**：明确的触发条件和调用方式，让 AI 立即匹配并执行

## References

详见 `references/` 目录。
