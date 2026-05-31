# YCE Enhance

**YCE**（Youwen Code Enhancement）是一套面向 AI Agent 的 Cursor Skill：在动手改代码之前，先把模糊需求说清楚，再在目标代码库里精准定位相关实现。

当前版本：**1.6.5**

## 功能

| 模式 | 说明 |
|------|------|
| `auto` | 自动判断：模糊需求先增强再检索，具体问题直接检索 |
| `enhance` | 优化任务描述 / 提示词 |
| `search` | 在指定项目中做语义代码检索 |

核心能力：

- **提示词增强**：通过内置 `youwen.js` 链路把口语化需求整理成可执行的检索 query
- **语义检索**：内置 `yce-engine` 本地搜索引擎，不依赖外部 mgrep
- **统一 XML 输出**：`scripts/yce.js` 对外固定输出 XML 契约，便于 Agent 解析
- **多工具安装**：一键安装到 Claude Code、Cursor、Codex、OpenCode 等常见 Agent 环境
- **Windows Relay**：Windows 下可通过 `YCE_RELAY_URL` / `YCE_RELAY_TOKEN` 租借 key

## 快速开始

### 安装

```bash
git clone https://github.com/xiamuwnagwang/YCE-enhance.git
cd YCE-enhance

# macOS / Linux
bash ./install.sh --install
bash ./install.sh --setup

# Windows PowerShell
.\install.ps1 -Install
.\install.ps1 -Setup
```

### 调用示例

```bash
# 推荐：模糊需求 + 代码定位
node ./scripts/yce.js "帮我看看 provider 那块是在哪里处理的" \
  --mode auto \
  --history "User: 我在看 provider 逻辑\nAI: 相关代码分散在多个模块" \
  --cwd "/absolute/path/to/project" \
  --xml-pretty

# 只做代码检索
node ./scripts/yce.js "定位 provider 列表获取逻辑" \
  --mode search \
  --cwd "/absolute/path/to/project" \
  --xml-pretty

# 只做提示词增强
node ./scripts/yce.js "优化这个任务描述" \
  --mode enhance \
  --history "User: ...\nAI: ..." \
  --xml-pretty
```

**调用约束：**

- 代码检索必须在目标项目目录运行，或显式传 `--cwd`
- 增强场景建议传 `--history`
- 外层等待建议 `>= 120s`

## 配置

运行时配置写在仓库根目录 `.env`（安装脚本会引导生成）。常用项：

| 变量 | 说明 |
|------|------|
| `YCE_YOUWEN_SCRIPT` | 增强脚本路径，默认 `./scripts/youwen.js` |
| `YCE_ENGINE_SCRIPT` | 检索引擎路径，默认 `./vendor/yce-engine/yce-engine.mjs` |
| `YCE_MODE` | 默认模式，通常 `auto` |
| `YCE_RELAY_URL` | Windows relay 服务地址（可选） |
| `YCE_RELAY_TOKEN` | Windows relay 认证 token（可选） |

检查与同步：

```bash
bash ./install.sh --check
bash ./install.sh --sync
bash ./install.sh --sync-env
```

## 下载 Release

预打包产物见 [Releases](https://github.com/xiamuwnagwang/YCE-enhance/releases)：

- `yce-skill-v1.6.5.tar.gz`
- `yce-skill-v1.6.5.zip`
- `SHA256SUMS`

解压后运行 `install.sh` / `install.ps1` 即可。

## 项目结构

```
.
├── SKILL.md              # Agent Skill 定义与完整文档
├── scripts/
│   ├── yce.js            # 对外 CLI 入口
│   ├── youwen.js         # 提示词增强入口
│   └── lib/              # orchestrator、adapter、utils
├── vendor/yce-engine/    # 内置语义检索引擎
├── install.sh            # macOS / Linux 安装器
└── install.ps1           # Windows 安装器
```

## 开发与发布

```bash
# 打包（版本号读取 SKILL.md）
bash ./scripts/build-release.sh

# 上传到 GitHub Release（需 gh 登录）
bash ./scripts/upload-release.sh --build
```

发布前请确保 `SKILL.md` 的 `version:` 已更新为语义化版本号。

## 许可证

请参阅仓库内相关许可文件。如需二次分发，请保留 `SKILL.md` 与 `vendor/yce-engine` 的完整性。

## 相关链接

- 仓库：<https://github.com/xiamuwnagwang/YCE-enhance>
- 详细 Skill 文档：见 [`SKILL.md`](./SKILL.md)
