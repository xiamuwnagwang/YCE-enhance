#!/usr/bin/env bash
# yw-enhance 一键安装 / 更新脚本
#
# 用法:
#   # 远程安装（推荐）
#   curl -fsSL https://raw.githubusercontent.com/xiamuwnagwang/YCE-enhance/main/install.sh | bash
#
#   # 本地更新
#   bash install.sh
#   bash install.sh --target claude       # 仅安装到 Claude Code
#   bash install.sh --target opencode     # 仅安装到 OpenCode
#   bash install.sh --check              # 仅检查版本
#   bash install.sh --uninstall          # 卸载

set -eo pipefail

# ==================== 常量 ====================

REPO_URL="https://github.com/xiamuwnagwang/YCE-enhance"
REPO_ARCHIVE_FALLBACK="https://github.com/xiamuwnagwang/YCE-enhance/archive/refs/heads/main.tar.gz"
API_URL="https://b.aigy.de"
SKILL_NAME="yw-enhance"

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

# 需要安装的文件/目录（排除 .env, .omc, .git 等）
INSTALL_FILES=("scripts" "references" "SKILL.md" "quickstart.sh" "install.sh" ".env.example" ".gitignore")

# ==================== 工具函数 ====================

info()  { printf "${BLUE}▸${NC} %b\n" "$1"; }
ok()    { printf "${GREEN}✔${NC} %b\n" "$1"; }
warn()  { printf "${YELLOW}⚠${NC} %b\n" "$1"; }
fail()  { printf "${RED}✘${NC} %b\n" "$1"; }

# 根据 key 查找索引
tool_index() {
  local key="$1"
  for i in "${!TOOL_KEYS[@]}"; do
    if [[ "${TOOL_KEYS[$i]}" == "$key" ]]; then
      echo "$i"; return 0
    fi
  done
  return 1
}

tool_dir_by_key()   { local i; i=$(tool_index "$1") && echo "${TOOL_DIRS[$i]}"; }
tool_label_by_key() { local i; i=$(tool_index "$1") && echo "${TOOL_LABELS[$i]}"; }

get_local_version() {
  local dir="$1"
  local skill_md="$dir/SKILL.md"
  if [[ -f "$skill_md" ]]; then
    grep -m1 '^version:' "$skill_md" 2>/dev/null | sed 's/version:[[:space:]]*//' | tr -d '[:space:]'
  fi
}

get_remote_info() {
  # 返回 "version|downloadUrl" 格式
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

get_remote_version() {
  local info
  info=$(get_remote_info)
  echo "${info%%|*}"
}

get_download_url() {
  local info
  info=$(get_remote_info)
  echo "${info#*|}"
}

compare_semver() {
  local a="$1" b="$2"
  local IFS='.'
  read -ra pa <<< "$a"
  read -ra pb <<< "$b"
  for i in 0 1 2; do
    local va=${pa[$i]:-0} vb=${pb[$i]:-0}
    if (( va < vb )); then echo "-1"; return; fi
    if (( va > vb )); then echo "1"; return; fi
  done
  echo "0"
}

# 检测已安装的工具（返回 key 列表）
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

# ==================== 核心操作 ====================

download_latest() {
  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf '$tmp_dir'" EXIT

  info "下载最新版本..."

  # 1. 优先从后端 API 获取 downloadUrl
  local dl_url
  dl_url=$(get_download_url)

  local downloaded=false

  # 2. 如果后端返回了 downloadUrl，优先使用
  if [[ -n "$dl_url" ]]; then
    info "使用后端下载地址: $dl_url"
    if echo "$dl_url" | grep -q '\.tar\.gz$'; then
      curl -fsSL "$dl_url" | tar -xz -C "$tmp_dir" 2>/dev/null && downloaded=true
    elif echo "$dl_url" | grep -q '\.zip$'; then
      curl -fsSL "$dl_url" -o "$tmp_dir/repo.zip" 2>/dev/null && \
        unzip -q "$tmp_dir/repo.zip" -d "$tmp_dir" 2>/dev/null && downloaded=true
    else
      # 可能是 GitHub 仓库地址，尝试 git clone
      git clone --depth 1 "$dl_url" "$tmp_dir/repo" 2>/dev/null && downloaded=true
    fi
  fi

  # 3. 回退: git clone
  if [[ "$downloaded" != true ]] && command -v git &>/dev/null; then
    warn "尝试 git clone..."
    git clone --depth 1 "$REPO_URL.git" "$tmp_dir/repo" 2>/dev/null && downloaded=true
  fi

  # 4. 回退: GitHub tarball
  if [[ "$downloaded" != true ]]; then
    warn "尝试 tarball 下载..."
    curl -fsSL "$REPO_ARCHIVE_FALLBACK" | tar -xz -C "$tmp_dir" 2>/dev/null && downloaded=true
  fi

  if [[ "$downloaded" != true ]]; then
    fail "下载失败"
    exit 1
  fi

  # 找到解压后的目录（可能是 repo 或 YCE-enhance-*）
  if [[ ! -d "$tmp_dir/repo" ]]; then
    local extracted
    extracted=$(find "$tmp_dir" -maxdepth 1 -type d ! -name "$(basename "$tmp_dir")" | head -1)
    if [[ -n "$extracted" ]]; then
      mv "$extracted" "$tmp_dir/repo"
    fi
  fi

  if [[ ! -d "$tmp_dir/repo" ]]; then
    fail "下载后未找到有效文件"
    exit 1
  fi

  echo "$tmp_dir/repo"
  trap - EXIT  # 不要清理，调用方负责
}

install_to_dir() {
  local source_dir="$1"
  local target_dir="$2"
  local tool_name="$3"

  # 备份 .env
  local env_backup=""
  if [[ -f "$target_dir/.env" ]]; then
    env_backup=$(mktemp)
    cp "$target_dir/.env" "$env_backup"
  fi

  # 创建目标目录
  mkdir -p "$target_dir"

  # 复制文件
  for item in "${INSTALL_FILES[@]}"; do
    if [[ -e "$source_dir/$item" ]]; then
      if [[ -d "$source_dir/$item" ]]; then
        rm -rf "$target_dir/$item"
        cp -r "$source_dir/$item" "$target_dir/$item"
      else
        cp "$source_dir/$item" "$target_dir/$item"
      fi
    fi
  done

  # 恢复 .env
  if [[ -n "$env_backup" && -f "$env_backup" ]]; then
    cp "$env_backup" "$target_dir/.env"
    rm -f "$env_backup"
    ok "${tool_name}: 已更新（.env 已保留）"
  else
    # 首次安装，从 .env.example 创建
    if [[ -f "$target_dir/.env.example" && ! -f "$target_dir/.env" ]]; then
      cp "$target_dir/.env.example" "$target_dir/.env"
      warn "${tool_name}: 已安装（请编辑 $target_dir/.env 配置 Token）"
    else
      ok "${tool_name}: 已安装"
    fi
  fi
}

# ==================== 命令: check ====================

cmd_check() {
  echo ""
  printf "${BOLD}${CYAN}yw-enhance 版本检查${NC}\n"
  echo ""

  local remote_info remote_ver dl_url
  remote_info=$(get_remote_info)
  remote_ver="${remote_info%%|*}"
  dl_url="${remote_info#*|}"
  if [[ -z "$remote_ver" ]]; then
    warn "无法获取远程版本（网络问题或后端不可达）"
    remote_ver="unknown"
  else
    info "远程最新版本: ${BOLD}${remote_ver}${NC}"
    [[ -n "$dl_url" ]] && printf "  ${DIM}下载地址: ${dl_url}${NC}\n"
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
      local cmp
      cmp=$(compare_semver "$local_ver" "$remote_ver")
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

# ==================== 命令: install / update ====================

cmd_install() {
  local target_tool="$1"

  echo ""
  printf "${BLUE}╔══════════════════════════════════════════════╗${NC}\n"
  printf "${BLUE}║${NC}  ${BOLD}${CYAN}yw-enhance${NC} 安装 / 更新                     ${BLUE}║${NC}\n"
  printf "${BLUE}╚══════════════════════════════════════════════╝${NC}\n"
  echo ""

  # 检查 Node.js
  if ! command -v node &>/dev/null; then
    fail "未安装 Node.js（需要 v16+）"
    echo ""
    echo "  安装方式:"
    echo "    macOS:   brew install node"
    echo "    Linux:   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -"
    echo "    Windows: winget install OpenJS.NodeJS.LTS"
    exit 1
  fi
  ok "Node.js $(node -v)"

  # 判断来源：本地项目 or 远程下载
  local source_dir=""
  local need_cleanup=false
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [[ -f "$script_dir/scripts/youwen.js" && -f "$script_dir/SKILL.md" ]]; then
    source_dir="$script_dir"
    info "使用本地文件: $source_dir"
  else
    source_dir=$(download_latest)
    need_cleanup=true
    ok "下载完成"
  fi

  local new_ver
  new_ver=$(get_local_version "$source_dir")
  info "安装版本: ${BOLD}${new_ver:-unknown}${NC}"
  echo ""

  # 确定安装目标
  if [[ -n "$target_tool" ]]; then
    # 指定工具
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
    # 自动检测已安装的 + 默认安装 Claude Code
    local installed
    read -ra installed <<< "$(detect_installed)"

    if [[ ${#installed[@]} -eq 0 || -z "${installed[0]}" ]]; then
      # 首次安装，交互选择
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
          if [[ $idx -ge 0 && $idx -lt ${#TOOL_KEYS[@]} ]]; then
            install_to_dir "$source_dir" "${TOOL_DIRS[$idx]}" "${TOOL_LABELS[$idx]}"
          fi
        done
      fi
    else
      # 更新已安装的
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

  # 清理
  if [[ "$need_cleanup" == true && -n "$source_dir" ]]; then
    rm -rf "$(dirname "$source_dir")"
  fi

  echo ""
  ok "完成"
  echo ""
  printf "  配置: ${CYAN}bash scripts/setup.sh${NC}\n"
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
    local tool="${installed[$i]}"
    local dir label
    dir=$(tool_dir_by_key "$tool")
    label=$(tool_label_by_key "$tool")
    printf "  %d) %s  %s\n" "$((i+1))" "$label" "${DIM}${dir}${NC}"
  done
  echo ""
  echo "  a) 全部卸载"
  echo "  0) 取消"
  echo ""

  local choice
  read -rp "请选择 [编号/a/0]: " choice

  if [[ "$choice" == "0" ]]; then
    echo "已取消"
    return
  fi

  local targets=()
  if [[ "$choice" == "a" || "$choice" == "A" ]]; then
    targets=("${installed[@]}")
  else
    IFS=',' read -ra selections <<< "$choice"
    for sel in "${selections[@]}"; do
      sel=$(echo "$sel" | tr -d ' ')
      local idx=$((sel - 1))
      if [[ $idx -ge 0 && $idx -lt ${#installed[@]} ]]; then
        targets+=("${installed[$idx]}")
      fi
    done
  fi

  echo ""
  for tool in "${targets[@]}"; do
    local dir label
    dir=$(tool_dir_by_key "$tool")
    label=$(tool_label_by_key "$tool")
    if [[ -f "$dir/.env" ]]; then
      local backup="${dir}/.env.uninstall-backup"
      cp "$dir/.env" "$backup"
      info "已备份 .env → $backup"
    fi
    rm -rf "$dir"
    ok "已卸载: ${label}"
  done
  echo ""
}

# ==================== 主入口 ====================

main() {
  local cmd="install"
  local target=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check)     cmd="check" ;;
      --uninstall) cmd="uninstall" ;;
      --target)    shift; target="$1" ;;
      --help|-h)   cmd="help" ;;
      *)           ;;
    esac
    shift
  done

  if [[ "$cmd" == "help" ]]; then
    echo "yw-enhance 安装 / 更新脚本"
    echo ""
    echo "用法:"
    echo "  bash install.sh                    # 安装或更新"
    echo "  bash install.sh --target claude    # 仅安装到 Claude Code"
    echo "  bash install.sh --target opencode  # 仅安装到 OpenCode"
    echo "  bash install.sh --check            # 检查版本"
    echo "  bash install.sh --uninstall        # 卸载"
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
  esac
}

main "$@"
