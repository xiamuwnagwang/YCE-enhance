<#
.SYNOPSIS
  yw-enhance 一键安装 / 更新 / 配置脚本 (Windows PowerShell)

.DESCRIPTION
  合并了安装、更新、配置、同步功能的统一脚本。

.EXAMPLE
  .\install.ps1                    # 安装或更新
  .\install.ps1 -Target claude     # 仅安装到 Claude Code
  .\install.ps1 -Check             # 检查版本
  .\install.ps1 -Uninstall         # 卸载
  .\install.ps1 -Setup             # 交互式配置环境变量
  .\install.ps1 -Setup -Edit       # 强制编辑配置
  .\install.ps1 -Setup -Reset      # 重置配置
  .\install.ps1 -Sync              # 同步脚本 + 配置到已安装目录
  .\install.ps1 -SyncEnv           # 仅同步 .env
#>

param(
  [switch]$Check,
  [switch]$Uninstall,
  [switch]$Setup,
  [switch]$Sync,
  [switch]$SyncEnv,
  [switch]$Edit,
  [switch]$Reset,
  [string]$Target,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".env"

# ==================== 常量 ====================

$RepoUrl = "https://github.com/xiamuwnagwang/YCE-enhance"
$RepoArchiveFallback = "https://github.com/xiamuwnagwang/YCE-enhance/archive/refs/heads/main.tar.gz"
$ApiUrl = "https://b.aigy.de"
$SkillName = "yw-enhance"

$ToolMap = @(
  @{ Key="claude";   Label="Claude Code"; Dir=Join-Path $env:USERPROFILE ".claude\skills\$SkillName" }
  @{ Key="opencode"; Label="OpenCode";    Dir=Join-Path $env:USERPROFILE ".config\opencode\skill\$SkillName" }
  @{ Key="cursor";   Label="Cursor";      Dir=Join-Path $env:USERPROFILE ".cursor\skills\$SkillName" }
  @{ Key="windsurf"; Label="Windsurf";    Dir=Join-Path $env:USERPROFILE ".windsurf\skills\$SkillName" }
  @{ Key="cline";    Label="Cline";       Dir=Join-Path $env:USERPROFILE ".cline\skills\$SkillName" }
  @{ Key="continue"; Label="Continue";    Dir=Join-Path $env:USERPROFILE ".continue\skills\$SkillName" }
  @{ Key="codium";   Label="Codium";      Dir=Join-Path $env:USERPROFILE ".codium\skills\$SkillName" }
  @{ Key="aider";    Label="Aider";       Dir=Join-Path $env:USERPROFILE ".aider\skills\$SkillName" }
)

$InstallFiles = @("scripts", "references", "SKILL.md", "quickstart.sh", "install.sh", "install.ps1", ".env.example", ".gitignore")

$EnvVarDefs = @(
  @{ Key="YOUWEN_API_URL";      Label="后端 API 地址";              Default="https://b.aigy.de"; Required=$false; Secret=$false; Options=@() }
  @{ Key="YOUWEN_TOKEN";        Label="兑换码 / Token";             Default="";                  Required=$true;  Secret=$true;  Options=@() }
  @{ Key="YOUWEN_ENHANCE_MODE"; Label="增强模式";                   Default="agent";             Required=$false; Secret=$false; Options=@("agent","disabled") }
  @{ Key="YOUWEN_ENABLE_SEARCH";Label="启用联合搜索";               Default="true";              Required=$false; Secret=$false; Options=@("true","false") }
  @{ Key="YOUWEN_MGREP_API_KEY";Label="Mixedbread 语义检索 API Key";Default="";                  Required=$false; Secret=$true;  Options=@() }
  @{ Key="YOUWEN_CALL_MODE";    Label="调用模式";                   Default="smart";             Required=$false; Secret=$false; Options=@("smart","always") }
)

# ==================== 工具函数 ====================

function Get-MaskedValue {
  param([string]$Val)
  if (-not $Val -or $Val.Length -le 4) { return "****" }
  return $Val.Substring(0,2) + ("*" * ($Val.Length - 4)) + $Val.Substring($Val.Length - 2)
}

function Get-LocalVersion {
  param([string]$Dir)
  $skillMd = Join-Path $Dir "SKILL.md"
  if (Test-Path $skillMd) {
    $match = Select-String -Path $skillMd -Pattern '^version:\s*(.+)' | Select-Object -First 1
    if ($match) { return $match.Matches[0].Groups[1].Value.Trim() }
  }
  return $null
}

function Read-EnvFile {
  param([string]$Path)
  $vars = @{}
  if (-not (Test-Path $Path)) { return $vars }
  foreach ($line in Get-Content $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -match '^(\w+)\s*=\s*(.*)$') {
      $vars[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
    }
  }
  return $vars
}

function Write-EnvFile {
  param([string]$Path, [hashtable]$Vars)
  $lines = @(
    "# yw-enhance 配置文件"
    "# 自动生成于 $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
    ""
  )
  foreach ($def in $script:EnvVarDefs) {
    $val = if ($Vars.ContainsKey($def.Key)) { $Vars[$def.Key] } else { $def.Default }
    $reqTag = if ($def.Required) { " (必填)" } else { "" }
    $optTag = if ($def.Options.Count -gt 0) { " [$($def.Options -join '/')]" } else { "" }
    $lines += "# $($def.Label)${reqTag}${optTag}"
    if ($val) { $lines += "$($def.Key)=$val" } else { $lines += "# $($def.Key)=" }
    $lines += ""
  }
  $lines | Out-File -FilePath $Path -Encoding UTF8 -Force
}

function Test-NodeInstalled {
  $nodePath = Get-Command node -ErrorAction SilentlyContinue
  if ($nodePath) {
    $nodeVer = & node -v 2>$null
    Write-Host "$([char]0x2714) Node.js $nodeVer" -ForegroundColor Green
    return $true
  }
  Write-Host "$([char]0x2718) 未安装 Node.js（需要 v16+）" -ForegroundColor Red
  Write-Host ""
  Write-Host "  安装方式:"
  Write-Host "    winget install OpenJS.NodeJS.LTS"
  Write-Host "    choco install nodejs-lts"
  Write-Host "    https://nodejs.org"
  exit 1
}

# ==================== 远程版本 ====================

function Get-RemoteInfo {
  try {
    $resp = Invoke-RestMethod -Uri "$script:ApiUrl/api/skill/version?name=$script:SkillName" -TimeoutSec 10 -ErrorAction Stop
    $ver = if ($resp.latest_version) { $resp.latest_version } elseif ($resp.version) { $resp.version } else { $null }
    $dl = if ($resp.downloadUrl) { $resp.downloadUrl } elseif ($resp.download_url) { $resp.download_url } else { $null }
    return @{ Version=$ver; DownloadUrl=$dl }
  } catch {
    return @{ Version=$null; DownloadUrl=$null }
  }
}

# ==================== 检测已安装 ====================

function Find-Installed {
  $found = @()
  foreach ($tool in $script:ToolMap) {
    if ((Test-Path $tool.Dir) -and ((Test-Path (Join-Path $tool.Dir "SKILL.md")) -or (Test-Path (Join-Path $tool.Dir "scripts\youwen.js")))) {
      $found += $tool
    }
  }
  return $found
}

function Find-OtherInstalls {
  $selfReal = (Resolve-Path $script:ScriptDir -ErrorAction SilentlyContinue).Path
  $detected = @()
  foreach ($tool in $script:ToolMap) {
    if (-not (Test-Path $tool.Dir)) { continue }
    $hasSkill = (Test-Path (Join-Path $tool.Dir "SKILL.md")) -or (Test-Path (Join-Path $tool.Dir "scripts\youwen.js"))
    if (-not $hasSkill) { continue }
    $dirReal = (Resolve-Path $tool.Dir -ErrorAction SilentlyContinue).Path
    if ($dirReal -ne $selfReal) { $detected += $tool }
  }
  return $detected
}

# ==================== 安装核心 ====================

function Install-ToDir {
  param([string]$SourceDir, [string]$TargetDir, [string]$ToolName)

  $envBackup = $null
  $envTarget = Join-Path $TargetDir ".env"
  if (Test-Path $envTarget) {
    $envBackup = [System.IO.Path]::GetTempFileName()
    Copy-Item $envTarget $envBackup
  }

  if (-not (Test-Path $TargetDir)) { New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null }

  foreach ($item in $script:InstallFiles) {
    $src = Join-Path $SourceDir $item
    $dst = Join-Path $TargetDir $item
    if (Test-Path $src) {
      if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
      Copy-Item $src $dst -Recurse -Force
    }
  }

  if ($envBackup -and (Test-Path $envBackup)) {
    Copy-Item $envBackup $envTarget -Force
    Remove-Item $envBackup -Force
    Write-Host "$([char]0x2714) ${ToolName}: 已更新（.env 已保留）" -ForegroundColor Green
  } else {
    $exampleEnv = Join-Path $TargetDir ".env.example"
    if ((Test-Path $exampleEnv) -and -not (Test-Path $envTarget)) {
      Copy-Item $exampleEnv $envTarget
      Write-Host "! ${ToolName}: 已安装（请编辑 $envTarget 配置 Token）" -ForegroundColor Yellow
    } else {
      Write-Host "$([char]0x2714) ${ToolName}: 已安装" -ForegroundColor Green
    }
  }
}

# ==================== 下载 ====================

function Get-LatestSource {
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "yw-enhance-$(Get-Random)"
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

  Write-Host "▸ 下载最新版本..." -ForegroundColor Blue

  $downloaded = $false
  $remoteInfo = Get-RemoteInfo

  if ($remoteInfo.DownloadUrl) {
    Write-Host "▸ 使用后端下载地址: $($remoteInfo.DownloadUrl)" -ForegroundColor Blue
    $repoDir = Join-Path $tmpDir "repo"
    try {
      $git = Get-Command git -ErrorAction SilentlyContinue
      if ($git) {
        & git clone --depth 1 $remoteInfo.DownloadUrl $repoDir 2>$null
        if ($LASTEXITCODE -eq 0) { $downloaded = $true }
      }
    } catch {}
  }

  if (-not $downloaded) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
      Write-Host "! 尝试 git clone..." -ForegroundColor Yellow
      $repoDir = Join-Path $tmpDir "repo"
      try {
        & git clone --depth 1 "$($script:RepoUrl).git" $repoDir 2>$null
        if ($LASTEXITCODE -eq 0) { $downloaded = $true }
      } catch {}
    }
  }

  if (-not $downloaded) {
    Write-Host "$([char]0x2718) 下载失败" -ForegroundColor Red
    exit 1
  }

  return $repoDir
}

# ==================== .env 检查 ====================

function Test-AllEnvVars {
  param([hashtable]$FileVars)
  $hasIssue = $false

  Write-Host ""
  Write-Host "╭─────────────────────────────────────────╮"
  Write-Host "│     yw-enhance 环境配置检查              │"
  Write-Host "╰─────────────────────────────────────────╯"
  Write-Host ""

  foreach ($def in $script:EnvVarDefs) {
    $envVal = [System.Environment]::GetEnvironmentVariable($def.Key)
    $fileVal = if ($FileVars.ContainsKey($def.Key)) { $FileVars[$def.Key] } else { $null }
    $effective = if ($envVal) { $envVal } elseif ($fileVal) { $fileVal } else { $def.Default }
    $source = if ($envVal) { "环境变量" } elseif ($fileVal) { ".env文件" } elseif ($def.Default) { "默认值" } else { "未设置" }

    $display = $effective
    if ($def.Secret -and $effective) { $display = Get-MaskedValue $effective }
    if (-not $display) { $display = "(空)" }

    $icon = ""; $color = "Green"; $statusMsg = ""
    if ($def.Required -and -not $effective) {
      $icon = [char]0x2718; $color = "Red"; $statusMsg = "-> 必填项未配置"; $hasIssue = $true
    } elseif ($def.Options.Count -gt 0 -and $effective -and $effective -notin $def.Options) {
      $icon = "!"; $color = "Yellow"; $statusMsg = "-> 可选值: $($def.Options -join ', ')"; $hasIssue = $true
    } else {
      $icon = [char]0x2714; $color = "Green"
    }

    Write-Host "  " -NoNewline; Write-Host "$icon" -ForegroundColor $color -NoNewline; Write-Host " $($def.Label)"
    Write-Host "    $($def.Key) = $display  [$source]"
    if ($statusMsg) { Write-Host "    $statusMsg" -ForegroundColor $color }
    Write-Host ""
  }
  return $hasIssue
}

function Test-BackendConnection {
  param([string]$ApiUrl, [string]$Token)
  Write-Host "🔗 测试后端连通性..." -NoNewline
  try {
    $headers = @{ "Accept" = "application/json" }
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }
    $response = Invoke-WebRequest -Uri "$ApiUrl/api/skill/version?name=$script:SkillName" -Headers $headers -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
    Write-Host ""
    if ($response.StatusCode -eq 200) {
      Write-Host "  $([char]0x2714) 后端连接正常" -ForegroundColor Green
    }
  } catch {
    Write-Host ""
    $statusCode = 0
    if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    if ($statusCode -eq 401 -or $statusCode -eq 403) {
      Write-Host "  $([char]0x2718) Token 无效或已过期 (HTTP $statusCode)" -ForegroundColor Red
    } elseif ($statusCode -gt 0) {
      Write-Host "  ! 服务器返回 HTTP $statusCode" -ForegroundColor Yellow
    } else {
      Write-Host "  $([char]0x2718) 无法连接到服务器: $($_.Exception.Message)" -ForegroundColor Red
    }
  }
  Write-Host ""
}

# ==================== 同步 ====================

function Sync-FilesToDir {
  param([string]$TargetDir, [string]$ToolName)
  $synced = 0
  foreach ($item in $script:InstallFiles) {
    $src = Join-Path $script:ScriptDir $item
    $dst = Join-Path $TargetDir $item
    if (Test-Path $src) {
      if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
      Copy-Item $src $dst -Recurse -Force
      $synced++
    }
  }
  Write-Host "  $([char]0x2714) ${ToolName}: 已同步 ${synced} 个文件/目录" -ForegroundColor Green
}

function Sync-EnvToDir {
  param([string]$TargetDir, [string]$ToolName)
  if (-not (Test-Path $script:EnvFile)) { return }
  $envTarget = Join-Path $TargetDir ".env"
  if ((Test-Path $envTarget)) {
    $srcHash = (Get-FileHash $script:EnvFile -Algorithm MD5).Hash
    $dstHash = (Get-FileHash $envTarget -Algorithm MD5).Hash
    if ($srcHash -ne $dstHash) {
      $ts = Get-Date -Format "yyyyMMddHHmmss"
      Copy-Item $envTarget "$envTarget.bak.$ts"
    }
  }
  Copy-Item $script:EnvFile $envTarget -Force
  Write-Host "  $([char]0x2714) ${ToolName}: .env 已同步" -ForegroundColor Green
}

function Select-SyncTargets {
  param([string]$PromptLabel, [array]$Detected)

  Write-Host ""
  Write-Host "--- $PromptLabel ---"
  Write-Host ""

  $srcVer = Get-LocalVersion $script:ScriptDir

  for ($i = 0; $i -lt $Detected.Count; $i++) {
    $tool = $Detected[$i]
    $ver = Get-LocalVersion $tool.Dir
    $verInfo = ""
    if ($ver -and $srcVer) {
      if ($ver -eq $srcVer) { $verInfo = " v${ver}（已是最新）" }
      else { $verInfo = " v${ver} -> v${srcVer}" }
    } elseif ($ver) { $verInfo = " v${ver}" }
    Write-Host "  $($i+1)) " -NoNewline; Write-Host "$($tool.Label)$verInfo" -ForegroundColor Cyan
    Write-Host "     $($tool.Dir)"
    Write-Host ""
  }

  Write-Host "  a) 全部"
  Write-Host "  0) 跳过"
  Write-Host ""

  $choice = Read-Host "请选择 [编号/a/0]"
  if ($choice -eq "0") { return @() }

  if ($choice -eq "a" -or $choice -eq "A") { return $Detected }

  $targets = @()
  foreach ($sel in ($choice -split ",")) {
    $idx = [int]$sel.Trim() - 1
    if ($idx -ge 0 -and $idx -lt $Detected.Count) { $targets += $Detected[$idx] }
  }
  return $targets
}

# ==================== 命令: check ====================

function Invoke-Check {
  Write-Host ""
  Write-Host "yw-enhance 版本检查" -ForegroundColor Cyan
  Write-Host ""

  $remoteInfo = Get-RemoteInfo
  $remoteVer = $remoteInfo.Version
  if (-not $remoteVer) {
    Write-Host "! 无法获取远程版本" -ForegroundColor Yellow
    $remoteVer = "unknown"
  } else {
    Write-Host "▸ 远程最新版本: $remoteVer" -ForegroundColor Blue
  }
  Write-Host ""

  $installed = Find-Installed
  if ($installed.Count -eq 0) {
    Write-Host "! 未检测到任何已安装的 yw-enhance" -ForegroundColor Yellow
    Write-Host "▸ 运行 .\install.ps1 进行安装" -ForegroundColor Blue
    return
  }

  foreach ($tool in $installed) {
    $localVer = Get-LocalVersion $tool.Dir
    if (-not $localVer) { $localVer = "unknown" }
    if ($remoteVer -ne "unknown" -and $localVer -ne "unknown") {
      Write-Host "  $($tool.Label): $localVer" -NoNewline
      if ($localVer -ne $remoteVer) {
        Write-Host " -> $remoteVer (有更新)" -ForegroundColor Yellow
      } else {
        Write-Host " (已是最新)" -ForegroundColor Green
      }
    } else {
      Write-Host "  $($tool.Label): $localVer"
    }
  }
  Write-Host ""
}

# ==================== 命令: install ====================

function Invoke-Install {
  param([string]$TargetTool)

  Write-Host ""
  Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Blue
  Write-Host "║  yw-enhance 安装 / 更新                     ║" -ForegroundColor Cyan
  Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Blue
  Write-Host ""

  Test-NodeInstalled | Out-Null

  # 先检查版本，提示是否有更新
  $remoteInfo = Get-RemoteInfo
  $remoteVer = $remoteInfo.Version
  if ($remoteVer) {
    Write-Host "▸ 远程最新版本: $remoteVer" -ForegroundColor Blue
  }

  $installed = Find-Installed

  if ($installed.Count -gt 0) {
    $hasUpdate = $false
    foreach ($tool in $installed) {
      $localVer = Get-LocalVersion $tool.Dir
      if ($remoteVer -and $localVer) {
        Write-Host ""
        if ($localVer -ne $remoteVer) {
          Write-Host "! $($tool.Label): $localVer -> $remoteVer (有更新)" -ForegroundColor Yellow
          $hasUpdate = $true
        } else {
          Write-Host "$([char]0x2714) $($tool.Label): $localVer (已是最新)" -ForegroundColor Green
        }
      }
    }

    if ($hasUpdate) {
      Write-Host ""
      $answer = Read-Host "是否更新到最新版本？(Y/n)"
      if ($answer -match '^[Nn]') {
        Write-Host "已取消更新"
        exit 0
      }
    }
  }
  Write-Host ""

  $sourceDir = $null; $needCleanup = $false

  if ((Test-Path (Join-Path $script:ScriptDir "scripts\youwen.js")) -and (Test-Path (Join-Path $script:ScriptDir "SKILL.md"))) {
    $sourceDir = $script:ScriptDir
    Write-Host "▸ 使用本地文件: $sourceDir" -ForegroundColor Blue
  } else {
    $sourceDir = Get-LatestSource
    $needCleanup = $true
    Write-Host "$([char]0x2714) 下载完成" -ForegroundColor Green
  }

  $newVer = Get-LocalVersion $sourceDir
  Write-Host "▸ 安装版本: $newVer" -ForegroundColor Blue
  Write-Host ""

  if ($TargetTool) {
    $tool = $script:ToolMap | Where-Object { $_.Key -eq $TargetTool }
    if (-not $tool) {
      Write-Host "$([char]0x2718) 未知工具: $TargetTool" -ForegroundColor Red
      Write-Host "  支持: $($script:ToolMap.Key -join ', ')"
      exit 1
    }
    Install-ToDir -SourceDir $sourceDir -TargetDir $tool.Dir -ToolName $tool.Label
  } else {
    $installed = Find-Installed
    if ($installed.Count -eq 0) {
      Write-Host "选择安装目标:"
      Write-Host ""
      for ($i = 0; $i -lt $script:ToolMap.Count; $i++) {
        Write-Host "  $($i+1)) $($script:ToolMap[$i].Label)"
      }
      Write-Host ""
      Write-Host "  a) 全部安装"
      Write-Host ""
      $choice = Read-Host "请选择 [1-$($script:ToolMap.Count)/a]"
      if ($choice -eq "a" -or $choice -eq "A") {
        foreach ($tool in $script:ToolMap) { Install-ToDir -SourceDir $sourceDir -TargetDir $tool.Dir -ToolName $tool.Label }
      } else {
        foreach ($sel in ($choice -split ",")) {
          $idx = [int]$sel.Trim() - 1
          if ($idx -ge 0 -and $idx -lt $script:ToolMap.Count) {
            Install-ToDir -SourceDir $sourceDir -TargetDir $script:ToolMap[$idx].Dir -ToolName $script:ToolMap[$idx].Label
          }
        }
      }
    } else {
      Write-Host "▸ 更新已安装的实例..." -ForegroundColor Blue
      Write-Host ""
      foreach ($tool in $installed) {
        $oldVer = Get-LocalVersion $tool.Dir
        Install-ToDir -SourceDir $sourceDir -TargetDir $tool.Dir -ToolName $tool.Label
        if ($oldVer -and $newVer -and $oldVer -ne $newVer) {
          Write-Host "  $oldVer -> $newVer" -ForegroundColor DarkGray
        }
      }
    }
  }

  if ($needCleanup -and $sourceDir) { Remove-Item (Split-Path $sourceDir) -Recurse -Force -ErrorAction SilentlyContinue }

  Write-Host ""
  Write-Host "$([char]0x2714) 完成" -ForegroundColor Green
  Write-Host ""
  Write-Host "  配置: .\install.ps1 -Setup" -ForegroundColor Cyan
  Write-Host "  测试: node scripts\youwen.js enhance `"测试`" --auto-confirm --no-search" -ForegroundColor Cyan
  Write-Host ""
}

# ==================== 命令: uninstall ====================

function Invoke-Uninstall {
  Write-Host ""
  Write-Host "yw-enhance 卸载" -ForegroundColor Cyan
  Write-Host ""

  $installed = Find-Installed
  if ($installed.Count -eq 0) {
    Write-Host "! 未检测到任何已安装的 yw-enhance" -ForegroundColor Yellow
    return
  }

  Write-Host "检测到以下安装:"
  Write-Host ""
  for ($i = 0; $i -lt $installed.Count; $i++) {
    Write-Host "  $($i+1)) $($installed[$i].Label)  $($installed[$i].Dir)"
  }
  Write-Host ""
  Write-Host "  a) 全部卸载"
  Write-Host "  0) 取消"
  Write-Host ""

  $choice = Read-Host "请选择 [编号/a/0]"
  if ($choice -eq "0") { Write-Host "已取消"; return }

  $targets = @()
  if ($choice -eq "a" -or $choice -eq "A") { $targets = $installed }
  else {
    foreach ($sel in ($choice -split ",")) {
      $idx = [int]$sel.Trim() - 1
      if ($idx -ge 0 -and $idx -lt $installed.Count) { $targets += $installed[$idx] }
    }
  }

  Write-Host ""
  foreach ($tool in $targets) {
    $envPath = Join-Path $tool.Dir ".env"
    if (Test-Path $envPath) {
      Copy-Item $envPath "$envPath.uninstall-backup"
      Write-Host "▸ 已备份 .env" -ForegroundColor Blue
    }
    Remove-Item $tool.Dir -Recurse -Force
    Write-Host "$([char]0x2714) 已卸载: $($tool.Label)" -ForegroundColor Green
  }
  Write-Host ""
}

# ==================== 命令: sync ====================

function Invoke-Sync {
  $detected = Find-OtherInstalls
  if ($detected.Count -eq 0) {
    Write-Host ""
    Write-Host "未检测到其他工具中安装的 yw-enhance skill" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "已扫描以下路径:"
    foreach ($tool in $script:ToolMap) { Write-Host "  . $($tool.Dir)" }
    Write-Host ""
    Write-Host "如需安装到新工具: .\install.ps1 -Target <工具名>"
    return
  }

  $targets = Select-SyncTargets -PromptLabel "同步 skill 脚本 + .env 到编程工具" -Detected $detected
  if ($targets.Count -eq 0) { Write-Host "已跳过"; return }

  Write-Host ""
  foreach ($tool in $targets) {
    Sync-FilesToDir -TargetDir $tool.Dir -ToolName $tool.Label
    Sync-EnvToDir -TargetDir $tool.Dir -ToolName $tool.Label
  }
  Write-Host ""
}

function Invoke-SyncEnv {
  if (-not (Test-Path $script:EnvFile)) {
    Write-Host "$([char]0x2718) .env 文件不存在，请先运行 .\install.ps1 -Setup" -ForegroundColor Red
    return
  }

  $detected = Find-OtherInstalls
  if ($detected.Count -eq 0) {
    Write-Host ""
    Write-Host "未检测到其他工具中安装的 yw-enhance skill" -ForegroundColor Yellow
    return
  }

  $targets = Select-SyncTargets -PromptLabel "同步 .env 到编程工具" -Detected $detected
  if ($targets.Count -eq 0) { Write-Host "已跳过"; return }

  Write-Host ""
  foreach ($tool in $targets) {
    Sync-EnvToDir -TargetDir $tool.Dir -ToolName $tool.Label
  }
  Write-Host ""
}

# ==================== 命令: setup ====================

function Invoke-Setup {
  param([switch]$ForceEdit, [switch]$ForceReset)

  Test-NodeInstalled | Out-Null
  Write-Host ""

  if ($ForceReset -and (Test-Path $script:EnvFile)) {
    $ts = Get-Date -Format "yyyyMMddHHmmss"
    Copy-Item $script:EnvFile "$($script:EnvFile).bak.$ts"
    Remove-Item $script:EnvFile
    Write-Host "已备份旧配置"
  }

  $fileVars = Read-EnvFile -Path $script:EnvFile
  $hasIssue = Test-AllEnvVars -FileVars $fileVars

  if ($ForceEdit -or $ForceReset -or $hasIssue) {
    Write-Host ""
    Write-Host "--- 交互式配置 ---"
    Write-Host ""
    Write-Host "按 Enter 保留当前值，输入新值覆盖"
    Write-Host ""

    foreach ($def in $script:EnvVarDefs) {
      $current = if ($fileVars.ContainsKey($def.Key)) { $fileVars[$def.Key] } else { $def.Default }
      $displayCurrent = $current
      if ($def.Secret -and $current) { $displayCurrent = Get-MaskedValue $current }
      if (-not $displayCurrent) { $displayCurrent = "(空)" }

      $reqTag = if ($def.Required) { " *必填*" } else { "" }
      $optTag = if ($def.Options.Count -gt 0) { " [$($def.Options -join '/')]" } else { "" }

      Write-Host "$($def.Label)${reqTag}${optTag}" -ForegroundColor Cyan
      Write-Host "  当前: $displayCurrent"
      $newVal = Read-Host "  新值"

      if ($newVal) {
        if ($def.Options.Count -gt 0 -and $newVal -notin $def.Options) {
          Write-Host "  ! 可选值: $($def.Options -join ', ')" -ForegroundColor Yellow
          $newVal = Read-Host "  重新输入"
          if (-not $newVal) { $newVal = $current }
        }
        if ($def.Key -eq "YOUWEN_API_URL" -and $newVal -and $newVal -notmatch '^https?://') {
          Write-Host "  ! 需要有效的 URL" -ForegroundColor Yellow
          $newVal = Read-Host "  重新输入"
          if (-not $newVal) { $newVal = $current }
        }
        $fileVars[$def.Key] = $newVal
      } elseif ($current) {
        $fileVars[$def.Key] = $current
      }
      Write-Host ""
    }

    Write-EnvFile -Path $script:EnvFile -Vars $fileVars
    Write-Host "$([char]0x2714) 配置已写入 $($script:EnvFile)" -ForegroundColor Green
    Write-Host ""

    $reloaded = Read-EnvFile -Path $script:EnvFile
    $null = Test-AllEnvVars -FileVars $reloaded

    $apiUrl = if ($reloaded.ContainsKey("YOUWEN_API_URL")) { $reloaded["YOUWEN_API_URL"] } else { "https://b.aigy.de" }
    $token = if ($reloaded.ContainsKey("YOUWEN_TOKEN")) { $reloaded["YOUWEN_TOKEN"] } else { "" }
    if ($token) { Test-BackendConnection -ApiUrl $apiUrl -Token $token }

    Invoke-Sync
  } else {
    Write-Host "所有配置项正常。"
    Write-Host ""
    $answer = Read-Host "是否要修改配置？(y/N)"
    if ($answer -match '^[Yy]') {
      Invoke-Setup -ForceEdit
    } else {
      Write-Host ""
      $detected = Find-OtherInstalls
      if ($detected.Count -gt 0) {
        $answer = Read-Host "是否同步 skill 脚本 + .env 到其他编程工具？(y/N)"
        if ($answer -match '^[Yy]') { Invoke-Sync }
      }
      Write-Host "提示: -Setup -Edit 强制编辑，-Sync 同步脚本+配置到其他工具"
      Write-Host ""
    }
  }
}

# ==================== 主入口 ====================

if ($Help) {
  Write-Host "yw-enhance 安装 / 更新 / 配置脚本"
  Write-Host ""
  Write-Host "用法:"
  Write-Host "  .\install.ps1                    # 安装或更新"
  Write-Host "  .\install.ps1 -Target claude     # 仅安装到指定工具"
  Write-Host "  .\install.ps1 -Check             # 检查版本"
  Write-Host "  .\install.ps1 -Uninstall         # 卸载"
  Write-Host "  .\install.ps1 -Setup             # 交互式配置环境变量"
  Write-Host "  .\install.ps1 -Setup -Edit       # 强制编辑配置"
  Write-Host "  .\install.ps1 -Setup -Reset      # 重置配置"
  Write-Host "  .\install.ps1 -Sync              # 同步脚本 + 配置到已安装目录"
  Write-Host "  .\install.ps1 -SyncEnv           # 仅同步 .env"
  Write-Host ""
  Write-Host "支持的工具: $($script:ToolMap.Key -join ', ')"
  exit 0
}

if ($Check) { Invoke-Check; exit 0 }
if ($Uninstall) { Invoke-Uninstall; exit 0 }
if ($Setup) { Invoke-Setup -ForceEdit:$Edit -ForceReset:$Reset; exit 0 }
if ($Sync) { Invoke-Sync; exit 0 }
if ($SyncEnv) { Invoke-SyncEnv; exit 0 }

# 默认: 安装/更新
Invoke-Install -TargetTool $Target
