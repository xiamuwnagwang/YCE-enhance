#!/usr/bin/env bash
# yw-enhance 一键安装 / 更新 / 配置脚本 (macOS / Linux)
#
# 用法:
#   # 远程安装（推荐）
#   curl -fsSL https://raw.githubusercontent.com/xiamuwnagwang/YCE-enhance/main/install.sh | bash
#
#   # 本地操作
#   bash install.sh                    # 安装或更新
#   bash install.sh --target claude    # 仅安装到指定工具
#   bash install.sh --check            # 检查版本
#   bash install.sh --uninstall        # 卸载
#   bash install.sh --setup            # 交互式配置环境变量
#   bash install.sh --setup --edit     # 强制编辑配置
#   bash install.sh --setup --reset    # 重置配置
#   bash install.sh --sync             # 同步脚本 + 配置到已安装目录
#   bash install.sh --sync-env         # 仅同步 .env

set -eo pipefail

# ==================== 常量 ====================

REPO_URL="https://github.com/xiamuwnagwang/YCE-enhance"
REPO_ARCHIVE_FALLBACK="https://github.com/xiamuwnagwang/YCE-enhance/archive/refs/heads/main.tar.gz"
API_URL="https://b.aigy.de"
SKILL_NAME="yw-enhance"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# 颜色
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
CYAN='\033[36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ==================== 工具目录映射 ====================

TOOL_KEYS=("claude" "opencode" "cursor" "windsurf" "cline" "continue" "codium" "aider")
TOOL_LABELS=("Claude Code" "OpenCode" "Cursor" "Windsurf" "Cline" "Continue" "Codium" "Aider")
TOOL_DIRS=(
  "$HOME/.claude/skills/$SKILL_NAME"
  "$HOME/.config/opencode/skill/$SKILL_NAME"
  "$HOME/.cursor/skills/$SKILL_NAME"
  "$HOME/.windsurf/skills/$SKILL_NAME"
  "$HOME/.cline/skills/$SKILL_NAME"
  "$HOME/.continue/skills/$SKILL_NAME"
  "$HOME/.codium/skills/$SKILL_NAME"
  "$HOME/.aider/skills/$SKILL_NAME"
)

# 需要安装/同步的文件（排除 .env, .omc, .git 等）
INSTALL_FILES=("scripts" "references" "SKILL.md" "quickstart.sh" "install.sh" "install.ps1" ".env.example" ".gitignore")

# .env 变量定义: key|label|default|required|secret|options
ENV_VARS=(
  "YOUWEN_API_URL|后端 API 地址|https://b.aigy.de|0|0|"
  "YOUWEN_TOKEN|兑换码 / Token||1|1|"
  "YOUWEN_ENHANCE_MODE|增强模式|agent|0|0|agent,disabled"
  "YOUWEN_ENABLE_SEARCH|启用联合搜索|true|0|0|true,false"
  "YOUWEN_MGREP_API_KEY|Mixedbread 语义检索 API Key||0|1|"
  "YOUWEN_CALL_MODE|调用模式|smart|0|0|smart,always"
)

# ==================== 基础工具函数 ====================

info()  { printf "${BLUE}▸${NC} %b\n" "$1"; }
ok()    { printf "${GREEN}✔${NC} %b\n" "$1"; }
warn()  { printf "${YELLOW}⚠${NC} %b\n" "$1"; }
fail()  { printf "${RED}✘${NC} %b\n" "$1"; }

tool_index() {
  local key="$1"
  for i in "${!TOOL_KEYS[@]}"; do
    [[ "${TOOL_KEYS[$i]}" == "$key" ]] && { echo "$i"; return 0; }
  done
  return 1
}

tool_dir_by_key()   { local i; i=$(tool_index "$1") && echo "${TOOL_DIRS[$i]}"; }
tool_label_by_key() { local i; i=$(tool_index "$1") && echo "${TOOL_LABELS[$i]}"; }

get_local_version() {
  local dir="$1"
  [[ -f "$dir/SKILL.md" ]] && grep -m1 '^version:' "$dir/SKILL.md" 2>/dev/null | sed 's/version:[[:space:]]*//' | tr -d '[:space:]'
}

compare_semver() {
  local a="$1" b="$2"; local IFS='.'
  read -ra pa <<< "$a"; read -ra pb <<< "$b"
  for i in 0 1 2; do
    local va=${pa[$i]:-0} vb=${pb[$i]:-0}
    (( va < vb )) && { echo "-1"; return; }
    (( va > vb )) && { echo "1"; return; }
  done
  echo "0"
}

check_node() {
  if command -v node &>/dev/null; then
    ok "Node.js $(node -v)"
    return 0
  fi
  fail "未安装 Node.js（需要 v16+）"
  echo ""
  echo "  安装方式:"
  echo "    macOS:   brew install node"
  echo "    Linux:   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -"
  echo "    Windows: winget install OpenJS.NodeJS.LTS"
  exit 1
}

# ==================== 远程版本 / 下载 ====================

get_remote_info() {
  local result
  result=$(curl -sf --max-time 10 "${API_URL}/api/skill/version?name=${SKILL_NAME}" 2>/dev/null || echo "")
  if [[ -n "$result" ]]; then
    local ver dl
    ver=$(echo "$result" | grep -o '"latest_version":"[^"]*"' 2>/dev/null | cut -d'"' -f4)
    [[ -z "$ver" ]] && ver=$(echo "$result" | grep -o '"version":"[^"]*"' 2>/dev/null | cut -d'"' -f4)
    dl=$(echo "$result" | grep -o '"downloadUrl":"[^"]*"' 2>/dev/null | cut -d'"' -f4)
    [[ -z "$dl" ]] && dl=$(echo "$result" | grep -o '"download_url":"[^"]*"' 2>/dev/null | cut -d'"' -f4)
    echo "${ver:-}|${dl:-}"
  fi
}

download_latest() {
  local tmp_dir; tmp_dir=$(mktemp -d)
  trap "rm -rf '$tmp_dir'" EXIT

  info "下载最新版本..."
  local dl_url downloaded=false
  dl_url=$(get_remote_info | cut -d'|' -f2)

  if [[ -n "$dl_url" ]]; then
    info "使用后端下载地址: $dl_url"
    if echo "$dl_url" | grep -q '\.tar\.gz$'; then
      curl -fsSL "$dl_url" | tar -xz -C "$tmp_dir" 2>/dev/null && downloaded=true
    elif echo "$dl_url" | grep -q '\.zip$'; then
      curl -fsSL "$dl_url" -o "$tmp_dir/repo.zip" 2>/dev/null && \
        unzip -q "$tmp_dir/repo.zip" -d "$tmp_dir" 2>/dev/null && downloaded=true
    else
      git clone --depth 1 "$dl_url" "$tmp_dir/repo" 2>/dev/null && downloaded=true
    fi
  fi

  if [[ "$downloaded" != true ]] && command -v git &>/dev/null; then
    warn "尝试 git clone..."
    git clone --depth 1 "$REPO_URL.git" "$tmp_dir/repo" 2>/dev/null && downloaded=true
  fi

  if [[ "$downloaded" != true ]]; then
    warn "尝试 tarball 下载..."
    curl -fsSL "$REPO_ARCHIVE_FALLBACK" | tar -xz -C "$tmp_dir" 2>/dev/null && downloaded=true
  fi

  [[ "$downloaded" != true ]] && { fail "下载失败"; exit 1; }

  if [[ ! -d "$tmp_dir/repo" ]]; then
    local extracted
    extracted=$(find "$tmp_dir" -maxdepth 1 -type d ! -name "$(basename "$tmp_dir")" | head -1)
    [[ -n "$extracted" ]] && mv "$extracted" "$tmp_dir/repo"
  fi

  [[ ! -d "$tmp_dir/repo" ]] && { fail "下载后未找到有效文件"; exit 1; }
  echo "$tmp_dir/repo"
  trap - EXIT
}

# ==================== 已安装检测 ====================

detect_installed() {
  local found=""
  for i in "${!TOOL_KEYS[@]}"; do
    local dir="${TOOL_DIRS[$i]}"
    if [[ -d "$dir" ]] && { [[ -f "$dir/SKILL.md" ]] || [[ -f "$dir/scripts/youwen.js" ]]; }; then
      found="${found} ${TOOL_KEYS[$i]}"
    fi
  done
  echo "$found"
}

detect_other_installs() {
  DETECTED_DIRS=(); DETECTED_NAMES=()
  local self_real; self_real=$(cd "$SCRIPT_DIR" 2>/dev/null && pwd -P)
  for i in "${!TOOL_KEYS[@]}"; do
    local dir="${TOOL_DIRS[$i]}" name="${TOOL_LABELS[$i]}"
    if [[ -d "$dir" ]] && { [[ -f "$dir/SKILL.md" ]] || [[ -f "$dir/scripts/youwen.js" ]]; }; then
      local real_dir; real_dir=$(cd "$dir" 2>/dev/null && pwd -P)
      [[ "$real_dir" != "$self_real" ]] && { DETECTED_DIRS+=("$dir"); DETECTED_NAMES+=("$name"); }
    fi
  done
}

# ==================== 安装核心 ====================

install_to_dir() {
  local source_dir="$1" target_dir="$2" tool_name="$3"

  local env_backup=""
  [[ -f "$target_dir/.env" ]] && { env_backup=$(mktemp); cp "$target_dir/.env" "$env_backup"; }

  mkdir -p "$target_dir"

  for item in "${INSTALL_FILES[@]}"; do
    if [[ -e "$source_dir/$item" ]]; then
      [[ -d "$source_dir/$item" ]] && rm -rf "$target_dir/$item"
      cp -r "$source_dir/$item" "$target_dir/$item"
    fi
  done

  if [[ -n "$env_backup" && -f "$env_backup" ]]; then
    cp "$env_backup" "$target_dir/.env"
    rm -f "$env_backup"
    ok "${tool_name}: 已更新（.env 已保留）"
  else
    if [[ -f "$target_dir/.env.example" && ! -f "$target_dir/.env" ]]; then
      cp "$target_dir/.env.example" "$target_dir/.env"
      warn "${tool_name}: 已安装（请编辑 $target_dir/.env 配置 Token）"
    else
      ok "${tool_name}: 已安装"
    fi
  fi
}

# ==================== .env 配置 ====================

parse_var() {
  local def="$1"
  VAR_KEY=$(echo "$def" | cut -d'|' -f1)
  VAR_LABEL=$(echo "$def" | cut -d'|' -f2)
  VAR_DEFAULT=$(echo "$def" | cut -d'|' -f3)
  VAR_REQUIRED=$(echo "$def" | cut -d'|' -f4)
  VAR_SECRET=$(echo "$def" | cut -d'|' -f5)
  VAR_OPTIONS=$(echo "$def" | cut -d'|' -f6)
}

declare -A ENV_VALS
load_env_file() {
  ENV_VALS=()
  [[ ! -f "$ENV_FILE" ]] && return
  while IFS= read -r line; do
    line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)\ *=\ *(.*) ]]; then
      local k="${BASH_REMATCH[1]}" v="${BASH_REMATCH[2]}"
      v=$(echo "$v" | sed 's/^["'\'']\|["'\'']\s*$//g')
      ENV_VALS["$k"]="$v"
    fi
  done < "$ENV_FILE"
}

mask_value() {
  local val="$1" len=${#1}
  (( len <= 4 )) && { echo "****"; return; }
  echo "${val:0:2}$(printf '*%.0s' $(seq 1 $((len - 4))))${val: -2}"
}

write_env_file() {
  local target="${1:-$ENV_FILE}"
  {
    echo "# yw-enhance 配置文件"
    echo "# 自动生成于 $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo ""
    for def in "${ENV_VARS[@]}"; do
      parse_var "$def"
      local val="${ENV_VALS[$VAR_KEY]:-${VAR_DEFAULT}}"
      local req_tag=""; [[ "$VAR_REQUIRED" == "1" ]] && req_tag=" (必填)"
      local opt_tag=""; [[ -n "$VAR_OPTIONS" ]] && opt_tag=" [$VAR_OPTIONS]"
      echo "# ${VAR_LABEL}${req_tag}${opt_tag}"
      [[ -n "$val" ]] && echo "${VAR_KEY}=${val}" || echo "# ${VAR_KEY}="
      echo ""
    done
  } > "$target"
}

check_env() {
  local has_issue=0
  echo ""
  echo "╭─────────────────────────────────────────╮"
  echo "│     yw-enhance 环境配置检查              │"
  echo "╰─────────────────────────────────────────╯"
  echo ""

  for def in "${ENV_VARS[@]}"; do
    parse_var "$def"
    local env_val="${!VAR_KEY:-}" file_val="${ENV_VALS[$VAR_KEY]:-}"
    local effective="${env_val:-${file_val:-${VAR_DEFAULT}}}"
    local source="默认值"
    [[ -n "$env_val" ]] && source="环境变量"
    [[ -z "$env_val" && -n "$file_val" ]] && source=".env文件"
    [[ -z "$effective" ]] && source="未设置"

    local display="$effective"
    [[ "$VAR_SECRET" == "1" && -n "$effective" ]] && display=$(mask_value "$effective")
    [[ -z "$display" ]] && display="(空)"

    local icon color status_msg=""
    if [[ "$VAR_REQUIRED" == "1" && -z "$effective" ]]; then
      icon="✘"; color="$RED"; status_msg="→ 必填项未配置"; has_issue=1
    elif [[ -n "$VAR_OPTIONS" && -n "$effective" ]]; then
      if echo ",$VAR_OPTIONS," | grep -q ",$effective,"; then
        icon="✔"; color="$GREEN"
      else
        icon="⚠"; color="$YELLOW"; status_msg="→ 可选值: $VAR_OPTIONS"; has_issue=1
      fi
    else
      icon="✔"; color="$GREEN"
    fi

    echo -e "  ${color}${icon}${NC} ${VAR_LABEL}"
    echo -e "    ${VAR_KEY} = ${display}  [${source}]"
    [[ -n "$status_msg" ]] && echo -e "    ${color}${status_msg}${NC}"
    echo ""
  done
  return $has_issue
}

test_connection() {
  local api_url="${1:-https://b.aigy.de}" token="${2:-}"
  echo -n "🔗 测试后端连通性..."

  local curl_args=(-s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 -H "Accept: application/json")
  [[ -n "$token" ]] && curl_args+=(-H "Authorization: Bearer $token")

  local status_code
  status_code=$(curl "${curl_args[@]}" "${api_url}/api/skill/version?name=yw-enhance" 2>/dev/null || echo "000")

  echo ""
  case "$status_code" in
    200)     echo -e "  ${GREEN}✔ 后端连接正常${NC}" ;;
    401|403) echo -e "  ${RED}✘ Token 无效或已过期 (HTTP $status_code)${NC}" ;;
    000)     echo -e "  ${RED}✘ 无法连接到服务器（网络问题或地址错误）${NC}" ;;
    *)       echo -e "  ${YELLOW}⚠ 服务器返回 HTTP $status_code${NC}" ;;
  esac
  echo ""
}

# ==================== 同步 ====================

pick_sync_targets() {
  local prompt_label="$1"
  echo ""
  echo "─── ${prompt_label} ───"
  echo ""

  local src_ver; src_ver=$(get_local_version "$SCRIPT_DIR")

  for i in "${!DETECTED_DIRS[@]}"; do
    local dir="${DETECTED_DIRS[$i]}" name="${DETECTED_NAMES[$i]}"
    local ver; ver=$(get_local_version "$dir")
    local ver_info=""
    if [[ -n "$ver" && -n "$src_ver" ]]; then
      [[ "$ver" == "$src_ver" ]] && ver_info=" ${GREEN}v${ver}（已是最新）${NC}" || ver_info=" ${YELLOW}v${ver} → v${src_ver}${NC}"
    elif [[ -n "$ver" ]]; then
      ver_info=" v${ver}"
    fi
    echo -e "  $((i+1))) ${BOLD}${name}${NC}${ver_info}"
    echo -e "     $dir"
    echo ""
  done

  echo "  a) 全部"
  echo "  0) 跳过"
  echo ""

  local choice; read -rp "请选择 [编号/a/0]: " choice

  PICKED_DIRS=(); PICKED_NAMES=()
  [[ "$choice" == "0" ]] && return 0

  if [[ "$choice" == "a" || "$choice" == "A" ]]; then
    PICKED_DIRS=("${DETECTED_DIRS[@]}"); PICKED_NAMES=("${DETECTED_NAMES[@]}")
  else
    IFS=',' read -ra selections <<< "$choice"
    for sel in "${selections[@]}"; do
      sel=$(echo "$sel" | tr -d ' ')
      local idx=$((sel - 1))
      (( idx >= 0 && idx < ${#DETECTED_DIRS[@]} )) && { PICKED_DIRS+=("${DETECTED_DIRS[$idx]}"); PICKED_NAMES+=("${DETECTED_NAMES[$idx]}"); }
    done
  fi
}

sync_files_to_dir() {
  local target_dir="$1" tool_name="$2"
  local synced=0
  for item in "${INSTALL_FILES[@]}"; do
    if [[ -e "$SCRIPT_DIR/$item" ]]; then
      [[ -d "$SCRIPT_DIR/$item" ]] && rm -rf "$target_dir/$item"
      cp -r "$SCRIPT_DIR/$item" "$target_dir/$item"
      synced=$((synced + 1))
    fi
  done
  echo -e "  ${GREEN}✔${NC} ${BOLD}${tool_name}${NC}: 已同步 ${synced} 个文件/目录"
}

sync_env_to_dir() {
  local target_dir="$1" tool_name="$2"
  [[ ! -f "$ENV_FILE" ]] && return
  local env_target="$target_dir/.env"
  if [[ -f "$env_target" ]] && ! diff -q "$ENV_FILE" "$env_target" &>/dev/null; then
    cp "$env_target" "${env_target}.bak.$(date +%s)"
  fi
  cp "$ENV_FILE" "$env_target"
  echo -e "  ${GREEN}✔${NC} ${BOLD}${tool_name}${NC}: .env 已同步"
}

no_targets_msg() {
  echo ""
  echo -e "${YELLOW}未检测到其他工具中安装的 yw-enhance skill${NC}"
  echo ""
  echo "已扫描以下路径:"
  for dir in "${TOOL_DIRS[@]}"; do echo "  · $dir"; done
  echo ""
  echo "如需安装到新工具，请运行: bash install.sh --target <工具名>"
}

cmd_sync() {
  detect_other_installs
  [[ ${#DETECTED_DIRS[@]} -eq 0 ]] && { no_targets_msg; return 0; }

  pick_sync_targets "同步 skill 脚本 + .env 到编程工具"
  [[ ${#PICKED_DIRS[@]} -eq 0 ]] && { echo "已跳过"; return 0; }

  echo ""
  for i in "${!PICKED_DIRS[@]}"; do
    sync_files_to_dir "${PICKED_DIRS[$i]}" "${PICKED_NAMES[$i]}"
    sync_env_to_dir "${PICKED_DIRS[$i]}" "${PICKED_NAMES[$i]}"
  done
  echo ""
}

cmd_sync_env() {
  [[ ! -f "$ENV_FILE" ]] && { fail "项目 .env 文件不存在，请先运行 bash install.sh --setup"; return 1; }

  detect_other_installs
  [[ ${#DETECTED_DIRS[@]} -eq 0 ]] && { no_targets_msg; return 0; }

  pick_sync_targets "同步 .env 到编程工具"
  [[ ${#PICKED_DIRS[@]} -eq 0 ]] && { echo "已跳过"; return 0; }

  echo ""
  for i in "${!PICKED_DIRS[@]}"; do
    sync_env_to_dir "${PICKED_DIRS[$i]}" "${PICKED_NAMES[$i]}"
  done
  echo ""
}

# ==================== 命令: check ====================

cmd_check() {
  echo ""
  printf "${BOLD}${CYAN}yw-enhance 版本检查${NC}\n"
  echo ""

  local remote_info remote_ver
  remote_info=$(get_remote_info)
  remote_ver="${remote_info%%|*}"
  if [[ -z "$remote_ver" ]]; then
    warn "无法获取远程版本（网络问题或后端不可达）"
    remote_ver="unknown"
  else
    info "远程最新版本: ${BOLD}${remote_ver}${NC}"
  fi
  echo ""

  local installed
  read -ra installed <<< "$(detect_installed)"

  if [[ ${#installed[@]} -eq 0 || -z "${installed[0]}" ]]; then
    warn "未检测到任何已安装的 yw-enhance"
    echo ""
    info "运行 ${CYAN}bash install.sh${NC} 进行安装"
    return
  fi

  for tool in "${installed[@]}"; do
    local dir label local_ver
    dir=$(tool_dir_by_key "$tool")
    label=$(tool_label_by_key "$tool")
    local_ver=$(get_local_version "$dir")
    local_ver="${local_ver:-unknown}"

    if [[ "$remote_ver" != "unknown" && "$local_ver" != "unknown" ]]; then
      local cmp; cmp=$(compare_semver "$local_ver" "$remote_ver")
      if [[ "$cmp" == "-1" ]]; then
        warn "${label}: ${local_ver} → ${GREEN}${remote_ver}${NC} (有更新)"
      else
        ok "${label}: ${local_ver} (已是最新)"
      fi
    else
      info "${label}: ${local_ver}"
    fi
  done
  echo ""
}

# ==================== 命令: install ====================

cmd_install() {
  local target_tool="$1"

  echo ""
  printf "${BLUE}╔══════════════════════════════════════════════╗${NC}\n"
  printf "${BLUE}║${NC}  ${BOLD}${CYAN}yw-enhance${NC} 安装 / 更新                     ${BLUE}║${NC}\n"
  printf "${BLUE}╚══════════════════════════════════════════════╝${NC}\n"
  echo ""

  check_node

  # 先检查版本，提示是否有更新
  local remote_info remote_ver
  remote_info=$(get_remote_info)
  remote_ver="${remote_info%%|*}"
  if [[ -n "$remote_ver" ]]; then
    info "远程最新版本: ${BOLD}${remote_ver}${NC}"
  fi

  local installed
  read -ra installed <<< "$(detect_installed)"

  if [[ ${#installed[@]} -gt 0 && -n "${installed[0]}" ]]; then
    # 已有安装，检查是否需要更新
    local has_update=false
    for tool in "${installed[@]}"; do
      local dir label local_ver
      dir=$(tool_dir_by_key "$tool")
      label=$(tool_label_by_key "$tool")
      local_ver=$(get_local_version "$dir")
      if [[ -n "$remote_ver" && -n "$local_ver" ]]; then
        local cmp; cmp=$(compare_semver "$local_ver" "$remote_ver")
        if [[ "$cmp" == "-1" ]]; then
          echo ""
          warn "${label}: ${local_ver} → ${remote_ver} (有更新)"
          has_update=true
        else
          echo ""
          ok "${label}: ${local_ver} (已是最新)"
        fi
      fi
    done

    if [[ "$has_update" == true ]]; then
      echo ""
      local answer
      read -rp "是否更新到最新版本？(Y/n): " answer
      if [[ "$answer" =~ ^[Nn] ]]; then
        echo "已取消更新"
        exit 0
      fi
    fi
  fi
  echo ""

  local source_dir="" need_cleanup=false

  if [[ -f "$SCRIPT_DIR/scripts/youwen.js" && -f "$SCRIPT_DIR/SKILL.md" ]]; then
    source_dir="$SCRIPT_DIR"
    info "使用本地文件: $source_dir"
  else
    source_dir=$(download_latest)
    need_cleanup=true
    ok "下载完成"
  fi

  local new_ver; new_ver=$(get_local_version "$source_dir")
  info "安装版本: ${BOLD}${new_ver:-unknown}${NC}"
  echo ""

  if [[ -n "$target_tool" ]]; then
    local dir label
    dir=$(tool_dir_by_key "$target_tool" 2>/dev/null) || true
    label=$(tool_label_by_key "$target_tool" 2>/dev/null) || true
    if [[ -z "$dir" ]]; then
      fail "未知工具: $target_tool"
      echo "  支持: ${TOOL_KEYS[*]}"
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

      local choice; read -rp "请选择 [1-${#TOOL_KEYS[@]}/a]: " choice

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
        local dir label old_ver
        dir=$(tool_dir_by_key "$tool")
        label=$(tool_label_by_key "$tool")
        old_ver=$(get_local_version "$dir")
        install_to_dir "$source_dir" "$dir" "$label"
        if [[ -n "$old_ver" && -n "$new_ver" && "$old_ver" != "$new_ver" ]]; then
          printf "  ${DIM}${old_ver} → ${new_ver}${NC}\n"
        fi
      done
    fi
  fi

  [[ "$need_cleanup" == true && -n "$source_dir" ]] && rm -rf "$(dirname "$source_dir")"

  echo ""
  ok "完成"
  echo ""
  printf "  配置: ${CYAN}bash install.sh --setup${NC}\n"
  printf "  测试: ${CYAN}node scripts/youwen.js enhance \"测试\" --auto-confirm --no-search${NC}\n"
  echo ""
}

# ==================== 命令: uninstall ====================

cmd_uninstall() {
  echo ""
  printf "${BOLD}${CYAN}yw-enhance 卸载${NC}\n"
  echo ""

  local installed
  read -ra installed <<< "$(detect_installed)"

  if [[ ${#installed[@]} -eq 0 || -z "${installed[0]}" ]]; then
    warn "未检测到任何已安装的 yw-enhance"
    return
  fi

  echo "检测到以下安装:"
  echo ""
  for i in "${!installed[@]}"; do
    local tool="${installed[$i]}" dir label
    dir=$(tool_dir_by_key "$tool")
    label=$(tool_label_by_key "$tool")
    printf "  %d) %s  ${DIM}%s${NC}\n" "$((i+1))" "$label" "$dir"
  done
  echo ""
  echo "  a) 全部卸载"
  echo "  0) 取消"
  echo ""

  local choice; read -rp "请选择 [编号/a/0]: " choice
  [[ "$choice" == "0" ]] && { echo "已取消"; return; }

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
    if [[ -f "$dir/.env" ]]; then
      cp "$dir/.env" "$dir/.env.uninstall-backup"
      info "已备份 .env → $dir/.env.uninstall-backup"
    fi
    rm -rf "$dir"
    ok "已卸载: ${label}"
  done
  echo ""
}

# ==================== 命令: setup ====================

cmd_setup() {
  local sub_mode="$1"  # edit / reset / ""

  check_node
  echo ""

  if [[ "$sub_mode" == "reset" && -f "$ENV_FILE" ]]; then
    local backup="${ENV_FILE}.bak.$(date +%s)"
    cp "$ENV_FILE" "$backup"
    rm -f "$ENV_FILE"
    echo "已备份旧配置到 $(basename "$backup")"
  fi

  load_env_file

  local has_issue=0
  check_env || has_issue=$?

  if [[ "$sub_mode" == "edit" || "$sub_mode" == "reset" || $has_issue -ne 0 ]]; then
    # 进入交互式配置
    echo ""
    echo "─── 交互式配置 ───"
    echo ""
    echo "按 Enter 保留当前值，输入新值覆盖"
    echo ""

    for def in "${ENV_VARS[@]}"; do
      parse_var "$def"
      local current="${ENV_VALS[$VAR_KEY]:-${VAR_DEFAULT}}"
      local display_current="$current"
      [[ "$VAR_SECRET" == "1" && -n "$current" ]] && display_current=$(mask_value "$current")
      [[ -z "$display_current" ]] && display_current="(空)"

      local req_tag=""; [[ "$VAR_REQUIRED" == "1" ]] && req_tag=" ${RED}*必填*${NC}"
      local opt_tag=""; [[ -n "$VAR_OPTIONS" ]] && opt_tag=" [${VAR_OPTIONS}]"

      echo -e "${BOLD}${VAR_LABEL}${NC}${req_tag}${opt_tag}"
      echo "  当前: $display_current"

      local new_val; read -rp "  新值: " new_val

      if [[ -n "$new_val" ]]; then
        if [[ -n "$VAR_OPTIONS" ]] && ! echo ",$VAR_OPTIONS," | grep -q ",$new_val,"; then
          echo -e "  ${YELLOW}⚠ 可选值: $VAR_OPTIONS${NC}"
          read -rp "  重新输入: " new_val
          [[ -z "$new_val" ]] && new_val="$current"
        fi
        if [[ "$VAR_KEY" == "YOUWEN_API_URL" && -n "$new_val" && ! "$new_val" =~ ^https?:// ]]; then
          echo -e "  ${YELLOW}⚠ 需要有效的 URL（http:// 或 https://）${NC}"
          read -rp "  重新输入: " new_val
          [[ -z "$new_val" ]] && new_val="$current"
        fi
        ENV_VALS["$VAR_KEY"]="$new_val"
      elif [[ -n "$current" ]]; then
        ENV_VALS["$VAR_KEY"]="$current"
      fi
      echo ""
    done

    write_env_file "$ENV_FILE"
    echo -e "${GREEN}✔ 配置已写入 $ENV_FILE${NC}"
    echo ""

    load_env_file
    check_env || true

    local api_url="${ENV_VALS[YOUWEN_API_URL]:-https://b.aigy.de}"
    local token="${ENV_VALS[YOUWEN_TOKEN]:-}"
    [[ -n "$token" ]] && test_connection "$api_url" "$token"

    # 配置完成后同步
    cmd_sync
  else
    echo "所有配置项正常。"
    echo ""
    local answer
    read -rp "是否要修改配置？(y/N): " answer
    if [[ "$answer" =~ ^[Yy] ]]; then
      cmd_setup "edit"
    else
      echo ""
      detect_other_installs
      if [[ ${#DETECTED_DIRS[@]} -gt 0 ]]; then
        read -rp "是否同步 skill 脚本 + .env 到其他编程工具？(y/N): " answer
        [[ "$answer" =~ ^[Yy] ]] && cmd_sync
      fi
      echo "提示: --setup --edit 强制编辑，--sync 同步脚本+配置到其他工具"
      echo ""
    fi
  fi
}

# ==================== 主入口 ====================

main() {
  local cmd="install" target="" setup_sub=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check)     cmd="check" ;;
      --uninstall) cmd="uninstall" ;;
      --setup)     cmd="setup" ;;
      --sync)      cmd="sync" ;;
      --sync-env)  cmd="sync-env" ;;
      --target)    shift; target="$1" ;;
      --edit)      setup_sub="edit" ;;
      --reset)     setup_sub="reset" ;;
      --help|-h)   cmd="help" ;;
      *)           ;;
    esac
    shift
  done

  if [[ "$cmd" == "help" ]]; then
    echo "yw-enhance 安装 / 更新 / 配置脚本"
    echo ""
    echo "用法:"
    echo "  bash install.sh                    # 安装或更新"
    echo "  bash install.sh --target claude    # 仅安装到指定工具"
    echo "  bash install.sh --check            # 检查版本"
    echo "  bash install.sh --uninstall        # 卸载"
    echo "  bash install.sh --setup            # 交互式配置环境变量"
    echo "  bash install.sh --setup --edit     # 强制编辑配置"
    echo "  bash install.sh --setup --reset    # 重置配置"
    echo "  bash install.sh --sync             # 同步脚本 + 配置到已安装目录"
    echo "  bash install.sh --sync-env         # 仅同步 .env"
    echo ""
    echo "远程安装:"
    echo "  curl -fsSL https://raw.githubusercontent.com/xiamuwnagwang/YCE-enhance/main/install.sh | bash"
    echo ""
    echo "支持的工具: ${TOOL_KEYS[*]}"
    exit 0
  fi

  case "$cmd" in
    check)     cmd_check ;;
    install)   cmd_install "$target" ;;
    uninstall) cmd_uninstall ;;
    setup)     cmd_setup "$setup_sub" ;;
    sync)      load_env_file; cmd_sync ;;
    sync-env)  load_env_file; cmd_sync_env ;;
  esac
}

main "$@"
