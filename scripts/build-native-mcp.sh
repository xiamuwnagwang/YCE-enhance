#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

platform_dir() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os:$arch" in
    darwin:arm64|darwin:aarch64) printf 'darwin-arm64\n' ;;
    darwin:x86_64|darwin:amd64) printf 'darwin-amd64\n' ;;
    linux:x86_64|linux:amd64) printf 'linux-amd64\n' ;;
    linux:aarch64|linux:arm64) printf 'linux-arm64\n' ;;
    msys*:x86_64|mingw*:x86_64|cygwin*:x86_64) printf 'windows-x64\n' ;;
    *) die "Unsupported build host: $os $arch" ;;
  esac
}

command -v cargo >/dev/null 2>&1 || die "Rust cargo is required"

PLATFORM="$(platform_dir)"
BINARY_NAME="yce-mcp"
[[ "$PLATFORM" == windows-* ]] && BINARY_NAME="yce-mcp.exe"
SOURCE="$ROOT/target/release/$BINARY_NAME"
DESTINATION_DIR="$ROOT/bin/$PLATFORM"
DESTINATION="$DESTINATION_DIR/$BINARY_NAME"

printf 'Building native YCE MCP for %s...\n' "$PLATFORM"
cargo build --manifest-path "$ROOT/Cargo.toml" --release --locked
mkdir -p "$DESTINATION_DIR"
install -m 755 "$SOURCE" "$DESTINATION"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$DESTINATION" >"$DESTINATION.sha256"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$DESTINATION" >"$DESTINATION.sha256"
else
  die "shasum or sha256sum is required"
fi

printf 'Built: %s\n' "$DESTINATION"
