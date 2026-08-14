# Windows 执行

- 安装 / 更新用 `.\install.ps1 -Install` / `-Setup` / `-Check` / `-Sync` / `-SyncEnv` / `-Uninstall`。
- 检索引擎使用内置 yce-engine；默认写入 `YCE_RELAY_URL=https://yce.aigy.de`，代码、联网、增强、规划共用 `YCE_RELAY_TOKEN`。
- `--cwd` 必须是绝对路径。含空格时用引号包住，不要把当前 PowerShell 目录误当成目标项目。
- 引擎在本地循环执行 rg/readfile/tree/ls/glob。如确有进程兼容查询，只允许严格白名单的 `Get-CimInstance Win32_Process`，不开放通用 PowerShell。远端只做推理，不上传代码、不建服务端索引。
- 不要在 home 目录或超大目录里做检索。项目根可放 `.yceignore`（每行一个 exclude glob；`#` 注释；不支持 `!` 反选）。
