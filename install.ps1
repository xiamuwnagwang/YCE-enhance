<#
.SYNOPSIS
  YCE 一键安装 / 更新 / 配置脚本 (Windows PowerShell 5.1+)

.DESCRIPTION
  合并了安装、更新、配置、同步、卸载功能的统一脚本。
  尽量使用 PowerShell 5.1 兼容写法，避免依赖 PowerShell 7 专属语法。

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Install
  .\install.ps1 -Target agents
  .\install.ps1 -Check
  .\install.ps1 -Setup -YceToken "your-token"
  .\install.ps1 -Setup -YceToken "your-token" -YceUrl "https://your-augment-request-url"
  .\install.ps1 -Sync
  .\install.ps1 -SyncEnv
  .\install.ps1 -Uninstall
#>

param(
  [switch]$Install,
  [switch]$Check,
  [switch]$Uninstall,
  [switch]$Setup,
  [switch]$Sync,
  [switch]$SyncEnv,
  [switch]$DryRun,
  [switch]$Edit,
  [switch]$Reset,
  [string]$Target,
  [string]$YceUrl,
  [string]$YceToken,
  [string]$YouwenScript,
  [string]$YouwenApiUrl,
  [string]$YouwenToken,
  [string]$YouwenEnhanceMode,
  [string]$YouwenEnableSearch,
  [string]$YouwenMgrepApiKey,
  [string]$YceSearchScript,
  [string]$YceBinary,
  [string]$YceMaxLinesPerBlob,
  [string]$YceUploadTimeout,
  [string]$YceUploadConcurrency,
  [string]$YceRetrievalTimeout,
  [string]$YceNoAdaptive,
  [string]$YceNoWebbrowserEnhancePrompt,
  [string]$Mode,
  [string]$TimeoutEnhance,
  [string]$TimeoutSearch,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".env"
$YceCfgFile = Join-Path $ScriptDir "vendor\yce-tool.json"
$RepoUrl = "https://github.com/xiamuwnagwang/YCE-enhance"
$RepoArchiveFallbackZip = "https://github.com/xiamuwnagwang/YCE-enhance/archive/refs/heads/main.zip"
$RemoteSkillMdUrl = "https://raw.githubusercontent.com/xiamuwnagwang/YCE-enhance/main/SKILL.md"
$SkillName = "yce"

$DefaultYouwenApiUrl = "https://a.aigy.de"
$DefaultYouwenEnhanceMode = "agent"
$DefaultYouwenEnableSearch = "true"
$DefaultYouwenMgrepApiKey = ""
$DefaultYceUrl = "https://yce.aigy.de/"
$DefaultYceMaxLinesPerBlob = "800"
$DefaultYceUploadTimeout = ""
$DefaultYceUploadConcurrency = ""
$DefaultYceRetrievalTimeout = "60"
$DefaultYceNoAdaptive = "false"
$DefaultYceNoWebbrowserEnhancePrompt = "false"
$DefaultMode = "auto"
$DefaultTimeoutEnhance = "300000"
$DefaultTimeoutSearch = "180000"
$DefaultYouwenScript = ".\scripts\youwen.js"
$DefaultYceSearchScript = ".\scripts\yce-search.ps1"
$DefaultYceBinary = ".\vendor\windows-x64\yce-tool-rs.exe"
$DefaultYceConfig = ".\vendor\yce-tool.json"
$InstallFiles = @("scripts", "vendor", "SKILL.md", "install.sh", "install.ps1", ".env.example", ".gitignore")

function Initialize-NetworkDefaults {
  try {
    $tls12 = [System.Net.SecurityProtocolType]::Tls12
    if ([enum]::GetNames([System.Net.SecurityProtocolType]) -contains 'Tls11') {
      $tls12 = $tls12 -bor [System.Net.SecurityProtocolType]::Tls11
    }
    if ([enum]::GetNames([System.Net.SecurityProtocolType]) -contains 'Tls') {
      $tls12 = $tls12 -bor [System.Net.SecurityProtocolType]::Tls
    }
    [System.Net.ServicePointManager]::SecurityProtocol = $tls12
  } catch {
    # 保持默认，避免在旧环境里因为 TLS 设置本身报错
  }
}

function Invoke-WebRequestSafe {
  param(
    [Parameter(Mandatory=$true)][string]$Uri,
    [string]$OutFile,
    [int]$TimeoutSec = 30,
    [int]$MaxAttempts = 3
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      $params = @{
        Uri = $Uri
        UseBasicParsing = $true
        TimeoutSec = $TimeoutSec
        ErrorAction = 'Stop'
      }
      if ($OutFile) {
        $params.OutFile = $OutFile
      }
      return Invoke-WebRequest @params
    } catch {
      if ($attempt -ge $MaxAttempts) {
        throw
      }
      Start-Sleep -Seconds ([Math]::Min($attempt * 2, 5))
    }
  }
}

Initialize-NetworkDefaults

function Write-Info([string]$Message) { Write-Host "▸ $Message" -ForegroundColor Blue }
function Write-Ok([string]$Message) { Write-Host "$([char]0x2714) $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "! $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "$([char]0x2718) $Message" -ForegroundColor Red }
function Write-DryRun([string]$Message) { Write-Host "[DryRun] $Message" -ForegroundColor Yellow }

function Write-Utf8NoBomLines {
  param(
    [string]$FilePath,
    [string[]]$Lines
  )

  $content = [string]::Join([Environment]::NewLine, $Lines) + [Environment]::NewLine
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($FilePath, $content, $utf8NoBom)
}

function Expand-HomePath {
  param([string]$PathValue)
  if (-not $PathValue) { return $PathValue }
  if ($PathValue -eq "~") { return $env:USERPROFILE }
  if ($PathValue.StartsWith("~/") -or $PathValue.StartsWith('~\')) {
    return Join-Path $env:USERPROFILE $PathValue.Substring(2)
  }
  return $PathValue
}

function Resolve-YcePath {
  param([string]$PathValue)
  $expanded = Expand-HomePath $PathValue
  if (-not $expanded) { return $expanded }
  if ([System.IO.Path]::IsPathRooted($expanded)) { return $expanded }
  return Join-Path $ScriptDir $expanded.TrimStart('.','\','/')
}

function Read-EnvValueFromFile {
  param(
    [string]$FilePath,
    [string]$Key
  )
  if (-not $FilePath -or -not (Test-Path $FilePath)) { return $null }
  foreach ($line in Get-Content $FilePath -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    if ($trimmed -match '^(\w+)\s*=\s*(.*)$' -and $Matches[1] -eq $Key) {
      return $Matches[2].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Get-YouwenEnvFile {
  param([string]$YouwenScriptPath)
  $resolved = Resolve-YcePath $YouwenScriptPath
  if (-not $resolved -or -not (Test-Path $resolved)) { return $null }
  $scriptsDir = Split-Path -Parent $resolved
  $skillDir = Split-Path -Parent $scriptsDir
  $envPath = Join-Path $skillDir ".env"
  if (Test-Path $envPath) { return $envPath }
  return $null
}

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

function Compare-SemVer {
  param([string]$A, [string]$B)
  $pa = $A.Split('.')
  $pb = $B.Split('.')
  for ($i = 0; $i -lt 3; $i++) {
    $va = 0
    $vb = 0
    if ($i -lt $pa.Length) { [void][int]::TryParse($pa[$i], [ref]$va) }
    if ($i -lt $pb.Length) { [void][int]::TryParse($pb[$i], [ref]$vb) }
    if ($va -lt $vb) { return -1 }
    if ($va -gt $vb) { return 1 }
  }
  return 0
}

function Get-RemoteVersion {
  try {
    $response = Invoke-WebRequestSafe -Uri $RemoteSkillMdUrl -TimeoutSec 10 -MaxAttempts 2
    $match = [regex]::Match($response.Content, '^version:\s*(.+)$', [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
  } catch {}
  return $null
}

function Read-ExistingYceConfig {
  if (-not (Test-Path $YceCfgFile)) { return $null }
  try {
    $raw = Get-Content $YceCfgFile -Raw -Encoding UTF8
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-LatestSource {
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "yce-$(Get-Random)"
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

  Write-Info "下载最新 YCE..."
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $repoDir = Join-Path $tmpDir "repo"
    try {
      & git clone --depth 1 "$($RepoUrl).git" $repoDir 2>$null
      if ($LASTEXITCODE -eq 0) { return $repoDir }
    } catch {}
  }

  $zipPath = Join-Path $tmpDir "repo.zip"
  $extractDir = Join-Path $tmpDir "extract"
  try {
    Invoke-WebRequestSafe -Uri $RepoArchiveFallbackZip -OutFile $zipPath -TimeoutSec 30 -MaxAttempts 3 | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    $repoCandidate = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
    if ($repoCandidate) {
      $repoDir = Join-Path $tmpDir "repo"
      Move-Item $repoCandidate.FullName $repoDir -Force
      return $repoDir
    }
  } catch {}

  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Fail "下载失败: $RepoUrl"
  exit 1
}

function Test-NodeInstalled {
  $nodePath = Get-Command node -ErrorAction SilentlyContinue
  if ($nodePath) {
    $nodeVer = & node -v 2>$null
    Write-Ok "Node.js $nodeVer"
    return $true
  }
  Write-Fail "未安装 Node.js（需要 v16+）"
  exit 1
}

function Get-ToolMap {
  $toolMap = @(
    @{ Key="claude";   Label="Claude Code"; Dir=Join-Path $env:USERPROFILE ".claude\skills\$SkillName" }
    @{ Key="opencode"; Label="OpenCode";    Dir=Join-Path $env:USERPROFILE ".config\opencode\skills\$SkillName" }
    @{ Key="cursor";   Label="Cursor";      Dir=Join-Path $env:USERPROFILE ".cursor\skills\$SkillName" }
    @{ Key="windsurf"; Label="Windsurf";    Dir=Join-Path $env:USERPROFILE ".windsurf\skills\$SkillName" }
    @{ Key="cline";    Label="Cline";       Dir=Join-Path $env:USERPROFILE ".cline\skills\$SkillName" }
    @{ Key="continue"; Label="Continue";    Dir=Join-Path $env:USERPROFILE ".continue\skills\$SkillName" }
    @{ Key="codium";   Label="Codium";      Dir=Join-Path $env:USERPROFILE ".codium\skills\$SkillName" }
    @{ Key="aider";    Label="Aider";       Dir=Join-Path $env:USERPROFILE ".aider\skills\$SkillName" }
    @{ Key="codex";    Label="Codex";       Dir=Join-Path $env:USERPROFILE ".codex\skills\$SkillName" }
  )

  $agentsSkillsPath = Join-Path $env:USERPROFILE ".agents\skills"
  if (Test-Path $agentsSkillsPath) {
    $agentsTool = @{ Key="agents"; Label=".agents"; Dir=Join-Path $agentsSkillsPath $SkillName }
    $toolMap = @($toolMap[0]) + @($agentsTool) + $toolMap[1..($toolMap.Length-1)]
  }
  return $toolMap
}

$ToolMap = Get-ToolMap

function Find-Installed {
  $found = @()
  $seenPaths = @{}
  foreach ($tool in $ToolMap) {
    if ((Test-Path $tool.Dir) -and (Test-Path (Join-Path $tool.Dir "SKILL.md"))) {
      $realPath = (Resolve-Path $tool.Dir -ErrorAction SilentlyContinue).Path
      if ($realPath -and -not $seenPaths.ContainsKey($realPath)) {
        $found += $tool
        $seenPaths[$realPath] = $true
      }
    }
  }
  return $found
}

function Find-OtherInstalls {
  $selfReal = (Resolve-Path $ScriptDir -ErrorAction SilentlyContinue).Path
  $detected = @()
  $seenPaths = @{}
  foreach ($tool in $ToolMap) {
    if (-not (Test-Path $tool.Dir)) { continue }
    if (-not (Test-Path (Join-Path $tool.Dir "SKILL.md"))) { continue }
    $dirReal = (Resolve-Path $tool.Dir -ErrorAction SilentlyContinue).Path
    if ($dirReal -and $dirReal -ne $selfReal -and -not $seenPaths.ContainsKey($dirReal)) {
      $detected += $tool
      $seenPaths[$dirReal] = $true
    }
  }
  return $detected
}

function Install-ToDir {
  param([string]$SourceDir, [string]$TargetDir, [string]$ToolName)

  $sourceReal = (Resolve-Path $SourceDir -ErrorAction SilentlyContinue).Path
  $targetReal = (Resolve-Path $TargetDir -ErrorAction SilentlyContinue).Path
  if (-not $targetReal) { $targetReal = $TargetDir }

  if ($sourceReal -eq $targetReal) {
    Write-Ok "${ToolName}: 已是当前目录"
    return
  }

  if ($DryRun) {
    Write-DryRun "将安装/更新到 ${ToolName}"
    Write-DryRun "  SourceDir = $SourceDir"
    Write-DryRun "  TargetDir = $TargetDir"
    Write-DryRun "  保留目标 .env 和 vendor/yce-tool.json（如果存在）"
    return
  }

  $envBackup = $null
  $yceCfgBackup = $null
  $envTarget = Join-Path $TargetDir ".env"
  $yceCfgTarget = Join-Path $TargetDir "vendor\yce-tool.json"
  if (Test-Path $envTarget) {
    $envBackup = [System.IO.Path]::GetTempFileName()
    Copy-Item $envTarget $envBackup -Force
  }
  if (Test-Path $yceCfgTarget) {
    $yceCfgBackup = [System.IO.Path]::GetTempFileName()
    Copy-Item $yceCfgTarget $yceCfgBackup -Force
  }

  if (-not (Test-Path $TargetDir)) { New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null }

  foreach ($item in $InstallFiles) {
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
  } elseif ((Test-Path (Join-Path $TargetDir '.env.example')) -and -not (Test-Path $envTarget)) {
    Copy-Item (Join-Path $TargetDir '.env.example') $envTarget -Force
  }

  if ($yceCfgBackup -and (Test-Path $yceCfgBackup)) {
    $yceCfgParent = Split-Path -Parent $yceCfgTarget
    if (-not (Test-Path $yceCfgParent)) { New-Item -ItemType Directory -Path $yceCfgParent -Force | Out-Null }
    Copy-Item $yceCfgBackup $yceCfgTarget -Force
    Remove-Item $yceCfgBackup -Force
  }

  Write-Ok "${ToolName}: 已安装/更新"
}

function Sync-EnvToDir {
  param([string]$TargetDir, [string]$ToolName)

  if ($DryRun) {
    Write-DryRun "将同步配置到 ${ToolName}"
    Write-DryRun "  TargetDir = $TargetDir"
    Write-DryRun "  .env => $(Join-Path $TargetDir '.env')"
    Write-DryRun "  yce-tool.json => $(Join-Path $TargetDir 'vendor\\yce-tool.json')"
    return
  }

  if (Test-Path $EnvFile) {
    $envTarget = Join-Path $TargetDir ".env"
    if (-not (Test-Path $TargetDir)) { New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null }
    Copy-Item $EnvFile $envTarget -Force
    Write-Host "  $([char]0x2714) ${ToolName}: .env 已同步" -ForegroundColor Green
  }

  if (Test-Path $YceCfgFile) {
    $yceTargetDir = Join-Path $TargetDir "vendor"
    if (-not (Test-Path $yceTargetDir)) { New-Item -ItemType Directory -Path $yceTargetDir -Force | Out-Null }
    Copy-Item $YceCfgFile (Join-Path $yceTargetDir "yce-tool.json") -Force
    Write-Host "  $([char]0x2714) ${ToolName}: vendor/yce-tool.json 已同步" -ForegroundColor Green
  }
}

function Select-SyncTargets {
  param([string]$PromptLabel, [array]$Detected)

  Write-Host ""
  Write-Host "--- $PromptLabel ---"
  Write-Host ""

  for ($i = 0; $i -lt $Detected.Count; $i++) {
    Write-Host "  $($i+1)) " -NoNewline
    Write-Host $Detected[$i].Label -ForegroundColor Cyan
    Write-Host "     $($Detected[$i].Dir)"
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
    $trimmed = $sel.Trim()
    if (-not $trimmed) { continue }
    $idx = [int]$trimmed - 1
    if ($idx -ge 0 -and $idx -lt $Detected.Count) { $targets += $Detected[$idx] }
  }
  return $targets
}

function Write-RuntimeConfig {
  param(
    [string]$RuntimeYceToken,
    [string]$RuntimeYceUrl,
    [string]$RuntimeYouwenScript,
    [string]$RuntimeYouwenApiUrl,
    [string]$RuntimeYouwenToken,
    [string]$RuntimeYouwenEnhanceMode,
    [string]$RuntimeYouwenEnableSearch,
    [string]$RuntimeYouwenMgrepApiKey,
    [string]$RuntimeYceSearchScript,
    [string]$RuntimeYceBinary,
    [string]$RuntimeYceMaxLinesPerBlob,
    [string]$RuntimeYceUploadTimeout,
    [string]$RuntimeYceUploadConcurrency,
    [string]$RuntimeYceRetrievalTimeout,
    [string]$RuntimeYceNoAdaptive,
    [string]$RuntimeYceNoWebbrowserEnhancePrompt,
    [string]$RuntimeMode,
    [string]$RuntimeTimeoutEnhance,
    [string]$RuntimeTimeoutSearch
  )

  if (-not $RuntimeYceToken) {
    Write-Fail "-YceToken 是必填项"
    exit 1
  }

  $resolvedYouwen = Resolve-YcePath $RuntimeYouwenScript
  $resolvedSearch = Resolve-YcePath $RuntimeYceSearchScript
  $resolvedBinary = Resolve-YcePath $RuntimeYceBinary

  if (-not $RuntimeYouwenScript) {
    Write-Warn "未检测到仓内 yce enhance 脚本: $DefaultYouwenScript"
  } elseif (-not (Test-Path $resolvedYouwen)) {
    Write-Warn "youwen.js 不存在: $RuntimeYouwenScript"
  }
  if (-not (Test-Path $resolvedSearch)) { Write-Warn "yce search wrapper 不存在: $RuntimeYceSearchScript" }
  if (-not (Test-Path $resolvedBinary)) { Write-Warn "yce-tool-rs 不存在: $RuntimeYceBinary" }

  if ($DryRun) {
    Write-DryRun "将生成 .env 和 vendor/yce-tool.json"
    Write-DryRun "  .env => $EnvFile"
    Write-DryRun "  yce-tool.json => $YceCfgFile"
    Write-DryRun "  YCE_YOUWEN_SCRIPT = $RuntimeYouwenScript"
    Write-DryRun "  YCE_YOUWEN_API_URL = $RuntimeYouwenApiUrl"
    Write-DryRun "  YCE_YOUWEN_TOKEN = $(if ($RuntimeYouwenToken) { Get-MaskedValue $RuntimeYouwenToken } else { '(empty)' })"
    Write-DryRun "  YCE_YOUWEN_ENHANCE_MODE = $RuntimeYouwenEnhanceMode"
    Write-DryRun "  YCE_YOUWEN_ENABLE_SEARCH = $RuntimeYouwenEnableSearch"
    Write-DryRun "  YCE_YOUWEN_MGREP_API_KEY = $(if ($RuntimeYouwenMgrepApiKey) { Get-MaskedValue $RuntimeYouwenMgrepApiKey } else { '(empty)' })"
    Write-DryRun "  YCE_SEARCH_SCRIPT = $RuntimeYceSearchScript"
    Write-DryRun "  YCE_BINARY = $RuntimeYceBinary"
    Write-DryRun "  YCE_MAX_LINES_PER_BLOB = $RuntimeYceMaxLinesPerBlob"
    Write-DryRun "  YCE_UPLOAD_TIMEOUT = $RuntimeYceUploadTimeout"
    Write-DryRun "  YCE_UPLOAD_CONCURRENCY = $RuntimeYceUploadConcurrency"
    Write-DryRun "  YCE_RETRIEVAL_TIMEOUT = $RuntimeYceRetrievalTimeout"
    Write-DryRun "  YCE_NO_ADAPTIVE = $RuntimeYceNoAdaptive"
    Write-DryRun "  YCE_NO_WEBBROWSER_ENHANCE_PROMPT = $RuntimeYceNoWebbrowserEnhancePrompt"
    Write-DryRun "  YCE_DEFAULT_MODE = $RuntimeMode"
    Write-DryRun "  YCE_TIMEOUT_ENHANCE_MS = $RuntimeTimeoutEnhance"
    Write-DryRun "  YCE_TIMEOUT_SEARCH_MS = $RuntimeTimeoutSearch"
    Write-DryRun "  Yce base_url = $RuntimeYceUrl"
    Write-DryRun "  Yce token = $(Get-MaskedValue $RuntimeYceToken)"
    return
  }

  Write-Host "Generating .env..."
  Write-Utf8NoBomLines -FilePath $EnvFile -Lines @(
    "# YCE runtime configuration"
    "# Generated at $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
    ""
    "# yw-enhance adapter"
    "YCE_YOUWEN_SCRIPT=$RuntimeYouwenScript"
    "YCE_YOUWEN_API_URL=$RuntimeYouwenApiUrl"
    "YCE_YOUWEN_TOKEN=$RuntimeYouwenToken"
    "YCE_YOUWEN_ENHANCE_MODE=$RuntimeYouwenEnhanceMode"
    "YCE_YOUWEN_ENABLE_SEARCH=$RuntimeYouwenEnableSearch"
    "YCE_YOUWEN_MGREP_API_KEY=$RuntimeYouwenMgrepApiKey"
    ""
    "# yce adapter"
    "YCE_SEARCH_SCRIPT=$RuntimeYceSearchScript"
    "YCE_BINARY=$RuntimeYceBinary"
    "YCE_CONFIG=./vendor/yce-tool.json"
    "YCE_MAX_LINES_PER_BLOB=$RuntimeYceMaxLinesPerBlob"
    "YCE_UPLOAD_TIMEOUT=$RuntimeYceUploadTimeout"
    "YCE_UPLOAD_CONCURRENCY=$RuntimeYceUploadConcurrency"
    "YCE_RETRIEVAL_TIMEOUT=$RuntimeYceRetrievalTimeout"
    "YCE_NO_ADAPTIVE=$RuntimeYceNoAdaptive"
    "YCE_NO_WEBBROWSER_ENHANCE_PROMPT=$RuntimeYceNoWebbrowserEnhancePrompt"
    ""
    "# yce orchestrator (milliseconds)"
    "YCE_DEFAULT_MODE=$RuntimeMode"
    "YCE_TIMEOUT_ENHANCE_MS=$RuntimeTimeoutEnhance"
    "YCE_TIMEOUT_SEARCH_MS=$RuntimeTimeoutSearch"
  )

  $vendorDir = Join-Path $ScriptDir "vendor"
  if (-not (Test-Path $vendorDir)) { New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null }

  Write-Host "Generating vendor/yce-tool.json..."
  Write-Utf8NoBomLines -FilePath $YceCfgFile -Lines @(
    "{"
    "  ""base_url"": ""$RuntimeYceUrl"","
    "  ""token"": ""$RuntimeYceToken"""
    "}"
  )

  Write-Ok "配置完成"
  Write-Host "  .env: $EnvFile"
  Write-Host "  yce-tool.json: $YceCfgFile"
  Write-Host "  yce base_url: $RuntimeYceUrl"
  if ($RuntimeYouwenToken) { Write-Host "  兑换码 / Token: $(Get-MaskedValue $RuntimeYouwenToken)" }
  Write-Host "  note: 若没有公益 relay，请改用你的 augment 请求地址重新执行 install.ps1 -Setup"
}

function Invoke-Check {
  Write-Host ""
  Write-Host "YCE 安装检查" -ForegroundColor Cyan
  Write-Host ""

  $remoteVer = Get-RemoteVersion
  $localVer = Get-LocalVersion $ScriptDir
  if ($remoteVer) { Write-Info "远程最新版本: $remoteVer" }
  if ($localVer) { Write-Info "当前本地版本: $localVer" }
  Write-Host ""

  $installed = Find-Installed
  if ($installed.Count -eq 0) {
    Write-Warn "未检测到任何已安装的 YCE"
  } else {
    foreach ($tool in $installed) {
      Write-Ok "$($tool.Label): $($tool.Dir)"
    }
  }

  if (Test-Path $EnvFile) { Write-Ok "本地 .env 已存在" } else { Write-Warn "本地 .env 不存在，可运行 .\install.ps1 -Setup" }
  if (Test-Path $YceCfgFile) { Write-Ok "本地 vendor/yce-tool.json 已存在" } else { Write-Warn "本地 vendor/yce-tool.json 不存在，可运行 .\install.ps1 -Setup" }
  Write-Host ""
}

function Invoke-Install {
  param([string]$TargetTool)

  Write-Host ""
  Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Blue
  Write-Host "║  YCE 安装 / 更新                            ║" -ForegroundColor Cyan
  Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Blue
  Write-Host ""

  Test-NodeInstalled | Out-Null

  $sourceDir = $ScriptDir
  $needCleanup = $false
  $localVer = Get-LocalVersion $ScriptDir
  $remoteVer = Get-RemoteVersion

  if ($remoteVer) {
    Write-Info "远程最新版本: $remoteVer"
  } else {
    Write-Warn "无法获取远程版本，将优先使用本地文件"
  }

  if ((-not (Test-Path (Join-Path $ScriptDir 'install.ps1'))) -or (-not (Test-Path (Join-Path $ScriptDir 'scripts\yce.js')))) {
    if ($DryRun) {
      $sourceDir = "<remote-latest>"
      Write-DryRun "将下载远程最新版本（当前目录关键文件缺失）"
    } else {
      $sourceDir = Get-LatestSource
      $needCleanup = $true
      Write-Ok "已下载最新版本"
    }
  } elseif ($remoteVer -and $localVer) {
    if ((Compare-SemVer $localVer $remoteVer) -lt 0) {
      if ($DryRun) {
        Write-DryRun "本地版本 $localVer 低于远程版本 $remoteVer，将下载最新版本"
        $sourceDir = "<remote-latest>"
      } else {
        Write-Info "本地版本 $localVer 低于远程版本 $remoteVer，下载最新版本..."
        $sourceDir = Get-LatestSource
        $needCleanup = $true
        Write-Ok "已下载最新版本"
      }
    } else {
      Write-Info "使用本地版本: $localVer"
    }
  } else {
    Write-Info "使用当前目录中的本地文件"
  }

  if ($TargetTool) {
    $tool = $ToolMap | Where-Object { $_.Key -eq $TargetTool } | Select-Object -First 1
    if (-not $tool) {
      Write-Fail "未知工具: $TargetTool"
      Write-Host "支持: $($ToolMap.Key -join ', ')"
      exit 1
    }
    Install-ToDir -SourceDir $sourceDir -TargetDir $tool.Dir -ToolName $tool.Label
  } else {
    $installed = Find-Installed
    if ($installed.Count -eq 0) {
      Write-Host "选择安装目标:"
      Write-Host ""
      for ($i = 0; $i -lt $ToolMap.Count; $i++) {
        Write-Host "  $($i+1)) $($ToolMap[$i].Label)"
      }
      Write-Host ""
      Write-Host "  a) 全部安装"
      Write-Host ""
      $choice = Read-Host "请选择 [1-$($ToolMap.Count)/a]"
      if ($choice -eq 'a' -or $choice -eq 'A') {
        foreach ($tool in $ToolMap) { Install-ToDir -SourceDir $sourceDir -TargetDir $tool.Dir -ToolName $tool.Label }
      } else {
        foreach ($sel in ($choice -split ',')) {
          $trimmed = $sel.Trim()
          if (-not $trimmed) { continue }
          $idx = [int]$trimmed - 1
          if ($idx -ge 0 -and $idx -lt $ToolMap.Count) {
            Install-ToDir -SourceDir $sourceDir -TargetDir $ToolMap[$idx].Dir -ToolName $ToolMap[$idx].Label
          }
        }
      }
    } else {
      Write-Info "更新已安装的实例..."
      Write-Host ""
      foreach ($tool in $installed) {
        Install-ToDir -SourceDir $sourceDir -TargetDir $tool.Dir -ToolName $tool.Label
      }
    }
  }

  if ($needCleanup -and $sourceDir) {
    Remove-Item (Split-Path $sourceDir -Parent) -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Ok "完成"
  Write-Host ""
  Write-Host "  配置: .\install.ps1 -Setup" -ForegroundColor Cyan
  Write-Host "  直写: .\install.ps1 -Setup -YceToken \"your-token\" -YouwenToken \"your-redemption-code\"" -ForegroundColor Cyan
  Write-Host "  测试: node scripts\yce.js \"定位 provider 列表获取逻辑\" --mode search" -ForegroundColor Cyan
  Write-Host ""
}

function Invoke-Uninstall {
  Write-Host ""
  Write-Host "YCE 卸载" -ForegroundColor Cyan
  Write-Host ""

  $installed = Find-Installed
  if ($installed.Count -eq 0) {
    Write-Warn "未检测到任何已安装的 YCE"
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
  if ($choice -eq '0') { Write-Host '已取消'; return }

  $targets = @()
  if ($choice -eq 'a' -or $choice -eq 'A') {
    $targets = $installed
  } else {
    foreach ($sel in ($choice -split ',')) {
      $trimmed = $sel.Trim()
      if (-not $trimmed) { continue }
      $idx = [int]$trimmed - 1
      if ($idx -ge 0 -and $idx -lt $installed.Count) { $targets += $installed[$idx] }
    }
  }

  Write-Host ""
  foreach ($tool in $targets) {
    $envTarget = Join-Path $tool.Dir '.env'
    $yceTarget = Join-Path $tool.Dir 'vendor\yce-tool.json'
    if ($DryRun) {
      Write-DryRun "将卸载: $($tool.Label)"
      Write-DryRun "  TargetDir = $($tool.Dir)"
      if (Test-Path $envTarget) { Write-DryRun "  将备份 .env => $envTarget.uninstall-backup" }
      if (Test-Path $yceTarget) { Write-DryRun "  将备份 yce-tool.json => $yceTarget.uninstall-backup" }
    } else {
      if (Test-Path $envTarget) { Copy-Item $envTarget "$envTarget.uninstall-backup" -Force }
      if (Test-Path $yceTarget) { Copy-Item $yceTarget "$yceTarget.uninstall-backup" -Force }
      Remove-Item $tool.Dir -Recurse -Force
      Write-Ok "已卸载: $($tool.Label)"
    }
  }
  Write-Host ""
}

function Invoke-Sync {
  $detected = Find-OtherInstalls
  if ($detected.Count -eq 0) {
    Write-Warn "未检测到其他已安装的 YCE"
    return
  }

  $targets = Select-SyncTargets -PromptLabel '同步 YCE 脚本 + 配置到其他工具' -Detected $detected
  if ($targets.Count -eq 0) { Write-Host '已跳过'; return }

  Write-Host ""
  foreach ($tool in $targets) {
    Install-ToDir -SourceDir $ScriptDir -TargetDir $tool.Dir -ToolName $tool.Label
    Sync-EnvToDir -TargetDir $tool.Dir -ToolName $tool.Label
  }
  Write-Host ""
}

function Invoke-SyncEnv {
  $detected = Find-OtherInstalls
  if ($detected.Count -eq 0) {
    Write-Warn "未检测到其他已安装的 YCE"
    return
  }

  $targets = Select-SyncTargets -PromptLabel '仅同步 .env 和 Yce 配置' -Detected $detected
  if ($targets.Count -eq 0) { Write-Host '已跳过'; return }

  Write-Host ""
  foreach ($tool in $targets) {
    Sync-EnvToDir -TargetDir $tool.Dir -ToolName $tool.Label
  }
  Write-Host ""
}

function Invoke-Setup {
  Test-NodeInstalled | Out-Null
  Write-Host ""

  if ($Reset -and (Test-Path $EnvFile)) {
    $ts = Get-Date -Format 'yyyyMMddHHmmss'
    Copy-Item $EnvFile "$EnvFile.bak.$ts" -Force
    Remove-Item $EnvFile -Force
    Write-Host '已备份旧配置'
  }

  $currentVars = @{}
  if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
      $trimmed = $line.Trim()
      if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
      if ($trimmed -match '^(\w+)\s*=\s*(.*)$') {
        $currentVars[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
      }
    }
  }

  $existingYceConfig = Read-ExistingYceConfig

  $runtimeYceUrl = if ($YceUrl) { $YceUrl } elseif ($existingYceConfig -and $existingYceConfig.base_url) { [string]$existingYceConfig.base_url } else { $DefaultYceUrl }
  $runtimeYceToken = if ($YceToken) { $YceToken } elseif ($existingYceConfig -and $existingYceConfig.token) { [string]$existingYceConfig.token } else { $null }
  $runtimeYouwen = if ($YouwenScript) { $YouwenScript } elseif ($currentVars.ContainsKey('YCE_YOUWEN_SCRIPT')) { $currentVars['YCE_YOUWEN_SCRIPT'] } else { $DefaultYouwenScript }
  $resolvedRepoYouwen = Resolve-YcePath $DefaultYouwenScript
  if (Test-Path $resolvedRepoYouwen) {
    if ($runtimeYouwen -and $runtimeYouwen -ne $DefaultYouwenScript) {
      Write-Warn "检测到旧的外部 YCE_YOUWEN_SCRIPT，已切换为仓内脚本: $DefaultYouwenScript"
    }
    $runtimeYouwen = $DefaultYouwenScript
  } elseif (-not $runtimeYouwen) {
    $runtimeYouwen = $DefaultYouwenScript
  }
  $upstreamYouwenEnv = Get-YouwenEnvFile $runtimeYouwen
  $runtimeYouwenApiUrl = if ($YouwenApiUrl) { $YouwenApiUrl } elseif ($currentVars.ContainsKey('YCE_YOUWEN_API_URL')) { $currentVars['YCE_YOUWEN_API_URL'] } elseif ($upstreamYouwenEnv) { Read-EnvValueFromFile -FilePath $upstreamYouwenEnv -Key 'YOUWEN_API_URL' } else { $DefaultYouwenApiUrl }
  if (-not $runtimeYouwenApiUrl) { $runtimeYouwenApiUrl = $DefaultYouwenApiUrl }
  $runtimeYouwenToken = if ($YouwenToken) { $YouwenToken } elseif ($currentVars.ContainsKey('YCE_YOUWEN_TOKEN')) { $currentVars['YCE_YOUWEN_TOKEN'] } elseif ($upstreamYouwenEnv) { Read-EnvValueFromFile -FilePath $upstreamYouwenEnv -Key 'YOUWEN_TOKEN' } else { $null }
  $runtimeYouwenEnhanceMode = if ($YouwenEnhanceMode) { $YouwenEnhanceMode } elseif ($currentVars.ContainsKey('YCE_YOUWEN_ENHANCE_MODE')) { $currentVars['YCE_YOUWEN_ENHANCE_MODE'] } elseif ($upstreamYouwenEnv) { Read-EnvValueFromFile -FilePath $upstreamYouwenEnv -Key 'YOUWEN_ENHANCE_MODE' } else { $DefaultYouwenEnhanceMode }
  if (-not $runtimeYouwenEnhanceMode) { $runtimeYouwenEnhanceMode = $DefaultYouwenEnhanceMode }
  $runtimeYouwenEnableSearch = if ($YouwenEnableSearch) { $YouwenEnableSearch } elseif ($currentVars.ContainsKey('YCE_YOUWEN_ENABLE_SEARCH')) { $currentVars['YCE_YOUWEN_ENABLE_SEARCH'] } elseif ($upstreamYouwenEnv) { Read-EnvValueFromFile -FilePath $upstreamYouwenEnv -Key 'YOUWEN_ENABLE_SEARCH' } else { $DefaultYouwenEnableSearch }
  if (-not $runtimeYouwenEnableSearch) { $runtimeYouwenEnableSearch = $DefaultYouwenEnableSearch }
  $runtimeYouwenMgrepApiKey = if ($YouwenMgrepApiKey) { $YouwenMgrepApiKey } elseif ($currentVars.ContainsKey('YCE_YOUWEN_MGREP_API_KEY')) { $currentVars['YCE_YOUWEN_MGREP_API_KEY'] } elseif ($upstreamYouwenEnv) { Read-EnvValueFromFile -FilePath $upstreamYouwenEnv -Key 'YOUWEN_MGREP_API_KEY' } else { $DefaultYouwenMgrepApiKey }
  $runtimeSearch = if ($YceSearchScript) { $YceSearchScript } elseif ($currentVars.ContainsKey('YCE_SEARCH_SCRIPT')) { $currentVars['YCE_SEARCH_SCRIPT'] } else { $DefaultYceSearchScript }
  $runtimeBinary = if ($YceBinary) { $YceBinary } elseif ($currentVars.ContainsKey('YCE_BINARY')) { $currentVars['YCE_BINARY'] } else { $DefaultYceBinary }
  $runtimeYceMaxLinesPerBlob = if ($YceMaxLinesPerBlob) { $YceMaxLinesPerBlob } elseif ($currentVars.ContainsKey('YCE_MAX_LINES_PER_BLOB')) { $currentVars['YCE_MAX_LINES_PER_BLOB'] } else { $DefaultYceMaxLinesPerBlob }
  $runtimeYceUploadTimeout = if ($YceUploadTimeout) { $YceUploadTimeout } elseif ($currentVars.ContainsKey('YCE_UPLOAD_TIMEOUT')) { $currentVars['YCE_UPLOAD_TIMEOUT'] } else { $DefaultYceUploadTimeout }
  $runtimeYceUploadConcurrency = if ($YceUploadConcurrency) { $YceUploadConcurrency } elseif ($currentVars.ContainsKey('YCE_UPLOAD_CONCURRENCY')) { $currentVars['YCE_UPLOAD_CONCURRENCY'] } else { $DefaultYceUploadConcurrency }
  $runtimeYceRetrievalTimeout = if ($YceRetrievalTimeout) { $YceRetrievalTimeout } elseif ($currentVars.ContainsKey('YCE_RETRIEVAL_TIMEOUT')) { $currentVars['YCE_RETRIEVAL_TIMEOUT'] } else { $DefaultYceRetrievalTimeout }
  $runtimeYceNoAdaptive = if ($YceNoAdaptive) { $YceNoAdaptive } elseif ($currentVars.ContainsKey('YCE_NO_ADAPTIVE')) { $currentVars['YCE_NO_ADAPTIVE'] } else { $DefaultYceNoAdaptive }
  $runtimeYceNoWebbrowserEnhancePrompt = if ($YceNoWebbrowserEnhancePrompt) { $YceNoWebbrowserEnhancePrompt } elseif ($currentVars.ContainsKey('YCE_NO_WEBBROWSER_ENHANCE_PROMPT')) { $currentVars['YCE_NO_WEBBROWSER_ENHANCE_PROMPT'] } else { $DefaultYceNoWebbrowserEnhancePrompt }
  $runtimeMode = if ($Mode) { $Mode } elseif ($currentVars.ContainsKey('YCE_DEFAULT_MODE')) { $currentVars['YCE_DEFAULT_MODE'] } else { $DefaultMode }
  $runtimeTimeoutEnhance = if ($TimeoutEnhance) { $TimeoutEnhance } elseif ($currentVars.ContainsKey('YCE_TIMEOUT_ENHANCE_MS')) { $currentVars['YCE_TIMEOUT_ENHANCE_MS'] } else { $DefaultTimeoutEnhance }
  $runtimeTimeoutSearch = if ($TimeoutSearch) { $TimeoutSearch } elseif ($currentVars.ContainsKey('YCE_TIMEOUT_SEARCH_MS')) { $currentVars['YCE_TIMEOUT_SEARCH_MS'] } else { $DefaultTimeoutSearch }

  $hasDirectArgs = $YceUrl -or $YceToken -or $YouwenScript -or $YouwenApiUrl -or $YouwenToken -or $YouwenEnhanceMode -or $YouwenEnableSearch -or $YouwenMgrepApiKey -or $YceSearchScript -or $YceBinary -or $YceMaxLinesPerBlob -or $YceUploadTimeout -or $YceUploadConcurrency -or $YceRetrievalTimeout -or $YceNoAdaptive -or $YceNoWebbrowserEnhancePrompt -or $Mode -or $TimeoutEnhance -or $TimeoutSearch

  if (-not $hasDirectArgs -or $Edit -or $Reset) {
    Write-Host '--- 交互式配置 ---'
    Write-Host ''
    Write-Host '提示：YCE 密钥请前往 https://yce.aige.de 获取' -ForegroundColor Cyan
    Write-Host ''
    if (-not $runtimeYceToken) {
      $runtimeYceToken = Read-Host 'Yce Token（必填）'
    } else {
      Write-Host "Yce Token 当前: $(Get-MaskedValue $runtimeYceToken)"
      $newToken = Read-Host 'Yce Token（回车保留）'
      if ($newToken) { $runtimeYceToken = $newToken }
    }

    Write-Host "Yce URL 当前: $runtimeYceUrl"
    $newUrl = Read-Host 'Yce URL（回车保留）'
    if ($newUrl) { $runtimeYceUrl = $newUrl }

    Write-Host "yw-enhance 脚本当前: $(if ($runtimeYouwen) { $runtimeYouwen } else { '未检测到仓内脚本' })"

    Write-Host "yw-enhance API 当前: $runtimeYouwenApiUrl"
    $newYouwenApiUrl = Read-Host 'yw-enhance API（回车保留）'
    if ($newYouwenApiUrl) { $runtimeYouwenApiUrl = $newYouwenApiUrl }

    Write-Host '提示：兑换码请前往 https://a.aigy.de 获取' -ForegroundColor Cyan
    Write-Host "兑换码 / Token 当前: $(if ($runtimeYouwenToken) { Get-MaskedValue $runtimeYouwenToken } else { '(空)' })"
    $newYouwenToken = Read-Host '兑换码 / Token（回车保留）'
    if ($newYouwenToken) { $runtimeYouwenToken = $newYouwenToken }

    Write-Host "yw-enhance 模式当前: $runtimeYouwenEnhanceMode"
    $newEnhanceMode = Read-Host 'yw-enhance 模式（agent/disabled，回车保留）'
    if ($newEnhanceMode) { $runtimeYouwenEnhanceMode = $newEnhanceMode }

    Write-Host "yw-enhance 联合搜索当前: $runtimeYouwenEnableSearch"
    $newEnableSearch = Read-Host 'yw-enhance 联合搜索（true/false，回车保留）'
    if ($newEnableSearch) { $runtimeYouwenEnableSearch = $newEnableSearch }

    Write-Host "yw-enhance Mixedbread Key 当前: $(if ($runtimeYouwenMgrepApiKey) { Get-MaskedValue $runtimeYouwenMgrepApiKey } else { '(空)' })"
    $newMgrepKey = Read-Host 'yw-enhance Mixedbread Key（回车保留）'
    if ($newMgrepKey) { $runtimeYouwenMgrepApiKey = $newMgrepKey }

    Write-Host "Yce search wrapper 当前: $runtimeSearch"
    $newSearch = Read-Host 'Yce search wrapper（回车保留）'
    if ($newSearch) { $runtimeSearch = $newSearch }

    Write-Host "Yce binary 当前: $runtimeBinary"
    $newBinary = Read-Host 'Yce binary（回车保留）'
    if ($newBinary) { $runtimeBinary = $newBinary }

    Write-Host "Yce max lines 当前: $runtimeYceMaxLinesPerBlob"
    $newMaxLines = Read-Host 'Yce max lines per blob（回车保留）'
    if ($newMaxLines) { $runtimeYceMaxLinesPerBlob = $newMaxLines }

    Write-Host "Yce upload timeout 当前: $runtimeYceUploadTimeout"
    $newUploadTimeout = Read-Host 'Yce upload timeout 秒（回车保留）'
    if ($newUploadTimeout) { $runtimeYceUploadTimeout = $newUploadTimeout }

    Write-Host "Yce upload concurrency 当前: $runtimeYceUploadConcurrency"
    $newUploadConcurrency = Read-Host 'Yce upload concurrency（回车保留）'
    if ($newUploadConcurrency) { $runtimeYceUploadConcurrency = $newUploadConcurrency }

    Write-Host "Yce retrieval timeout 当前: $runtimeYceRetrievalTimeout"
    $newRetrievalTimeout = Read-Host 'Yce retrieval timeout 秒（回车保留）'
    if ($newRetrievalTimeout) { $runtimeYceRetrievalTimeout = $newRetrievalTimeout }

    Write-Host "Yce no adaptive 当前: $runtimeYceNoAdaptive"
    $newNoAdaptive = Read-Host 'Yce no adaptive（true/false，回车保留）'
    if ($newNoAdaptive) { $runtimeYceNoAdaptive = $newNoAdaptive }

    Write-Host "Yce no webbrowser enhance 当前: $runtimeYceNoWebbrowserEnhancePrompt"
    $newNoWebbrowser = Read-Host 'Yce no webbrowser enhance（true/false，回车保留）'
    if ($newNoWebbrowser) { $runtimeYceNoWebbrowserEnhancePrompt = $newNoWebbrowser }

    Write-Host "默认模式当前: $runtimeMode"
    $newMode = Read-Host '默认模式（回车保留）'
    if ($newMode) { $runtimeMode = $newMode }

    Write-Host "增强超时当前: $runtimeTimeoutEnhance"
    $newEnhance = Read-Host '增强超时 ms（回车保留）'
    if ($newEnhance) { $runtimeTimeoutEnhance = $newEnhance }

    Write-Host "检索超时当前: $runtimeTimeoutSearch"
    $newSearchTimeout = Read-Host '检索超时 ms（回车保留）'
    if ($newSearchTimeout) { $runtimeTimeoutSearch = $newSearchTimeout }
  }

  Write-RuntimeConfig -RuntimeYceToken $runtimeYceToken -RuntimeYceUrl $runtimeYceUrl -RuntimeYouwenScript $runtimeYouwen -RuntimeYouwenApiUrl $runtimeYouwenApiUrl -RuntimeYouwenToken $runtimeYouwenToken -RuntimeYouwenEnhanceMode $runtimeYouwenEnhanceMode -RuntimeYouwenEnableSearch $runtimeYouwenEnableSearch -RuntimeYouwenMgrepApiKey $runtimeYouwenMgrepApiKey -RuntimeYceSearchScript $runtimeSearch -RuntimeYceBinary $runtimeBinary -RuntimeYceMaxLinesPerBlob $runtimeYceMaxLinesPerBlob -RuntimeYceUploadTimeout $runtimeYceUploadTimeout -RuntimeYceUploadConcurrency $runtimeYceUploadConcurrency -RuntimeYceRetrievalTimeout $runtimeYceRetrievalTimeout -RuntimeYceNoAdaptive $runtimeYceNoAdaptive -RuntimeYceNoWebbrowserEnhancePrompt $runtimeYceNoWebbrowserEnhancePrompt -RuntimeMode $runtimeMode -RuntimeTimeoutEnhance $runtimeTimeoutEnhance -RuntimeTimeoutSearch $runtimeTimeoutSearch

  $detected = Find-OtherInstalls
  if ($detected.Count -gt 0) {
    $syncAnswer = Read-Host '是否同步脚本 + 配置到其他工具？(y/N)'
    if ($syncAnswer -match '^[Yy]') { Invoke-Sync }
  }
}

function Show-Menu {
  Write-Host ""
  Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Blue
  Write-Host "║  YCE 管理工具                               ║" -ForegroundColor Cyan
  Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Blue
  Write-Host ""

  $installed = Find-Installed
  $hasInstall = ($installed.Count -gt 0)

  if ($hasInstall) {
    Write-Host '  ● 已安装到:' -ForegroundColor Green
    foreach ($tool in $installed) {
      Write-Host "    $($tool.Label) $($tool.Dir)"
    }
    Write-Host ''
    Write-Host '  1) 安装 / 更新'
    Write-Host '  2) 生成 / 修改配置'
    Write-Host '  3) 同步脚本 + 配置'
    Write-Host '  4) 仅同步配置'
    Write-Host '  5) 检查安装状态'
    Write-Host '  6) 卸载'
    Write-Host '  0) 退出'
  } else {
    Write-Host '  ● 尚未安装' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  1) 安装'
    Write-Host '  2) 生成 / 修改配置'
    Write-Host '  3) 检查安装状态'
    Write-Host '  0) 退出'
  }

  Write-Host ''
  $choice = Read-Host '请选择'
  if ($hasInstall) {
    switch ($choice) {
      '1' { Invoke-Install -TargetTool $Target }
      '2' { Invoke-Setup }
      '3' { Invoke-Sync }
      '4' { Invoke-SyncEnv }
      '5' { Invoke-Check }
      '6' { Invoke-Uninstall }
      '0' { return }
      default { Write-Warn '无效选择'; exit 1 }
    }
  } else {
    switch ($choice) {
      '1' { Invoke-Install -TargetTool $Target }
      '2' { Invoke-Setup }
      '3' { Invoke-Check }
      '0' { return }
      default { Write-Warn '无效选择'; exit 1 }
    }
  }
}

if ($Help) {
  Write-Host 'YCE 安装 / 更新 / 配置脚本'
  Write-Host ''
  Write-Host '用法:'
  Write-Host '  .\install.ps1                            # 交互式菜单（推荐）'
  Write-Host '  .\install.ps1 -Install                   # 安装或更新（必要时自动下载远程最新版本）'
  Write-Host '  .\install.ps1 -Target agents             # 仅安装到指定工具'
  Write-Host '  .\install.ps1 -Setup                     # 交互式配置 Yce Token / 兑换码 / API（默认使用仓内 scripts\youwen.js）'
  Write-Host '  .\install.ps1 -Setup -YceToken <token> -YouwenToken <code> # 直接写入 Yce Token + 兑换码 / Token'
  Write-Host '  .\install.ps1 -Sync                      # 同步脚本 + 配置到其他已安装目录'
  Write-Host '  .\install.ps1 -SyncEnv                   # 仅同步 .env 和 vendor/yce-tool.json'
  Write-Host '  .\install.ps1 -Check                     # 检查安装状态'
  Write-Host '  .\install.ps1 -Uninstall                 # 卸载'
  Write-Host '  .\install.ps1 -Setup -YceToken <token> -YouwenScript <path> -DryRun'
  Write-Host ''
  Write-Host "支持的工具: $($ToolMap.Key -join ', ')"
  Write-Host ''
  Write-Host '说明:'
  Write-Host "  - 默认 Yce 地址: $DefaultYceUrl"
  Write-Host '  - 没有公益站时，请在 -Setup 后补 -YceUrl <你的 augment 请求地址>'
  Write-Host '  - -Setup 会优先复用当前 .env / vendor/yce-tool.json，并优先对齐仓内 scripts\youwen.js 对应的 YCE 根目录配置'
  Write-Host "  - YCE_YOUWEN_SCRIPT 默认使用仓内脚本: $DefaultYouwenScript；如需特殊覆盖，仍可通过 -YouwenScript 或 .env 指定"
  Write-Host '  - 会按当前系统自动选择 Yce wrapper（Windows 用 scripts\yce-search.ps1）'
  Write-Host '  - 当前 install.ps1 目标兼容 Windows PowerShell 5.1'
  Write-Host '  - scripts\lib\* 是内部模块，不应直接配置成 YCE_YOUWEN_SCRIPT'
  Write-Host '  - 可交互配置：Yce Token、Yce URL、兑换码 / Token、yw-enhance API'
  Write-Host '  - yw-enhance 扩展参数: -YouwenApiUrl -YouwenToken -YouwenEnhanceMode -YouwenEnableSearch -YouwenMgrepApiKey'
  Write-Host '  - Yce 扩展参数: -YceMaxLinesPerBlob -YceUploadTimeout -YceUploadConcurrency -YceRetrievalTimeout -YceNoAdaptive -YceNoWebbrowserEnhancePrompt -TimeoutEnhance -TimeoutSearch'
  Write-Host '  - 可加 -DryRun 只看将要执行的动作，不真正写文件/删除/同步'
  exit 0
}

if ($Check) { Invoke-Check; exit 0 }
if ($Uninstall) { Invoke-Uninstall; exit 0 }
if ($Sync) { Invoke-Sync; exit 0 }
if ($SyncEnv) { Invoke-SyncEnv; exit 0 }
if ($Setup) { Invoke-Setup; exit 0 }
if ($Install) { Invoke-Install -TargetTool $Target; exit 0 }

Show-Menu
