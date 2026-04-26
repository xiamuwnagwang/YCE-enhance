param(
    [Parameter(Mandatory=$true, Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$Query
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$VendorDir = Join-Path $ProjectRoot "vendor"
$Platform = "windows-x64"

$BinaryPath = Join-Path $VendorDir $Platform "yce-tool-rs.exe"
$ConfigPath = Join-Path $VendorDir "yce-tool.json"
$FallbackConfigPath = Join-Path $VendorDir "yce-tool.default.json"
$EnvFile = Join-Path $ProjectRoot ".env"

if (-not (Test-Path $BinaryPath)) {
    Write-Error "Binary not found: $BinaryPath"
    exit 1
}

if (-not (Test-Path $ConfigPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
    if (Test-Path $FallbackConfigPath) {
        Copy-Item -Force $FallbackConfigPath $ConfigPath
    } else {
        @'
{
  "base_url": "https://yce.aigy.de/",
  "token": ""
}
'@ | Set-Content -Encoding UTF8 $ConfigPath
    }
}

if (-not (Test-Path $ConfigPath)) {
    Write-Error "Configuration file not found: $ConfigPath"
    exit 1
}

$QueryString = $Query -join " "

function Get-MaterializedYceConfigPath {
    param([string]$InputConfigPath)
    $raw = Get-Content $InputConfigPath -Raw -Encoding UTF8
    $json = $raw | ConvertFrom-Json
    $baseUrl = if ($null -eq $json.base_url) { "" } else { [string]$json.base_url }
    $trimmed = $baseUrl.Trim()

    $normalized = $null
    if ($trimmed -match '^https?://[^/]+/?$') {
        $normalized = ($trimmed.TrimEnd('/')) + "/relay/"
    } elseif ($trimmed -match '^https?://[^/]+/api/v1/\.\./\.\./?$') {
        $normalized = ([System.Text.RegularExpressions.Regex]::Replace(
            $trimmed,
            '/api/v1/\.\./\.\./?$',
            '',
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )) + "/relay/"
    }

    if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized -eq $baseUrl) {
        return @{
            ConfigPath = $InputConfigPath
            TempConfigPath = $null
        }
    }

    $json.base_url = $normalized
    $tempName = "yce-tool-{0}.json" -f ([Guid]::NewGuid().ToString("N"))
    $tempPath = Join-Path ([System.IO.Path]::GetTempPath()) $tempName
    ($json | ConvertTo-Json -Depth 16) | Set-Content -Path $tempPath -Encoding UTF8
    return @{
        ConfigPath = $tempPath
        TempConfigPath = $tempPath
    }
}

function Read-YceEnvMap {
    param([string]$FilePath)
    $map = @{}
    if (-not (Test-Path $FilePath)) { return $map }
    foreach ($line in Get-Content $FilePath -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed -match '^(\w+)\s*=\s*(.*)$') {
            $map[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
        }
    }
    return $map
}

function Get-YceExtraArgs {
    param([hashtable]$EnvMap)
    $args = New-Object System.Collections.Generic.List[string]
    foreach ($item in @(
        @{ Key = 'YCE_MAX_LINES_PER_BLOB'; Flag = '--max-lines-per-blob' },
        @{ Key = 'YCE_UPLOAD_TIMEOUT'; Flag = '--upload-timeout' },
        @{ Key = 'YCE_UPLOAD_CONCURRENCY'; Flag = '--upload-concurrency' },
        @{ Key = 'YCE_RETRIEVAL_TIMEOUT'; Flag = '--retrieval-timeout' }
    )) {
        if ($EnvMap.ContainsKey($item.Key) -and -not [string]::IsNullOrWhiteSpace($EnvMap[$item.Key])) {
            [void]$args.Add($item.Flag)
            [void]$args.Add($EnvMap[$item.Key])
        }
    }

    foreach ($item in @(
        @{ Key = 'YCE_NO_ADAPTIVE'; Flag = '--no-adaptive' },
        @{ Key = 'YCE_NO_WEBBROWSER_ENHANCE_PROMPT'; Flag = '--no-webbrowser-enhance-prompt' }
    )) {
        if ($EnvMap.ContainsKey($item.Key)) {
            $normalized = [string]$EnvMap[$item.Key]
            if ($normalized.ToLowerInvariant() -in @('1', 'true', 'yes', 'on')) {
                [void]$args.Add($item.Flag)
            }
        }
    }
    return $args.ToArray()
}

$YceExtraArgs = Get-YceExtraArgs -EnvMap (Read-YceEnvMap -FilePath $EnvFile)
$MaterializedConfig = Get-MaterializedYceConfigPath -InputConfigPath $ConfigPath
$EffectiveConfigPath = $MaterializedConfig.ConfigPath
$TempConfigPath = $MaterializedConfig.TempConfigPath

try {
    $Output = & $BinaryPath --config $EffectiveConfigPath @YceExtraArgs "--search-context=$QueryString" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "yce-tool-rs failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
    if ([string]::IsNullOrWhiteSpace($Output)) {
        Write-Error "Search completed but returned empty output (no results)."
        exit 3
    }
    Write-Output $Output
} catch {
    Write-Error "Failed to execute yce-tool-rs: $_"
    exit 1
} finally {
    if (-not [string]::IsNullOrWhiteSpace($TempConfigPath) -and (Test-Path $TempConfigPath)) {
        Remove-Item $TempConfigPath -Force -ErrorAction SilentlyContinue
    }
}
