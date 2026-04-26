#!/usr/bin/env bash
set -eo pipefail

SKILL_NAME="yce"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
YCE_CFG_FILE="$SCRIPT_DIR/vendor/yce-tool.json"
REPO_URL="https://github.com/xiamuwnagwang/YCE-enhance"
REPO_ARCHIVE_FALLBACK="https://github.com/xiamuwnagwang/YCE-enhance/archive/refs/heads/main.tar.gz"
REMOTE_SKILL_MD_URL="https://raw.githubusercontent.com/xiamuwnagwang/YCE-enhance/main/SKILL.md"

GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
CYAN='\033[36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { printf "${BLUE}▸${NC} %b\n" "$1"; }
ok()    { printf "${GREEN}✔${NC} %b\n" "$1"; }
warn()  { printf "${YELLOW}⚠${NC} %b\n" "$1"; }
fail()  { printf "${YELLOW}✘${NC} %b\n" "$1"; }

get_opencode_skills_root() {
  [[ -n "${OPENCODE_SKILLS_ROOT:-}" ]] && { echo "$OPENCODE_SKILLS_ROOT"; return; }

  local script_parent script_grandparent
  script_parent="$(dirname "$SCRIPT_DIR")"
  script_grandparent="$(dirname "$script_parent")"

  if [[ "$(basename "$script_parent")" == "skills" ]] && [[ "$script_grandparent" == "$HOME/.config/opencode" ]]; then
    echo "$script_parent"
  else
    echo "$HOME/.config/opencode/skills"
  fi
}

get_codex_skills_root() {
  [[ -n "${CODEX_SKILLS_ROOT:-}" ]] && { echo "$CODEX_SKILLS_ROOT"; return; }

  local script_parent script_grandparent
  script_parent="$(dirname "$SCRIPT_DIR")"
  script_grandparent="$(dirname "$script_parent")"

  if [[ "$(basename "$script_parent")" == "skills" ]] && [[ "$script_grandparent" == "$HOME/.codex" ]]; then
    echo "$script_parent"
  else
    echo "$HOME/.codex/skills"
  fi
}

OPENCODE_SKILLS_ROOT="$(get_opencode_skills_root)"
CODEX_SKILLS_ROOT="$(get_codex_skills_root)"

TOOL_KEYS=("claude" "opencode" "cursor" "windsurf" "cline" "continue" "codium" "aider" "codex")
TOOL_LABELS=("Claude Code" "OpenCode" "Cursor" "Windsurf" "Cline" "Continue" "Codium" "Aider" "Codex")
TOOL_DIRS=(
  "$HOME/.claude/skills/$SKILL_NAME"
  "$OPENCODE_SKILLS_ROOT/$SKILL_NAME"
  "$HOME/.cursor/skills/$SKILL_NAME"
  "$HOME/.windsurf/skills/$SKILL_NAME"
  "$HOME/.cline/skills/$SKILL_NAME"
  "$HOME/.continue/skills/$SKILL_NAME"
  "$HOME/.codium/skills/$SKILL_NAME"
  "$HOME/.aider/skills/$SKILL_NAME"
  "$CODEX_SKILLS_ROOT/$SKILL_NAME"
)

if [[ -d "$HOME/.agents/skills" ]]; then
  TOOL_KEYS=("claude" "agents" "${TOOL_KEYS[@]:1}")
  TOOL_LABELS=("Claude Code" ".agents" "${TOOL_LABELS[@]:1}")
  TOOL_DIRS=(
    "$HOME/.claude/skills/$SKILL_NAME"
    "$HOME/.agents/skills/$SKILL_NAME"
    "${TOOL_DIRS[@]:1}"
  )
fi

INSTALL_FILES=("scripts" "vendor" "SKILL.md" "install.sh" "install.ps1" ".env.example" ".gitignore")

DEFAULT_YOUWEN_SCRIPT="./scripts/youwen.js"
DEFAULT_YOUWEN_API_URL="https://a.aigy.de"
DEFAULT_YOUWEN_ENHANCE_MODE="agent"
DEFAULT_YOUWEN_ENABLE_SEARCH="true"
DEFAULT_YOUWEN_MGREP_API_KEY=""
DEFAULT_YCE_URL="https://yce.aigy.de/"
DEFAULT_YCE_MAX_LINES_PER_BLOB="800"
DEFAULT_YCE_UPLOAD_TIMEOUT=""
DEFAULT_YCE_UPLOAD_CONCURRENCY=""
DEFAULT_YCE_RETRIEVAL_TIMEOUT="60"
DEFAULT_YCE_NO_ADAPTIVE="false"
DEFAULT_YCE_NO_WEBBROWSER_ENHANCE_PROMPT="false"
DEFAULT_MODE="auto"
DEFAULT_TIMEOUT_ENHANCE_MS="300000"
DEFAULT_TIMEOUT_SEARCH_MS="180000"

resolve_platform_dir() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin)
      case "$arch" in
        arm64|aarch64) echo "darwin-arm64" ;;
        x86_64|amd64) echo "darwin-amd64" ;;
        *) echo "darwin-unknown" ;;
      esac
      ;;
    linux)
      case "$arch" in
        x86_64|amd64) echo "linux-amd64" ;;
        aarch64|arm64) echo "linux-arm64" ;;
        *) echo "linux-unknown" ;;
      esac
      ;;
    msys*|mingw*|cygwin*|windows*)
      case "$arch" in
        x86_64|amd64) echo "windows-x64" ;;
        *) echo "windows-unknown" ;;
      esac
      ;;
    *) echo "unknown-platform" ;;
  esac
}

yce_binary_filename() {
  local platform_dir="$1"
  if [[ "$platform_dir" == "windows-x64" ]]; then
    echo "yce-tool-rs.exe"
  else
    echo "yce-tool-rs"
  fi
}

yce_search_wrapper() {
  local platform_dir="$1"
  if [[ "$platform_dir" == "windows-x64" ]]; then
    echo "./scripts/yce-search.ps1"
  else
    echo "./scripts/yce-search.sh"
  fi
}

DEFAULT_YCE_BINARY="./vendor/$(resolve_platform_dir)/$(yce_binary_filename "$(resolve_platform_dir)")"
DEFAULT_YCE_SEARCH_SCRIPT="$(yce_search_wrapper "$(resolve_platform_dir)")"
DEFAULT_YCE_CONFIG="./vendor/yce-tool.json"

expand_home() {
  local value="$1"
  if [[ "$value" == ~* ]]; then
    echo "$HOME${value:1}"
  else
    echo "$value"
  fi
}

resolve_path_from_script_dir() {
  local value="$1"
  local expanded
  expanded="$(expand_home "$value")"
  [[ -z "$expanded" ]] && { echo ""; return 0; }
  if [[ "$expanded" != /* ]]; then
    echo "$SCRIPT_DIR/${expanded#./}"
  else
    echo "$expanded"
  fi
}

mask_secret() {
  local value="$1" length=${#1}
  if (( length <= 4 )); then
    echo "****"
    return
  fi
  printf '%s' "${value:0:2}"
  printf '%*s' $((length - 4)) '' | tr ' ' '*'
  printf '%s' "${value: -2}"
}

read_env_file_value() {
  local key="$1"
  local file_path="${2:-$ENV_FILE}"
  [[ ! -f "$file_path" ]] && return 0
  python3 - "$file_path" "$key" <<'PY'
import sys
from pathlib import Path

file_path, key = sys.argv[1], sys.argv[2]
for raw_line in Path(file_path).read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    lhs, rhs = line.split("=", 1)
    if lhs.strip() != key:
        continue
    print(rhs.strip().strip('"').strip("'"))
    break
PY
}

read_json_file_value() {
  local file_path="$1"
  local key="$2"
  [[ ! -f "$file_path" ]] && return 0
  python3 - "$file_path" "$key" <<'PY'
import json
import sys
from pathlib import Path

file_path, key = sys.argv[1], sys.argv[2]
data = json.loads(Path(file_path).read_text(encoding="utf-8"))
value = data.get(key)
if value is None:
    raise SystemExit(0)
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

resolve_youwen_env_file() {
  local script_path="$1"
  local expanded
  expanded="$(resolve_path_from_script_dir "$script_path")"
  [[ ! -f "$expanded" ]] && return 0
  python3 - "$expanded" <<'PY'
import sys
from pathlib import Path

script_path = Path(sys.argv[1]).resolve()
env_path = script_path.parent.parent / ".env"
if env_path.exists():
    print(str(env_path))
PY
}

tool_index() {
  local key="$1"
  for i in "${!TOOL_KEYS[@]}"; do
    [[ "${TOOL_KEYS[$i]}" == "$key" ]] && { echo "$i"; return 0; }
  done
  return 1
}

tool_dir_by_key() {
  local idx
  idx=$(tool_index "$1") || return 1
  echo "${TOOL_DIRS[$idx]}"
}

tool_label_by_key() {
  local idx
  idx=$(tool_index "$1") || return 1
  echo "${TOOL_LABELS[$idx]}"
}

check_node() {
  if command -v node >/dev/null 2>&1; then
    ok "Node.js $(node -v)"
  else
    fail "未安装 Node.js（需要 v16+）"
    exit 1
  fi
}

get_local_version() {
  local dir="$1"
  [[ -f "$dir/SKILL.md" ]] && grep -m1 '^version:' "$dir/SKILL.md" 2>/dev/null | sed 's/version:[[:space:]]*//' | tr -d '[:space:]'
}

compare_semver() {
  local a="$1" b="$2"
  local IFS='.'
  read -ra pa <<< "$a"
  read -ra pb <<< "$b"
  for i in 0 1 2; do
    local va="${pa[$i]:-0}"
    local vb="${pb[$i]:-0}"
    (( va < vb )) && { echo "-1"; return; }
    (( va > vb )) && { echo "1"; return; }
  done
  echo "0"
}

get_remote_version() {
  curl -fsSL --retry 2 --retry-delay 1 --max-time 10 "$REMOTE_SKILL_MD_URL" 2>/dev/null | grep -m1 '^version:' | sed 's/version:[[:space:]]*//' | tr -d '[:space:]'
}

download_latest() {
  local tmp_dir
  tmp_dir=$(mktemp -d)

  info "下载最新 YCE..."
  if command -v git >/dev/null 2>&1; then
    if git clone --depth 1 "$REPO_URL.git" "$tmp_dir/repo" >/dev/null 2>&1; then
      echo "$tmp_dir/repo"
      return 0
    fi
  fi

  if curl -fsSL --retry 3 --retry-delay 1 "$REPO_ARCHIVE_FALLBACK" | tar -xz -C "$tmp_dir" >/dev/null 2>&1; then
    local extracted
    extracted=$(find "$tmp_dir" -maxdepth 1 -type d ! -path "$tmp_dir" | head -1)
    if [[ -n "$extracted" ]]; then
      mv "$extracted" "$tmp_dir/repo"
      echo "$tmp_dir/repo"
      return 0
    fi
  fi

  rm -rf "$tmp_dir"
  fail "下载失败：$REPO_URL"
  exit 1
}

detect_installed() {
  local found=""
  local seen=""
  for i in "${!TOOL_KEYS[@]}"; do
    local dir="${TOOL_DIRS[$i]}"
    if [[ -d "$dir" ]] && [[ -f "$dir/SKILL.md" ]]; then
      local real_dir
      real_dir=$(cd "$dir" 2>/dev/null && pwd -P || echo "$dir")
      if ! echo "|$seen|" | grep -q "|$real_dir|"; then
        found="${found} ${TOOL_KEYS[$i]}"
        seen="${seen}|${real_dir}"
      fi
    fi
  done
  echo "$found"
}

detect_other_installs() {
  DETECTED_DIRS=()
  DETECTED_NAMES=()
  local self_real
  self_real=$(cd "$SCRIPT_DIR" 2>/dev/null && pwd -P)
  local seen=""

  for i in "${!TOOL_KEYS[@]}"; do
    local dir="${TOOL_DIRS[$i]}"
    local name="${TOOL_LABELS[$i]}"
    if [[ -d "$dir" ]] && [[ -f "$dir/SKILL.md" ]]; then
      local real_dir
      real_dir=$(cd "$dir" 2>/dev/null && pwd -P || echo "$dir")
      if [[ "$real_dir" != "$self_real" ]] && ! echo "|$seen|" | grep -q "|$real_dir|"; then
        DETECTED_DIRS+=("$dir")
        DETECTED_NAMES+=("$name")
        seen="${seen}|${real_dir}"
      fi
    fi
  done
}

install_to_dir() {
  local source_dir="$1"
  local target_dir="$2"
  local tool_name="$3"

  local source_real target_real
  source_real=$(cd "$source_dir" 2>/dev/null && pwd -P)
  target_real=$(cd "$target_dir" 2>/dev/null && pwd -P || echo "$target_dir")

  if [[ "$source_real" == "$target_real" ]]; then
    ok "${tool_name}: 已是当前目录"
    return 0
  fi

  local env_backup=""
  local yce_cfg_backup=""

  [[ -f "$target_dir/.env" ]] && { env_backup=$(mktemp); cp "$target_dir/.env" "$env_backup"; }
  [[ -f "$target_dir/vendor/yce-tool.json" ]] && { yce_cfg_backup=$(mktemp); cp "$target_dir/vendor/yce-tool.json" "$yce_cfg_backup"; }

  mkdir -p "$target_dir"

  for item in "${INSTALL_FILES[@]}"; do
    if [[ -e "$source_dir/$item" ]]; then
      [[ -d "$source_dir/$item" ]] && rm -rf "$target_dir/$item"
      rm -f "$target_dir/$item"
      cp -R "$source_dir/$item" "$target_dir/$item"
    fi
  done

  if [[ -n "$env_backup" && -f "$env_backup" ]]; then
    cp "$env_backup" "$target_dir/.env"
    rm -f "$env_backup"
  elif [[ -f "$target_dir/.env.example" && ! -f "$target_dir/.env" ]]; then
    cp "$target_dir/.env.example" "$target_dir/.env"
  fi

  if [[ -n "$yce_cfg_backup" && -f "$yce_cfg_backup" ]]; then
    mkdir -p "$target_dir/vendor"
    cp "$yce_cfg_backup" "$target_dir/vendor/yce-tool.json"
    rm -f "$yce_cfg_backup"
  fi

  ok "${tool_name}: 已安装/更新"
}

sync_env_to_dir() {
  local target_dir="$1"
  local tool_name="$2"

  if [[ -f "$ENV_FILE" ]]; then
    mkdir -p "$target_dir"
    cp "$ENV_FILE" "$target_dir/.env"
    echo -e "  ${GREEN}✔${NC} ${BOLD}${tool_name}${NC}: .env 已同步"
  fi

  if [[ -f "$YCE_CFG_FILE" ]]; then
    mkdir -p "$target_dir/vendor"
    cp "$YCE_CFG_FILE" "$target_dir/vendor/yce-tool.json"
    echo -e "  ${GREEN}✔${NC} ${BOLD}${tool_name}${NC}: vendor/yce-tool.json 已同步"
  fi
}

pick_sync_targets() {
  local title="$1"
  echo ""
  echo "─── ${title} ───"
  echo ""

  for i in "${!DETECTED_DIRS[@]}"; do
    echo -e "  $((i+1))) ${BOLD}${DETECTED_NAMES[$i]}${NC}"
    echo -e "     ${DETECTED_DIRS[$i]}"
    echo ""
  done
  echo "  a) 全部"
  echo "  0) 跳过"
  echo ""

  local choice
  read -rp "请选择 [编号/a/0]: " choice

  PICKED_DIRS=()
  PICKED_NAMES=()

  [[ "$choice" == "0" ]] && return 0

  if [[ "$choice" == "a" || "$choice" == "A" ]]; then
    PICKED_DIRS=("${DETECTED_DIRS[@]}")
    PICKED_NAMES=("${DETECTED_NAMES[@]}")
    return 0
  fi

  IFS=',' read -ra selections <<< "$choice"
  for sel in "${selections[@]}"; do
    sel=$(echo "$sel" | tr -d ' ')
    local idx=$((sel - 1))
    if (( idx >= 0 && idx < ${#DETECTED_DIRS[@]} )); then
      PICKED_DIRS+=("${DETECTED_DIRS[$idx]}")
      PICKED_NAMES+=("${DETECTED_NAMES[$idx]}")
    fi
  done
}

detect_local_yce_binary() {
  local platform_dir filename candidate
  platform_dir="$(resolve_platform_dir)"
  filename="$(yce_binary_filename "$platform_dir")"
  candidate="$SCRIPT_DIR/vendor/$platform_dir/$filename"
  if [[ -f "$candidate" ]]; then
    echo "./vendor/$platform_dir/$filename"
  else
    echo "$DEFAULT_YCE_BINARY"
  fi
}

write_runtime_config() {
  local yce_token="$1"
  local yce_url="${2:-$DEFAULT_YCE_URL}"
  local youwen_script="${3:-$DEFAULT_YOUWEN_SCRIPT}"
  local youwen_api_url="${4:-$DEFAULT_YOUWEN_API_URL}"
  local youwen_token="${5:-}"
  local youwen_enhance_mode="${6:-$DEFAULT_YOUWEN_ENHANCE_MODE}"
  local youwen_enable_search="${7:-$DEFAULT_YOUWEN_ENABLE_SEARCH}"
  local youwen_mgrep_api_key="${8:-$DEFAULT_YOUWEN_MGREP_API_KEY}"
  local yce_search_script="${9:-$DEFAULT_YCE_SEARCH_SCRIPT}"
  local yce_binary="${10:-$(detect_local_yce_binary)}"
  local yce_max_lines_per_blob="${11:-$DEFAULT_YCE_MAX_LINES_PER_BLOB}"
  local yce_upload_timeout="${12:-$DEFAULT_YCE_UPLOAD_TIMEOUT}"
  local yce_upload_concurrency="${13:-$DEFAULT_YCE_UPLOAD_CONCURRENCY}"
  local yce_retrieval_timeout="${14:-$DEFAULT_YCE_RETRIEVAL_TIMEOUT}"
  local yce_no_adaptive="${15:-$DEFAULT_YCE_NO_ADAPTIVE}"
  local yce_no_webbrowser_enhance_prompt="${16:-$DEFAULT_YCE_NO_WEBBROWSER_ENHANCE_PROMPT}"
  local mode="${17:-$DEFAULT_MODE}"
  local timeout_enhance_ms="${18:-$DEFAULT_TIMEOUT_ENHANCE_MS}"
  local timeout_search_ms="${19:-$DEFAULT_TIMEOUT_SEARCH_MS}"

  [[ -z "$yce_token" ]] && { fail "--yce-token is required"; exit 1; }

  local youwen_abs yce_search_abs yce_binary_abs
  youwen_abs="$(resolve_path_from_script_dir "$youwen_script")"
  yce_search_abs="$(resolve_path_from_script_dir "$yce_search_script")"
  yce_binary_abs="$(resolve_path_from_script_dir "$yce_binary")"

  if [[ -z "$youwen_script" ]]; then
    warn "未检测到仓内 yce enhance 脚本：$DEFAULT_YOUWEN_SCRIPT"
  elif [[ ! -f "$youwen_abs" ]]; then
    warn "youwen.js not found at $youwen_script"
  fi
  [[ ! -f "$yce_search_abs" ]] && warn "yce search wrapper not found at $yce_search_script"
  [[ ! -f "$yce_binary_abs" ]] && warn "yce-tool-rs not found at $yce_binary"

  echo "Generating .env..."
  cat > "$ENV_FILE" <<ENVEOF
# YCE runtime configuration
# Generated at $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# yw-enhance adapter
YCE_YOUWEN_SCRIPT=$youwen_script
YCE_YOUWEN_API_URL=$youwen_api_url
YCE_YOUWEN_TOKEN=$youwen_token
YCE_YOUWEN_ENHANCE_MODE=$youwen_enhance_mode
YCE_YOUWEN_ENABLE_SEARCH=$youwen_enable_search
YCE_YOUWEN_MGREP_API_KEY=$youwen_mgrep_api_key

# yce adapter
YCE_SEARCH_SCRIPT=$yce_search_script
YCE_BINARY=$yce_binary
YCE_CONFIG=./vendor/yce-tool.json
YCE_MAX_LINES_PER_BLOB=$yce_max_lines_per_blob
YCE_UPLOAD_TIMEOUT=$yce_upload_timeout
YCE_UPLOAD_CONCURRENCY=$yce_upload_concurrency
YCE_RETRIEVAL_TIMEOUT=$yce_retrieval_timeout
YCE_NO_ADAPTIVE=$yce_no_adaptive
YCE_NO_WEBBROWSER_ENHANCE_PROMPT=$yce_no_webbrowser_enhance_prompt

# yce orchestrator (milliseconds)
YCE_DEFAULT_MODE=$mode
YCE_TIMEOUT_ENHANCE_MS=$timeout_enhance_ms
YCE_TIMEOUT_SEARCH_MS=$timeout_search_ms
ENVEOF

  mkdir -p "$SCRIPT_DIR/vendor"
  echo "Generating vendor/yce-tool.json..."
  cat > "$YCE_CFG_FILE" <<CFGEOF
{
  "base_url": "$yce_url",
  "token": "$yce_token"
}
CFGEOF

  ok "配置完成"
  echo "  .env: $ENV_FILE"
  echo "  yce-tool.json: $YCE_CFG_FILE"
  echo "  yce base_url: $yce_url"
  [[ -n "$youwen_token" ]] && echo "  兑换码 / Token: $(mask_secret "$youwen_token")"
}

cmd_install() {
  local target_tool="$1"
  check_node

  echo ""
  printf "${BLUE}╔══════════════════════════════════════════════╗${NC}\n"
  printf "${BLUE}║${NC}  ${BOLD}${CYAN}YCE${NC} 安装 / 更新                            ${BLUE}║${NC}\n"
  printf "${BLUE}╚══════════════════════════════════════════════╝${NC}\n"
  echo ""

  local source_dir="$SCRIPT_DIR"
  local local_ver remote_ver need_cleanup=false
  local_ver=$(get_local_version "$SCRIPT_DIR")
  remote_ver=$(get_remote_version || true)

  if [[ -n "$remote_ver" ]]; then
    info "远程最新版本: ${BOLD}${remote_ver}${NC}"
  else
    warn "无法获取远程版本，将优先使用本地文件"
  fi

  if [[ ! -f "$SCRIPT_DIR/SKILL.md" || ! -d "$SCRIPT_DIR/scripts" || ! -f "$SCRIPT_DIR/install.sh" ]]; then
    source_dir=$(download_latest)
    need_cleanup=true
    ok "已下载最新版本"
  elif [[ -n "$remote_ver" && -n "$local_ver" ]]; then
    local cmp
    cmp=$(compare_semver "$local_ver" "$remote_ver")
    if [[ "$cmp" == "-1" ]]; then
      info "本地版本 ${local_ver} 低于远程版本 ${remote_ver}，下载最新版本..."
      source_dir=$(download_latest)
      need_cleanup=true
      ok "已下载最新版本"
    else
      info "使用本地版本: ${BOLD}${local_ver}${NC}"
    fi
  else
    info "使用当前目录中的本地文件"
  fi

  if [[ -n "$target_tool" ]]; then
    local dir label
    dir=$(tool_dir_by_key "$target_tool" 2>/dev/null) || true
    label=$(tool_label_by_key "$target_tool" 2>/dev/null) || true
    if [[ -z "$dir" ]]; then
      fail "未知工具: $target_tool"
      echo "支持: ${TOOL_KEYS[*]}"
      exit 1
    fi
    install_to_dir "$source_dir" "$dir" "$label"
  else
    local installed
    read -ra installed <<< "$(detect_installed)"

    if [[ ${#installed[@]} -eq 0 || -z "${installed[0]}" ]]; then
      echo "选择安装目标:"
      echo ""
      for i in "${!TOOL_KEYS[@]}"; do
        printf "  %d) %s\n" "$((i+1))" "${TOOL_LABELS[$i]}"
      done
      echo ""
      echo "  a) 全部安装"
      echo ""

      local choice
      read -rp "请选择 [1-${#TOOL_KEYS[@]}/a]: " choice
      if [[ "$choice" == "a" || "$choice" == "A" ]]; then
        for i in "${!TOOL_KEYS[@]}"; do
          install_to_dir "$source_dir" "${TOOL_DIRS[$i]}" "${TOOL_LABELS[$i]}"
        done
      else
        IFS=',' read -ra selections <<< "$choice"
        for sel in "${selections[@]}"; do
          sel=$(echo "$sel" | tr -d ' ')
          local idx=$((sel - 1))
          (( idx >= 0 && idx < ${#TOOL_KEYS[@]} )) && install_to_dir "$source_dir" "${TOOL_DIRS[$idx]}" "${TOOL_LABELS[$idx]}"
        done
      fi
    else
      info "更新已安装的实例..."
      echo ""
      for tool in "${installed[@]}"; do
        local dir label
        dir=$(tool_dir_by_key "$tool")
        label=$(tool_label_by_key "$tool")
        install_to_dir "$source_dir" "$dir" "$label"
      done
    fi
  fi

  [[ "$need_cleanup" == true && -n "$source_dir" ]] && rm -rf "$(dirname "$source_dir")"

  echo ""
  ok "完成"
  echo ""
  printf "  配置: ${CYAN}bash install.sh --setup${NC}\n"
  printf "  直写: ${CYAN}bash install.sh --setup --yce-token \"your-token\" --youwen-token \"your-redemption-code\"${NC}\n"
  printf "  测试: ${CYAN}node scripts/yce.js \"定位 provider 列表获取逻辑\" --mode search${NC}\n"
  echo ""
}

cmd_setup() {
  check_node
  echo ""

  local has_direct_args=false
  local yce_url=""
  local yce_token=""
  local youwen_script=""
  local youwen_api_url=""
  local youwen_token=""
  local youwen_enhance_mode=""
  local youwen_enable_search=""
  local youwen_mgrep_api_key=""
  local yce_search_script=""
  local yce_binary=""
  local yce_max_lines_per_blob=""
  local yce_upload_timeout=""
  local yce_upload_concurrency=""
  local yce_retrieval_timeout=""
  local yce_no_adaptive=""
  local yce_no_webbrowser_enhance_prompt=""
  local mode=""
  local timeout_enhance_ms=""
  local timeout_search_ms=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yce-url) has_direct_args=true; yce_url="$2"; shift 2 ;;
      --yce-token) has_direct_args=true; yce_token="$2"; shift 2 ;;
      --youwen-script) has_direct_args=true; youwen_script="$2"; shift 2 ;;
      --youwen-api-url) has_direct_args=true; youwen_api_url="$2"; shift 2 ;;
      --youwen-token) has_direct_args=true; youwen_token="$2"; shift 2 ;;
      --youwen-enhance-mode) has_direct_args=true; youwen_enhance_mode="$2"; shift 2 ;;
      --youwen-enable-search) has_direct_args=true; youwen_enable_search="$2"; shift 2 ;;
      --youwen-mgrep-api-key) has_direct_args=true; youwen_mgrep_api_key="$2"; shift 2 ;;
      --yce-search-script) has_direct_args=true; yce_search_script="$2"; shift 2 ;;
      --yce-binary) has_direct_args=true; yce_binary="$2"; shift 2 ;;
      --yce-max-lines-per-blob) has_direct_args=true; yce_max_lines_per_blob="$2"; shift 2 ;;
      --yce-upload-timeout) has_direct_args=true; yce_upload_timeout="$2"; shift 2 ;;
      --yce-upload-concurrency) has_direct_args=true; yce_upload_concurrency="$2"; shift 2 ;;
      --yce-retrieval-timeout) has_direct_args=true; yce_retrieval_timeout="$2"; shift 2 ;;
      --yce-no-adaptive) has_direct_args=true; yce_no_adaptive="$2"; shift 2 ;;
      --yce-no-webbrowser-enhance-prompt) has_direct_args=true; yce_no_webbrowser_enhance_prompt="$2"; shift 2 ;;
      --mode) has_direct_args=true; mode="$2"; shift 2 ;;
      --timeout-enhance) has_direct_args=true; timeout_enhance_ms="$2"; shift 2 ;;
      --timeout-search) has_direct_args=true; timeout_search_ms="$2"; shift 2 ;;
      *)
        fail "未知参数: $1"
        exit 1
        ;;
    esac
  done

  youwen_script="${youwen_script:-$(read_env_file_value "YCE_YOUWEN_SCRIPT")}"
  local repo_youwen_abs
  repo_youwen_abs="$(resolve_path_from_script_dir "$DEFAULT_YOUWEN_SCRIPT")"
  if [[ -f "$repo_youwen_abs" ]]; then
    if [[ -n "$youwen_script" && "$youwen_script" != "$DEFAULT_YOUWEN_SCRIPT" ]]; then
      warn "检测到旧的外部 YCE_YOUWEN_SCRIPT，已切换为仓内脚本: $DEFAULT_YOUWEN_SCRIPT"
    fi
    youwen_script="$DEFAULT_YOUWEN_SCRIPT"
  else
    [[ -z "$youwen_script" ]] && youwen_script="$DEFAULT_YOUWEN_SCRIPT"
  fi

  local upstream_youwen_env
  upstream_youwen_env="$(resolve_youwen_env_file "$youwen_script")"

  yce_url="${yce_url:-$(read_json_file_value "$YCE_CFG_FILE" "base_url")}"
  [[ -z "$yce_url" ]] && yce_url="$DEFAULT_YCE_URL"

  yce_token="${yce_token:-$(read_json_file_value "$YCE_CFG_FILE" "token")}"

  youwen_api_url="${youwen_api_url:-$(read_env_file_value "YCE_YOUWEN_API_URL")}"
  [[ -z "$youwen_api_url" && -n "$upstream_youwen_env" ]] && youwen_api_url="$(read_env_file_value "YOUWEN_API_URL" "$upstream_youwen_env")"
  [[ -z "$youwen_api_url" ]] && youwen_api_url="$DEFAULT_YOUWEN_API_URL"

  youwen_token="${youwen_token:-$(read_env_file_value "YCE_YOUWEN_TOKEN")}"
  [[ -z "$youwen_token" && -n "$upstream_youwen_env" ]] && youwen_token="$(read_env_file_value "YOUWEN_TOKEN" "$upstream_youwen_env")"

  youwen_enhance_mode="${youwen_enhance_mode:-$(read_env_file_value "YCE_YOUWEN_ENHANCE_MODE")}"
  [[ -z "$youwen_enhance_mode" && -n "$upstream_youwen_env" ]] && youwen_enhance_mode="$(read_env_file_value "YOUWEN_ENHANCE_MODE" "$upstream_youwen_env")"
  [[ -z "$youwen_enhance_mode" ]] && youwen_enhance_mode="$DEFAULT_YOUWEN_ENHANCE_MODE"

  youwen_enable_search="${youwen_enable_search:-$(read_env_file_value "YCE_YOUWEN_ENABLE_SEARCH")}"
  [[ -z "$youwen_enable_search" && -n "$upstream_youwen_env" ]] && youwen_enable_search="$(read_env_file_value "YOUWEN_ENABLE_SEARCH" "$upstream_youwen_env")"
  [[ -z "$youwen_enable_search" ]] && youwen_enable_search="$DEFAULT_YOUWEN_ENABLE_SEARCH"

  youwen_mgrep_api_key="${youwen_mgrep_api_key:-$(read_env_file_value "YCE_YOUWEN_MGREP_API_KEY")}"
  [[ -z "$youwen_mgrep_api_key" && -n "$upstream_youwen_env" ]] && youwen_mgrep_api_key="$(read_env_file_value "YOUWEN_MGREP_API_KEY" "$upstream_youwen_env")"

  yce_search_script="${yce_search_script:-$(read_env_file_value "YCE_SEARCH_SCRIPT")}"
  [[ -z "$yce_search_script" ]] && yce_search_script="$DEFAULT_YCE_SEARCH_SCRIPT"

  yce_binary="${yce_binary:-$(read_env_file_value "YCE_BINARY")}"
  [[ -z "$yce_binary" ]] && yce_binary="$(detect_local_yce_binary)"

  yce_max_lines_per_blob="${yce_max_lines_per_blob:-$(read_env_file_value "YCE_MAX_LINES_PER_BLOB")}"
  [[ -z "$yce_max_lines_per_blob" ]] && yce_max_lines_per_blob="$DEFAULT_YCE_MAX_LINES_PER_BLOB"

  yce_upload_timeout="${yce_upload_timeout:-$(read_env_file_value "YCE_UPLOAD_TIMEOUT")}"
  [[ -z "$yce_upload_timeout" ]] && yce_upload_timeout="$DEFAULT_YCE_UPLOAD_TIMEOUT"

  yce_upload_concurrency="${yce_upload_concurrency:-$(read_env_file_value "YCE_UPLOAD_CONCURRENCY")}"
  [[ -z "$yce_upload_concurrency" ]] && yce_upload_concurrency="$DEFAULT_YCE_UPLOAD_CONCURRENCY"

  yce_retrieval_timeout="${yce_retrieval_timeout:-$(read_env_file_value "YCE_RETRIEVAL_TIMEOUT")}"
  [[ -z "$yce_retrieval_timeout" ]] && yce_retrieval_timeout="$DEFAULT_YCE_RETRIEVAL_TIMEOUT"

  yce_no_adaptive="${yce_no_adaptive:-$(read_env_file_value "YCE_NO_ADAPTIVE")}"
  [[ -z "$yce_no_adaptive" ]] && yce_no_adaptive="$DEFAULT_YCE_NO_ADAPTIVE"

  yce_no_webbrowser_enhance_prompt="${yce_no_webbrowser_enhance_prompt:-$(read_env_file_value "YCE_NO_WEBBROWSER_ENHANCE_PROMPT")}"
  [[ -z "$yce_no_webbrowser_enhance_prompt" ]] && yce_no_webbrowser_enhance_prompt="$DEFAULT_YCE_NO_WEBBROWSER_ENHANCE_PROMPT"

  mode="${mode:-$(read_env_file_value "YCE_DEFAULT_MODE")}"
  [[ -z "$mode" ]] && mode="$DEFAULT_MODE"

  timeout_enhance_ms="${timeout_enhance_ms:-$(read_env_file_value "YCE_TIMEOUT_ENHANCE_MS")}"
  [[ -z "$timeout_enhance_ms" ]] && timeout_enhance_ms="$DEFAULT_TIMEOUT_ENHANCE_MS"

  timeout_search_ms="${timeout_search_ms:-$(read_env_file_value "YCE_TIMEOUT_SEARCH_MS")}"
  [[ -z "$timeout_search_ms" ]] && timeout_search_ms="$DEFAULT_TIMEOUT_SEARCH_MS"

  if [[ "$has_direct_args" == false ]]; then
    echo "─── 交互式配置 ───"
    echo ""
    printf "${CYAN}${BOLD}提示：${NC} YCE 密钥请前往 ${BOLD}https://yce.aige.de${NC} 获取\n"
    echo ""
    if [[ -n "$yce_token" ]]; then
      echo "YCE Token 当前: $(mask_secret "$yce_token")"
      read -rp "YCE Token（回车保留）: " new_val
      [[ -n "$new_val" ]] && yce_token="$new_val"
    else
      read -rp "YCE Token（必填）: " yce_token
    fi
    echo ""

    printf "${CYAN}${BOLD}提示：${NC} 兑换码请前往 ${BOLD}https://a.aigy.de${NC} 获取\n"
    echo ""
    echo "兑换码 / Token 当前: ${youwen_token:+$(mask_secret "$youwen_token")}"
    [[ -z "$youwen_token" ]] && echo "兑换码 / Token 当前: (空)"
    read -rp "兑换码 / Token（回车保留）: " new_val
    [[ -n "$new_val" ]] && youwen_token="$new_val"
    echo ""

    echo "YCE URL 当前: $yce_url"
    read -rp "YCE URL（回车保留）: " new_val
    [[ -n "$new_val" ]] && yce_url="$new_val"
    echo ""

    if [[ -n "$youwen_script" ]]; then
      echo "yw-enhance 脚本: $youwen_script"
    else
      echo "yw-enhance 脚本: 未检测到仓内脚本"
    fi
    echo ""

    echo "yw-enhance API 当前: $youwen_api_url"
    read -rp "yw-enhance API（回车保留）: " new_val
    [[ -n "$new_val" ]] && youwen_api_url="$new_val"
    echo ""

    echo "增强超时当前: $timeout_enhance_ms"
    read -rp "增强超时 ms（回车保留）: " new_val
    [[ -n "$new_val" ]] && timeout_enhance_ms="$new_val"
    echo ""

    echo "检索超时当前: $timeout_search_ms"
    read -rp "检索超时 ms（回车保留）: " new_val
    [[ -n "$new_val" ]] && timeout_search_ms="$new_val"
    echo ""
  fi

  info "生成 .env 和 vendor/yce-tool.json"
  write_runtime_config \
    "$yce_token" \
    "$yce_url" \
    "$youwen_script" \
    "$youwen_api_url" \
    "$youwen_token" \
    "$youwen_enhance_mode" \
    "$youwen_enable_search" \
    "$youwen_mgrep_api_key" \
    "$yce_search_script" \
    "$yce_binary" \
    "$yce_max_lines_per_blob" \
    "$yce_upload_timeout" \
    "$yce_upload_concurrency" \
    "$yce_retrieval_timeout" \
    "$yce_no_adaptive" \
    "$yce_no_webbrowser_enhance_prompt" \
    "$mode" \
    "$timeout_enhance_ms" \
    "$timeout_search_ms"
}

cmd_sync() {
  detect_other_installs
  [[ ${#DETECTED_DIRS[@]} -eq 0 ]] && { warn "未检测到其他已安装的 YCE"; return 0; }

  pick_sync_targets "同步 YCE 脚本 + 配置到其他工具"
  [[ ${#PICKED_DIRS[@]} -eq 0 ]] && { echo "已跳过"; return 0; }

  echo ""
  for i in "${!PICKED_DIRS[@]}"; do
    install_to_dir "$SCRIPT_DIR" "${PICKED_DIRS[$i]}" "${PICKED_NAMES[$i]}"
    sync_env_to_dir "${PICKED_DIRS[$i]}" "${PICKED_NAMES[$i]}"
  done
  echo ""
}

cmd_sync_env() {
  detect_other_installs
  [[ ${#DETECTED_DIRS[@]} -eq 0 ]] && { warn "未检测到其他已安装的 YCE"; return 0; }

  pick_sync_targets "仅同步 .env 和 YCE 配置"
  [[ ${#PICKED_DIRS[@]} -eq 0 ]] && { echo "已跳过"; return 0; }

  echo ""
  for i in "${!PICKED_DIRS[@]}"; do
    sync_env_to_dir "${PICKED_DIRS[$i]}" "${PICKED_NAMES[$i]}"
  done
  echo ""
}

cmd_uninstall() {
  echo ""
  printf "${BOLD}${CYAN}YCE 卸载${NC}\n"
  echo ""

  local installed
  read -ra installed <<< "$(detect_installed)"
  [[ ${#installed[@]} -eq 0 || -z "${installed[0]}" ]] && { warn "未检测到任何已安装的 YCE"; return 0; }

  echo "检测到以下安装:"
  echo ""
  for i in "${!installed[@]}"; do
    local tool="${installed[$i]}"
    local dir label
    dir=$(tool_dir_by_key "$tool")
    label=$(tool_label_by_key "$tool")
    printf "  %d) %s  ${DIM}%s${NC}\n" "$((i+1))" "$label" "$dir"
  done
  echo ""
  echo "  a) 全部卸载"
  echo "  0) 取消"
  echo ""

  local choice
  read -rp "请选择 [编号/a/0]: " choice
  [[ "$choice" == "0" ]] && { echo "已取消"; return 0; }

  local targets=()
  if [[ "$choice" == "a" || "$choice" == "A" ]]; then
    targets=("${installed[@]}")
  else
    IFS=',' read -ra selections <<< "$choice"
    for sel in "${selections[@]}"; do
      sel=$(echo "$sel" | tr -d ' ')
      local idx=$((sel - 1))
      (( idx >= 0 && idx < ${#installed[@]} )) && targets+=("${installed[$idx]}")
    done
  fi

  echo ""
  for tool in "${targets[@]}"; do
    local dir label
    dir=$(tool_dir_by_key "$tool")
    label=$(tool_label_by_key "$tool")
    [[ -f "$dir/.env" ]] && cp "$dir/.env" "$dir/.env.uninstall-backup"
    [[ -f "$dir/vendor/yce-tool.json" ]] && cp "$dir/vendor/yce-tool.json" "$dir/vendor/yce-tool.json.uninstall-backup"
    rm -rf "$dir"
    ok "已卸载: ${label}"
  done
  echo ""
}

cmd_check() {
  echo ""
  printf "${BOLD}${CYAN}YCE 安装检查${NC}\n"
  echo ""

  local remote_ver local_ver
  remote_ver=$(get_remote_version || true)
  local_ver=$(get_local_version "$SCRIPT_DIR")
  [[ -n "$remote_ver" ]] && info "远程最新版本: ${BOLD}${remote_ver}${NC}"
  [[ -n "$local_ver" ]] && info "当前本地版本: ${BOLD}${local_ver}${NC}"
  echo ""

  local installed
  read -ra installed <<< "$(detect_installed)"
  if [[ ${#installed[@]} -eq 0 || -z "${installed[0]}" ]]; then
    warn "未检测到任何已安装的 YCE"
  else
    for tool in "${installed[@]}"; do
      local dir label
      dir=$(tool_dir_by_key "$tool")
      label=$(tool_label_by_key "$tool")
      ok "${label}: $dir"
    done
  fi

  if [[ -f "$ENV_FILE" ]]; then
    ok "本地 .env 已存在"
  else
    warn "本地 .env 不存在，可运行 bash install.sh --setup"
  fi

  if [[ -f "$YCE_CFG_FILE" ]]; then
    ok "本地 vendor/yce-tool.json 已存在"
  else
    warn "本地 vendor/yce-tool.json 不存在，可运行 bash install.sh --setup"
  fi
  echo ""
}

cmd_menu() {
  echo ""
  printf "${BLUE}╔══════════════════════════════════════════════╗${NC}\n"
  printf "${BLUE}║${NC}  ${BOLD}${CYAN}YCE${NC} 管理工具                               ${BLUE}║${NC}\n"
  printf "${BLUE}╚══════════════════════════════════════════════╝${NC}\n"
  echo ""

  local installed
  read -ra installed <<< "$(detect_installed)"
  local has_install=false
  [[ ${#installed[@]} -gt 0 && -n "${installed[0]}" ]] && has_install=true

  if [[ "$has_install" == true ]]; then
    echo -e "  ${GREEN}●${NC} 已安装到:"
    for tool in "${installed[@]}"; do
      local label dir
      label=$(tool_label_by_key "$tool")
      dir=$(tool_dir_by_key "$tool")
      echo -e "    ${BOLD}${label}${NC} ${DIM}${dir}${NC}"
    done
    echo ""
    echo "  1) 📦 更新已安装实例"
    echo "  2) ⚙️  生成 / 修改配置"
    echo "  3) 🔄 同步脚本 + 配置"
    echo "  4) 🔍 检查安装状态"
    echo "  5) 🗑️  卸载"
    echo "  0) 退出"
  else
    echo -e "  ${YELLOW}●${NC} 尚未安装"
    echo ""
    echo "  1) 📦 安装"
    echo "  2) ⚙️  生成配置"
    echo "  3) 🔍 检查安装状态"
    echo "  0) 退出"
  fi
  echo ""

  local choice
  read -rp "请选择: " choice

  if [[ "$has_install" == true ]]; then
    case "$choice" in
      1) cmd_install "" ;;
      2) cmd_setup ;;
      3) cmd_sync ;;
      4) cmd_check ;;
      5) cmd_uninstall ;;
      0) echo "再见 👋"; exit 0 ;;
      *) warn "无效选择"; exit 1 ;;
    esac
  else
    case "$choice" in
      1) cmd_install "" ;;
      2) cmd_setup ;;
      3) cmd_check ;;
      0) echo "再见 👋"; exit 0 ;;
      *) warn "无效选择"; exit 1 ;;
    esac
  fi
}

print_help() {
  echo "YCE 安装 / 更新 / 配置脚本"
  echo ""
  echo "用法:"
  echo "  bash install.sh                            # 交互式菜单（推荐）"
  echo "  bash install.sh --install                  # 安装或更新（必要时自动下载远程最新版本）"
  echo "  bash install.sh --target agents            # 仅安装到指定工具"
  echo "  bash install.sh --setup                    # 交互式配置 YCE Token / 兑换码 / API（默认使用仓内 scripts/youwen.js）"
  echo "  bash install.sh --setup --yce-token <t> --youwen-script <path> --youwen-token <code>  # 直接写入 YCE Token + yw-enhance 路径 + 兑换码 / Token"
  echo "  bash install.sh --sync                     # 同步脚本 + 配置到其他已安装目录"
  echo "  bash install.sh --sync-env                 # 仅同步 .env 和 vendor/yce-tool.json"
  echo "  bash install.sh --check                    # 检查安装状态"
  echo "  bash install.sh --uninstall                # 卸载"
  echo ""
  echo "支持的工具: ${TOOL_KEYS[*]}"
  echo ""
  echo "说明:"
  echo "  - 默认 YCE 地址: $DEFAULT_YCE_URL"
  echo "  - --setup 会优先复用当前 .env / vendor/yce-tool.json，并优先对齐仓内 scripts/youwen.js 对应的 YCE 根目录配置"
  echo "  - YCE_YOUWEN_SCRIPT 默认使用仓内脚本: $DEFAULT_YOUWEN_SCRIPT；如需特殊覆盖，仍可通过 --youwen-script 或 .env 指定"
  echo "  - 会按当前系统自动选择 YCE wrapper（Windows 用 yce-search.ps1，其它系统用 yce-search.sh）"
  echo "  - 本仓已内置 yce search / yce enhance 脚本，以及 darwin-arm64 / windows-x64 yce binary"
  echo "  - scripts/lib/* 是内部模块，不应直接配置成 YCE_YOUWEN_SCRIPT"
  echo "  - 可交互配置：YCE Token、YCE URL、兑换码 / Token、yw-enhance API"
  echo "  - yw-enhance 扩展参数: --youwen-api-url --youwen-token --youwen-enhance-mode --youwen-enable-search --youwen-mgrep-api-key"
  echo "  - YCE 扩展参数: --yce-max-lines-per-blob --yce-upload-timeout --yce-upload-concurrency --yce-retrieval-timeout --yce-no-adaptive --yce-no-webbrowser-enhance-prompt --timeout-enhance --timeout-search"
  echo "  - 远程仓地址: $REPO_URL"
}

main() {
  local cmd="" target=""
  local setup_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check)
        cmd="check"
        shift
        ;;
      --install)
        cmd="install"
        shift
        ;;
      --uninstall)
        cmd="uninstall"
        shift
        ;;
      --setup)
        cmd="setup"
        shift
        ;;
      --sync)
        cmd="sync"
        shift
        ;;
      --sync-env)
        cmd="sync-env"
        shift
        ;;
      --target)
        shift
        target="${1:-}"
        shift || true
        ;;
      --help|-h)
        cmd="help"
        shift
        ;;
      --yce-url|--yce-token|--youwen-script|--youwen-api-url|--youwen-token|--youwen-enhance-mode|--youwen-enable-search|--youwen-mgrep-api-key|--yce-search-script|--yce-binary|--yce-max-lines-per-blob|--yce-upload-timeout|--yce-upload-concurrency|--yce-retrieval-timeout|--yce-no-adaptive|--yce-no-webbrowser-enhance-prompt|--mode|--timeout-enhance|--timeout-search)
        setup_args+=("$1")
        shift
        [[ $# -gt 0 ]] && {
          setup_args+=("$1")
          shift
        }
        ;;
      *)
        shift
        ;;
    esac
  done

  [[ -n "$target" && -z "$cmd" ]] && cmd="install"

  case "$cmd" in
    help) print_help ;;
    check) cmd_check ;;
    install) cmd_install "$target" ;;
    uninstall) cmd_uninstall ;;
    setup) cmd_setup "${setup_args[@]}" ;;
    sync) cmd_sync ;;
    sync-env) cmd_sync_env ;;
    "")
      if [[ ! -t 0 ]]; then
        cmd_install "$target"
      else
        cmd_menu
      fi
      ;;
  esac
}

main "$@"
