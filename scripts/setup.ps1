<#
.SYNOPSIS
  yw-enhance 环境检查与配置脚本 (Windows PowerShell)

.DESCRIPTION
  检查并交互式填写 yw-enhance 所需的环境变量，写入 .env 文件，并支持同步到其他编程工具。

.EXAMPLE
  .\scripts\setup.ps1              # 交互式检查，有问题则引导填写
  .\scripts\setup.ps1 -Check       # 仅检查 + 连通性测试
  .\scripts\setup.ps1 -Edit        # 强制编辑（即使配置正常）
  .\scripts\setup.ps1 -Reset       # 备份旧 .env 后重新配置
  .\scripts\setup.ps1 -Sync        # 仅同步 .env 到已安装的 skill 目录
#>

param(
  [switch]$Check,
  [switch]$Edit,
  [switch]$Reset,
  [switch]$Sync,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$EnvFile = Join-Path $ProjectDir ".env"

# ==================== Node.js 检查 ====================

function Test-NodeInstalled {
  $nodePath = Get-Command node -ErrorAction SilentlyContinue
  if ($nodePath) {
    $nodeVer = & node -v 2>$null
    Write-Host "$([char]0x2714) Node.js 已安装: $nodeVer" -ForegroundColor Green
    return $true
  }

  Write-Host "$([char]0x2718) 未检测到 Node.js，yw-enhance 脚本无法运行" -ForegroundColor Red
  Write-Host ""
  Write-Host "请选择安装方式:"
  Write-Host "  1) winget (Windows 包管理器，推荐)"
  Write-Host "  2) Chocolatey"
  Write-Host "  3) fnm (Fast Node Manager)"
  Write-Host "  4) 官网下载 https://nodejs.org"
  Write-Host "  0) 跳过，稍后手动安装"
  Write-Host ""

  $choice = Read-Host "请输入选项 [0-4]"

  switch ($choice) {
    "1" {
      $winget = Get-Command winget -ErrorAction SilentlyContinue
      if (-not $winget) {
        Write-Host "! 未检测到 winget，请先安装 App Installer (Microsoft Store)" -ForegroundColor Yellow
        exit 1
      }
      Write-Host "正在通过 winget 安装 Node.js LTS..."
      & winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    }
    "2" {
      $choco = Get-Command choco -ErrorAction SilentlyContinue
      if (-not $choco) {
        Write-Host "正在安装 Chocolatey..." -ForegroundColor Yellow
        Set-ExecutionPolicy Bypass -Scope Process -Force
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
      }
      Write-Host "正在通过 Chocolatey 安装 Node.js LTS..."
      & choco install nodejs-lts -y
    }
    "3" {
      $fnm = Get-Command fnm -ErrorAction SilentlyContinue
      if (-not $fnm) {
        Write-Host "正在通过 winget 安装 fnm..."
        & winget install Schniz.fnm --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
      }
      Write-Host "正在通过 fnm 安装 Node.js LTS..."
      & fnm install --lts
      & fnm use lts-latest
    }
    "4" {
      Write-Host ""
      Write-Host "请访问 https://nodejs.org 下载安装后重新运行此脚本"
      exit 1
    }
    "0" {
      Write-Host ""
      Write-Host "! 跳过安装。请手动安装 Node.js 后重新运行此脚本" -ForegroundColor Yellow
      exit 1
    }
    default {
      Write-Host "无效选项，退出"
      exit 1
    }
  }

  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  $nodeCheck = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCheck) {
    $nodeVer = & node -v 2>$null
    Write-Host ""
    Write-Host "$([char]0x2714) Node.js 安装成功: $nodeVer" -ForegroundColor Green
    return $true
  } else {
    Write-Host "$([char]0x2718) Node.js 安装失败，请手动安装后重试" -ForegroundColor Red
    Write-Host "  可能需要重新打开终端使 PATH 生效"
    exit 1
  }
}

# ==================== 变量定义 ====================

$EnvVarDefs = @(
  @{ Key="YOUWEN_API_URL";      Label="后端 API 地址";              Default="https://b.aigy.de"; Required=$false; Secret=$false; Options=@() }
  @{ Key="YOUWEN_TOKEN";        Label="兑换码 / Token";             Default="";                  Required=$true;  Secret=$true;  Options=@() }
  @{ Key="YOUWEN_ENHANCE_MODE"; Label="增强模式";                   Default="agent";             Required=$false; Secret=$false; Options=@("agent","disabled") }
  @{ Key="YOUWEN_ENABLE_SEARCH";Label="启用联合搜索";               Default="true";              Required=$false; Secret=$false; Options=@("true","false") }
  @{ Key="YOUWEN_MGREP_API_KEY";Label="Mixedbread 语义检索 API Key";Default="";                  Required=$false; Secret=$true;  Options=@() }
  @{ Key="YOUWEN_CALL_MODE";    Label="调用模式";                   Default="smart";             Required=$false; Secret=$false; Options=@("smart","always") }
)

# ==================== 工具函数 ====================

function Read-EnvFile {
  param([string]$Path)
  $vars = @{}
  if (-not (Test-Path $Path)) { return $vars }

  foreach ($line in Get-Content $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -match '^(\w+)\s*=\s*(.*)$') {
      $k = $Matches[1]
      $v = $Matches[2].Trim().Trim('"').Trim("'")
      $vars[$k] = $v
    }
  }
  return $vars
}

function Write-EnvFile {
  param([string]$Path, [hashtable]$Vars)

  $lines = @(
    "# yw-enhance 配置文件"
    "# 由 setup.ps1 自动生成"
    "# 生成时间: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
    ""
  )

  foreach ($def in $script:EnvVarDefs) {
    $val = if ($Vars.ContainsKey($def.Key)) { $Vars[$def.Key] } else { $def.Default }
    $reqTag = if ($def.Required) { " (必填)" } else { "" }
    $optTag = if ($def.Options.Count -gt 0) { " [$($def.Options -join '/')]" } else { "" }

    $lines += "# $($def.Label)${reqTag}${optTag}"
    if ($val) {
      $lines += "$($def.Key)=$val"
    } else {
      $lines += "# $($def.Key)="
    }
    $lines += ""
  }

  $lines | Out-File -FilePath $Path -Encoding UTF8 -Force
}

function Get-MaskedValue {
  param([string]$Val)
  if (-not $Val -or $Val.Length -le 4) { return "****" }
  return $Val.Substring(0,2) + ("*" * ($Val.Length - 4)) + $Val.Substring($Val.Length - 2)
}

# ==================== 检查逻辑 ====================

function Test-AllVars {
  param([hashtable]$FileVars)

  $hasIssue = $false

  Write-Host ""
  Write-Host ([char]0x256D) -NoNewline; Write-Host ("-" * 41) -NoNewline; Write-Host ([char]0x256E)
  Write-Host ([char]0x2502) -NoNewline; Write-Host "     yw-enhance 环境配置检查              " -NoNewline; Write-Host ([char]0x2502)
  Write-Host ([char]0x2570) -NoNewline; Write-Host ("-" * 41) -NoNewline; Write-Host ([char]0x256F)
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
      $icon = [char]0x2718; $color = "Red"; $statusMsg = "-> 必填项未配置"
      $hasIssue = $true
    } elseif ($def.Options.Count -gt 0 -and $effective -and $effective -notin $def.Options) {
      $icon = "!"; $color = "Yellow"; $statusMsg = "-> 可选值: $($def.Options -join ', ')"
      $hasIssue = $true
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

# ==================== 连通性测试 ====================

function Test-BackendConnection {
  param([string]$ApiUrl, [string]$Token)

  Write-Host "🔗 测试后端连通性..." -NoNewline

  try {
    $headers = @{ "Accept" = "application/json" }
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }

    $uri = "$ApiUrl/api/skill/version?name=yw-enhance"
    $response = Invoke-WebRequest -Uri $uri -Headers $headers -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop

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

# ==================== Skill 同步 ====================

$SkillToolMap = @(
  @{ Name="Claude Code"; Dir=Join-Path $env:USERPROFILE ".claude\skills\yw-enhance" }
  @{ Name="OpenCode";    Dir=Join-Path $env:USERPROFILE ".config\opencode\skill\yw-enhance" }
  @{ Name="Cursor";      Dir=Join-Path $env:USERPROFILE ".cursor\skills\yw-enhance" }
  @{ Name="Windsurf";    Dir=Join-Path $env:USERPROFILE ".windsurf\skills\yw-enhance" }
  @{ Name="Cline";       Dir=Join-Path $env:USERPROFILE ".cline\skills\yw-enhance" }
  @{ Name="Continue";    Dir=Join-Path $env:USERPROFILE ".continue\skills\yw-enhance" }
  @{ Name="Codium";      Dir=Join-Path $env:USERPROFILE ".codium\skills\yw-enhance" }
  @{ Name="Aider";       Dir=Join-Path $env:USERPROFILE ".aider\skills\yw-enhance" }
)

function Find-SkillDirs {
  $detected = @()
  $projectReal = (Resolve-Path $ProjectDir -ErrorAction SilentlyContinue).Path

  foreach ($tool in $script:SkillToolMap) {
    $dir = $tool.Dir
    if (-not (Test-Path $dir)) { continue }
    $hasSkill = (Test-Path (Join-Path $dir "SKILL.md")) -or (Test-Path (Join-Path $dir "scripts\youwen.js"))
    if (-not $hasSkill) { continue }

    $dirReal = (Resolve-Path $dir -ErrorAction SilentlyContinue).Path
    if ($dirReal -eq $projectReal) { continue }

    $detected += @{ Name=$tool.Name; Dir=$dir }
  }
  return $detected
}

function Sync-EnvToSkills {
  param([hashtable]$FileVars)

  if (-not (Test-Path $EnvFile)) {
    Write-Host "$([char]0x2718) 项目 .env 文件不存在，请先完成配置" -ForegroundColor Red
    return
  }

  $detected = Find-SkillDirs

  if ($detected.Count -eq 0) {
    Write-Host ""
    Write-Host "未检测到其他工具中安装的 yw-enhance skill" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "已扫描以下路径:"
    foreach ($tool in $script:SkillToolMap) {
      Write-Host "  . $($tool.Dir)"
    }
    Write-Host ""
    Write-Host "如需同步到自定义路径，请手动复制:"
    Write-Host "  Copy-Item `"$EnvFile`" `"<目标skill目录>\.env`""
    return
  }

  Write-Host ""
  Write-Host "--- 同步 .env 到编程工具 ---"
  Write-Host ""
  Write-Host "检测到以下工具中安装了 yw-enhance:"
  Write-Host ""

  for ($i = 0; $i -lt $detected.Count; $i++) {
    $tool = $detected[$i]
    $envTarget = Join-Path $tool.Dir ".env"
    $statusIcon = "."; $statusText = "未同步"

    if (Test-Path $envTarget) {
      $srcHash = (Get-FileHash $EnvFile -Algorithm MD5).Hash
      $dstHash = (Get-FileHash $envTarget -Algorithm MD5).Hash
      if ($srcHash -eq $dstHash) {
        $statusIcon = "$([char]0x2714)"; $statusText = "已同步（一致）"
      } else {
        $statusIcon = "!"; $statusText = "已有 .env（内容不同）"
      }
    }

    Write-Host "  $($i+1)) " -NoNewline; Write-Host "$($tool.Name)" -ForegroundColor Cyan
    Write-Host "     $($tool.Dir)"
    Write-Host "     $statusIcon $statusText"
    Write-Host ""
  }

  Write-Host "  a) 全部同步"
  Write-Host "  0) 跳过"
  Write-Host ""

  $choice = Read-Host "请选择要同步的工具 [编号/a/0]"

  if ($choice -eq "0") {
    Write-Host "已跳过同步"
    return
  }

  $targets = @()
  if ($choice -eq "a" -or $choice -eq "A") {
    $targets = $detected
  } else {
    foreach ($sel in ($choice -split ",")) {
      $idx = [int]$sel.Trim() - 1
      if ($idx -ge 0 -and $idx -lt $detected.Count) {
        $targets += $detected[$idx]
      }
    }
  }

  if ($targets.Count -eq 0) {
    Write-Host "无有效选择"
    return
  }

  Write-Host ""
  foreach ($tool in $targets) {
    $envTarget = Join-Path $tool.Dir ".env"

    # 备份已有的不同 .env
    if (Test-Path $envTarget) {
      $srcHash = (Get-FileHash $EnvFile -Algorithm MD5).Hash
      $dstHash = (Get-FileHash $envTarget -Algorithm MD5).Hash
      if ($srcHash -ne $dstHash) {
        $timestamp = Get-Date -Format "yyyyMMddHHmmss"
        Copy-Item $envTarget "$envTarget.bak.$timestamp"
      }
    }

    Copy-Item $EnvFile $envTarget -Force
    Write-Host "  " -NoNewline
    Write-Host "$([char]0x2714)" -ForegroundColor Green -NoNewline
    Write-Host " 已同步到 " -NoNewline
    Write-Host "$($tool.Name)" -ForegroundColor Cyan -NoNewline
    Write-Host ": $envTarget"
  }
  Write-Host ""
}

# ==================== 交互式配置 ====================

function Start-InteractiveSetup {
  param([hashtable]$FileVars)

  Write-Host ""
  Write-Host "--- 交互式配置 ---"
  Write-Host ""
  Write-Host "按 Enter 保留当前值，输入新值覆盖"
  Write-Host ""

  foreach ($def in $script:EnvVarDefs) {
    $current = if ($FileVars.ContainsKey($def.Key)) { $FileVars[$def.Key] } else { $def.Default }
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
        Write-Host "  ! 需要有效的 URL (http:// 或 https://)" -ForegroundColor Yellow
        $newVal = Read-Host "  重新输入"
        if (-not $newVal) { $newVal = $current }
      }
      $FileVars[$def.Key] = $newVal
    } elseif ($current) {
      $FileVars[$def.Key] = $current
    }

    Write-Host ""
  }

  # 写入 .env
  Write-EnvFile -Path $EnvFile -Vars $FileVars
  Write-Host "$([char]0x2714) 配置已写入 $EnvFile" -ForegroundColor Green
  Write-Host ""

  # 重新加载并展示最终结果
  $reloaded = Read-EnvFile -Path $EnvFile
  $null = Test-AllVars -FileVars $reloaded

  # 连通性测试
  $apiUrl = if ($reloaded.ContainsKey("YOUWEN_API_URL")) { $reloaded["YOUWEN_API_URL"] } else { "https://b.aigy.de" }
  $token = if ($reloaded.ContainsKey("YOUWEN_TOKEN")) { $reloaded["YOUWEN_TOKEN"] } else { "" }
  if ($token) { Test-BackendConnection -ApiUrl $apiUrl -Token $token }

  # 同步到其他工具
  Sync-EnvToSkills -FileVars $reloaded
}

# ==================== 主流程 ====================

if ($Help) {
  Write-Host "用法:"
  Write-Host "  .\scripts\setup.ps1              # 交互式检查，有问题则引导填写"
  Write-Host "  .\scripts\setup.ps1 -Check       # 仅检查 + 连通性测试"
  Write-Host "  .\scripts\setup.ps1 -Edit        # 强制编辑（即使配置正常）"
  Write-Host "  .\scripts\setup.ps1 -Reset       # 备份旧 .env 后重新配置"
  Write-Host "  .\scripts\setup.ps1 -Sync        # 仅同步 .env 到已安装的 skill 目录"
  exit 0
}

# Node.js 前置检查
Test-NodeInstalled | Out-Null
Write-Host ""

# -Sync: 仅同步
if ($Sync) {
  $fileVars = Read-EnvFile -Path $EnvFile
  Sync-EnvToSkills -FileVars $fileVars
  exit 0
}

# -Reset: 备份旧文件
if ($Reset -and (Test-Path $EnvFile)) {
  $timestamp = Get-Date -Format "yyyyMMddHHmmss"
  $backupPath = "$EnvFile.bak.$timestamp"
  Copy-Item $EnvFile $backupPath
  Remove-Item $EnvFile
  Write-Host "已备份旧配置到 $(Split-Path -Leaf $backupPath)"
}

$fileVars = Read-EnvFile -Path $EnvFile

# -Check: 仅检查
if ($Check) {
  $hasIssue = Test-AllVars -FileVars $fileVars
  $apiUrl = if ($fileVars.ContainsKey("YOUWEN_API_URL")) { $fileVars["YOUWEN_API_URL"] } else { "https://b.aigy.de" }
  $token = if ($fileVars.ContainsKey("YOUWEN_TOKEN")) { $fileVars["YOUWEN_TOKEN"] } else { "" }
  Test-BackendConnection -ApiUrl $apiUrl -Token $token
  if ($hasIssue) { exit 1 } else { exit 0 }
}

# 先展示当前状态
$hasIssue = Test-AllVars -FileVars $fileVars

# -Edit / -Reset: 强制进入编辑
if ($Edit -or $Reset) {
  Start-InteractiveSetup -FileVars $fileVars
  exit 0
}

# 交互模式: 有问题直接进入编辑，没问题则询问
if ($hasIssue) {
  Start-InteractiveSetup -FileVars $fileVars
} else {
  Write-Host "所有配置项正常。"
  Write-Host ""
  $answer = Read-Host "是否要修改配置？(y/N)"
  if ($answer -match '^[Yy]') {
    Start-InteractiveSetup -FileVars $fileVars
  } else {
    Write-Host ""
    $detected = Find-SkillDirs
    if ($detected.Count -gt 0) {
      $answer = Read-Host "是否同步 .env 到其他编程工具？(y/N)"
      if ($answer -match '^[Yy]') {
        Sync-EnvToSkills -FileVars $fileVars
      }
    }
    Write-Host "提示: 使用 -Check 测试连通性，-Edit 强制编辑，-Sync 同步到其他工具"
    Write-Host ""
  }
}
