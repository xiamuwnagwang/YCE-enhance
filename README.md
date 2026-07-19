# YCE Skill

YCE（Youwen Code Enhance）是面向 AI Agent 的 **提示词增强 + 语义代码检索 + 联网检索** skill。  
当前版本：**2.1.0**。

## License

本项目以 **GNU General Public License v3.0（GPL-3.0）** 发布。

- 完整文本见仓库根目录 [`LICENSE`](./LICENSE)
- 你可以自由使用、修改、分发本软件
- 若你分发本软件或其衍生作品，必须同样以 GPL-3.0（或兼容条款）开源，并保留版权与许可声明
- 本软件按“现状”提供，不附带任何明示或暗示担保

```text
YCE Skill
Copyright (C) 2026 YCE contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

使用本仓库即表示你知悉并同意遵循 GPL-3.0。  
更完整的行为说明与 Agent 调用契约见 [`SKILL.md`](./SKILL.md)。

## 功能概览

- **enhance**：把模糊任务整理成可执行提示词（**无增强密钥时不要调用**；`auto` 会自动跳过 enhance 直接 search）
- **search**：在本地项目内做语义代码定位（远端只做推理，不上传源码建索引）；问题已够具体时优先用这个
- **network**：外部联网检索（事实依据 / 调研 / 官方文档 / 竞品等），结果在 XML `<network-search>`
- **auto**：增强后在同一次调用内强制收口到 search；无增强密钥时跳过 enhance 直接 search（**不会**自动联网）
- **`--with-network`**：由 Agent 判断后，在任意模式上显式附加联网

默认经公共 **YCE 服务**（`https://yce.aigy.de`）完成鉴权、代码语义检索与联网检索；具体请求路径由 skill 内部处理，使用时只需配置 `YCE_RELAY_TOKEN` 即可。联网是否触发由 Agent 在调用时判断，CLI 不做关键词自动猜测。

## 快速开始

```bash
# 安装到本机 agent skills 目录
bash ./install.sh --install
bash ./install.sh --setup

# 检索（先 cd 到目标项目，或传 --cwd）
node ./scripts/yce.js "Locate the provider list retrieval logic" \
  --mode search \
  --cwd "/absolute/path/to/project" \
  --xml-pretty
```

配置检索密钥（`YCE_RELAY_TOKEN`）等环境变量，详见 `SKILL.md`。

## 仓库内容

| 路径 | 说明 |
|------|------|
| `scripts/yce.js` | 对外 CLI |
| `scripts/youwen.js` | 仓内增强入口 |
| `vendor/yce-engine/` | 语义检索引擎 |
| `install.sh` / `install.ps1` | 安装脚本 |
| `SKILL.md` | Agent 调用契约与完整文档 |
| `LICENSE` | GPL-3.0 全文 |

## 构建发布包（可选）

```bash
bash ./scripts/build-release.sh
```

产物在 `dist/`（不会提交密钥或 `.env`）。

## 贡献与分发

- 欢迎提交 Issue / PR
- 分发修改版时请遵守 GPL-3.0：提供对应源码、保留许可证与版权声明
- 不要把含密钥的 `.env` 提交进版本库

## 相关项目

- [y-plan](https://github.com/xiamuwnagwang/y-plan) — 规划 skill，内置 vendored YCE
