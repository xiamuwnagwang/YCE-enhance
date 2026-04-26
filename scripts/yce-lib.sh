#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$HERE")"
VENDOR_DIR="$PROJECT_ROOT/vendor"

PLATFORM_DARWIN_ARM64="darwin-arm64"
PLATFORM_DARWIN_AMD64="darwin-amd64"
PLATFORM_LINUX_AMD64="linux-amd64"
PLATFORM_LINUX_ARM64="linux-arm64"
PLATFORM_WINDOWS_X64="windows-x64"

yce_die() {
  local code="$1"
  shift
  echo "Error: $*" >&2
  exit "$code"
}

yce_detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin)
      case "$arch" in
        arm64|aarch64) echo "$PLATFORM_DARWIN_ARM64" ;;
        x86_64|amd64) echo "$PLATFORM_DARWIN_AMD64" ;;
        *) yce_die 1 "Unsupported architecture on macOS: $arch" ;;
      esac
      ;;
    linux)
      case "$arch" in
        x86_64|amd64) echo "$PLATFORM_LINUX_AMD64" ;;
        aarch64|arm64) echo "$PLATFORM_LINUX_ARM64" ;;
        *) yce_die 1 "Unsupported architecture on Linux: $arch" ;;
      esac
      ;;
    msys*|mingw*|cygwin*|windows*)
      case "$arch" in
        x86_64|amd64) echo "$PLATFORM_WINDOWS_X64" ;;
        *) yce_die 1 "Unsupported architecture on Windows: $arch" ;;
      esac
      ;;
    *) yce_die 1 "Unsupported operating system: $os" ;;
  esac
}

yce_resolve_binary() {
  local platform
  platform="$(yce_detect_platform)"
  if [[ "$platform" == "$PLATFORM_WINDOWS_X64" ]]; then
    echo "$VENDOR_DIR/$platform/yce-tool-rs.exe"
  else
    echo "$VENDOR_DIR/$platform/yce-tool-rs"
  fi
}

yce_require_supported_platform() {
  local binary_path
  binary_path="$(yce_resolve_binary)"
  if [[ ! -f "$binary_path" ]]; then
    yce_die 1 "Binary not found for current platform: $binary_path"
  fi
  if [[ ! -x "$binary_path" ]]; then
    yce_die 1 "Binary is not executable: $binary_path"
  fi
}

yce_resolve_config() {
  local config_path="$VENDOR_DIR/yce-tool.json"
  if [[ ! -f "$config_path" ]]; then
    local fallback_path="$VENDOR_DIR/yce-tool.default.json"
    mkdir -p "$(dirname "$config_path")"
    if [[ -f "$fallback_path" ]]; then
      cp "$fallback_path" "$config_path"
    else
      cat > "$config_path" <<'JSONEOF'
{
  "base_url": "https://yce.aigy.de/",
  "token": ""
}
JSONEOF
    fi
  fi
  if [[ ! -f "$config_path" ]]; then
    yce_die 1 "Configuration file not found: $config_path"
  fi
  echo "$config_path"
}

yce_materialize_config() {
  local config_path
  config_path="$(yce_resolve_config)"
  python3 - "$config_path" <<'PY'
import json
import os
import re
import sys
import tempfile

config_path = sys.argv[1]
with open(config_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

base_url = data.get('base_url')
if not isinstance(base_url, str):
    print(config_path)
    raise SystemExit(0)

normalized = None
trimmed = base_url.strip()
if re.fullmatch(r'https?://[^/]+/?', trimmed):
    normalized = trimmed.rstrip('/') + '/relay/'
elif re.fullmatch(r'https?://[^/]+/api/v1/\.\./\.\./?', trimmed):
    normalized = re.sub(r'/api/v1/\.\./\.\./?$', '', trimmed) + '/relay/'

if normalized and normalized != base_url:
    patched = dict(data)
    patched['base_url'] = normalized

    fd, temp_path = tempfile.mkstemp(prefix='yce-tool-', suffix='.json')
    os.close(fd)
    with open(temp_path, 'w', encoding='utf-8') as f:
        json.dump(patched, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(temp_path)
else:
    print(config_path)
PY
}
