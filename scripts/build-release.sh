#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -P "$HERE/.." && pwd)"
DIST_DIR="$ROOT/dist"

die() {
  echo "Error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

read_version() {
  local ver=""
  ver="$(python3 - "$ROOT/SKILL.md" <<'PY'
import re, sys
from pathlib import Path
txt = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
m = re.search(r'(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$', txt)
print(m.group(1) if m else "")
PY
)"
  [[ -n "$ver" ]] || die "Cannot find semver 'version: x.y.z' in SKILL.md"
  echo "$ver"
}

checksum_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file"
  else
    die "Need shasum or sha256sum for checksums"
  fi
}

main() {
  need_cmd python3
  need_cmd tar
  need_cmd zip

  local version pkg_base work_dir pkg_root tar_path zip_path sums_path
  version="$(read_version)"
  pkg_base="yce-skill-v${version}"

  mkdir -p "$DIST_DIR"

  echo "==> Building release: $pkg_base"
  echo "==> Cleaning old dist artifacts"
  rm -f "$DIST_DIR/yce-skill-v"*.tar.gz "$DIST_DIR/yce-skill-v"*.zip "$DIST_DIR/SHA256SUMS"

  work_dir="$(mktemp -d)"
  pkg_root="$work_dir/$pkg_base"
  mkdir -p "$pkg_root"

  # Copy only what an installer needs; never include secrets (.env).
  # Also avoid .git and dist recursion.
  # LICENSE 必须随包走：这是 GPL-3.0 的再分发条件之一，之前只留在仓库根目录，
  # 解压出来的包里没有任何许可文本。
  local items=(
    "scripts"
    "vendor"
    "test"
    "references"
    "SKILL.md"
    "install.sh"
    "install.ps1"
    "LICENSE"
  )

  for item in "${items[@]}"; do
    [[ -e "$ROOT/$item" ]] || die "Missing required file/dir: $item"
  done

  for item in "${items[@]}"; do
    if [[ -d "$ROOT/$item" ]]; then
      mkdir -p "$pkg_root/$item"
      tar -C "$ROOT" \
        --exclude="$item/.DS_Store" \
        --exclude="$item/**/.DS_Store" \
        --exclude="vendor/yce-engine/node_modules/@vscode/ripgrep-darwin-*" \
        --exclude="vendor/yce-engine/node_modules/@vscode/ripgrep-linux-*" \
        --exclude="vendor/yce-engine/node_modules/@vscode/ripgrep-win32-*" \
        -cf - "$item" \
      | tar -C "$pkg_root" -xf -
    else
      cp "$ROOT/$item" "$pkg_root/$item"
    fi
  done

  # Ensure we don't accidentally ship local env or any tokens.
  rm -f "$pkg_root/.env" 2>/dev/null || true

  # Redact any token-like strings from the packaged copy only.
  python3 - "$pkg_root" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
token_re = re.compile(r"\byce_[0-9a-f]{16,}\b", re.IGNORECASE)

for p in root.rglob("*"):
    if not p.is_file():
        continue
    if p.suffix.lower() not in {".sh", ".ps1", ".json", ".md", ".js", ".mjs", ".cjs", ".rs", ".toml"}:
        continue
    try:
        data = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        continue
    if not token_re.search(data):
        continue
    redacted = token_re.sub("", data)
    p.write_text(redacted, encoding="utf-8")
PY

  tar_path="$DIST_DIR/$pkg_base.tar.gz"
  zip_path="$DIST_DIR/$pkg_base.zip"
  sums_path="$DIST_DIR/SHA256SUMS"

  echo "==> Creating tar.gz"
  tar -C "$work_dir" -czf "$tar_path" "$pkg_base"

  echo "==> Creating zip"
  (
    cd "$work_dir"
    zip -rq "$zip_path" "$pkg_base"
  )

  echo "==> Writing checksums"
  # 只写裸文件名：用户是在放好资产的目录里跑 `shasum -a 256 -c SHA256SUMS`，写打包机
  # 的绝对路径既校验不过、又把本机目录结构带进公开产物（3.8.5 及以前一直是绝对路径）。
  (
    cd "$DIST_DIR"
    checksum_file "$pkg_base.tar.gz"
    checksum_file "$pkg_base.zip"
  ) >"$sums_path"

  rm -rf "$work_dir"

  echo "==> Done"
  echo "Artifacts:"
  echo "  - $tar_path"
  echo "  - $zip_path"
  echo "  - $sums_path"
}

main "$@"
