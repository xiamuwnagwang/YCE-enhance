#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=yce-lib.sh
source "$HERE/yce-lib.sh"

yce_require_supported_platform

if [[ "$#" -lt 1 ]]; then
  yce_die 2 "Usage: bash $HERE/yce-search.sh \"your natural language query\""
fi

if [[ "$PWD" == "$HOME" || "$PWD" == ~ ]]; then
  echo "⚠️ 警告: 在 home 目录运行可能很慢，建议 cd 到具体项目目录" >&2
fi

QUERY="$*"
YCE_BIN="$(yce_resolve_binary)"
YCE_CFG="$(yce_materialize_config)"
TMP_CFG=""
ORIGINAL_CFG="$(yce_resolve_config)"
if [[ "$YCE_CFG" != "$ORIGINAL_CFG" ]]; then
  TMP_CFG="$YCE_CFG"
  trap 'rm -f "$TMP_CFG"' EXIT
fi

TIMEOUT_SECONDS="${YCE_TIMEOUT:-60}"
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  TIMEOUT_CMD=""
fi

yce_extra_args() {
  local env_file="$PROJECT_ROOT/.env"
  [[ ! -f "$env_file" ]] && return 0
  python3 - "$env_file" <<'PY'
import re
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
values = {}
for line in env_path.read_text(encoding="utf-8").splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        continue
    match = re.match(r"^([A-Z0-9_]+)\s*=\s*(.*)$", stripped, re.I)
    if not match:
        continue
    key, value = match.group(1), match.group(2).strip().strip('"').strip("'")
    values[key] = value

args = []
for key, flag in [
    ("YCE_MAX_LINES_PER_BLOB", "--max-lines-per-blob"),
    ("YCE_UPLOAD_TIMEOUT", "--upload-timeout"),
    ("YCE_UPLOAD_CONCURRENCY", "--upload-concurrency"),
    ("YCE_RETRIEVAL_TIMEOUT", "--retrieval-timeout"),
]:
    value = values.get(key, "").strip()
    if value:
        args.extend([flag, value])

for key, flag in [
    ("YCE_NO_ADAPTIVE", "--no-adaptive"),
    ("YCE_NO_WEBBROWSER_ENHANCE_PROMPT", "--no-webbrowser-enhance-prompt"),
]:
    value = values.get(key, "").strip().lower()
    if value in {"1", "true", "yes", "on"}:
        args.append(flag)

print("\n".join(args))
PY
}

YCE_EXTRA_ARGS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && YCE_EXTRA_ARGS+=("$line")
done < <(yce_extra_args)

if [[ -n "$TIMEOUT_CMD" ]]; then
  OUT="$($TIMEOUT_CMD "$TIMEOUT_SECONDS" "$YCE_BIN" --config "$YCE_CFG" "${YCE_EXTRA_ARGS[@]}" --search-context="$QUERY" 2>&1)" || {
    exit_code=$?
    if [[ $exit_code -eq 124 ]]; then
      yce_die 6 "搜索超时（${TIMEOUT_SECONDS}s）。请在项目目录中运行，或设置 YCE_TIMEOUT 环境变量增加超时时间。"
    fi
    yce_die 5 "搜索失败: $OUT"
  }
else
  OUT="$("$YCE_BIN" --config "$YCE_CFG" "${YCE_EXTRA_ARGS[@]}" --search-context="$QUERY" 2>&1)" || {
    yce_die 5 "搜索失败: $OUT"
  }
fi

if [[ -z "$OUT" ]]; then
  yce_die 3 "Search completed but returned empty output (no results)."
fi

printf '%s\n' "$OUT"
