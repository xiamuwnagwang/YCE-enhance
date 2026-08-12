#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS:$ARCH" in
  darwin:arm64|darwin:aarch64) PLATFORM="darwin-arm64" ;;
  darwin:x86_64|darwin:amd64) PLATFORM="darwin-amd64" ;;
  linux:x86_64|linux:amd64) PLATFORM="linux-amd64" ;;
  linux:aarch64|linux:arm64) PLATFORM="linux-arm64" ;;
  *)
    printf 'yce-mcp: unsupported platform: %s %s\n' "$OS" "$ARCH" >&2
    exit 1
    ;;
esac

BINARY="$ROOT/bin/$PLATFORM/yce-mcp"
if [[ ! -x "$BINARY" ]]; then
  printf 'yce-mcp: native binary is missing: %s\n' "$BINARY" >&2
  printf 'yce-mcp: run bash scripts/build-native-mcp.sh on this platform first\n' >&2
  exit 1
fi

exec "$BINARY" --runtime-root "$ROOT" "$@"
