$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()

if ($Arch -ne "x64") {
  [Console]::Error.WriteLine("yce-mcp: unsupported Windows architecture: $Arch")
  exit 1
}

$Binary = Join-Path $Root "bin\windows-x64\yce-mcp.exe"
if (-not (Test-Path $Binary -PathType Leaf)) {
  [Console]::Error.WriteLine("yce-mcp: native binary is missing: $Binary")
  exit 1
}

& $Binary --runtime-root $Root @args
exit $LASTEXITCODE
