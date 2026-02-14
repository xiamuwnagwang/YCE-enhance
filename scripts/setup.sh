#!/usr/bin/env bash
# yw-enhance 环境检查与配置脚本 (macOS / Linux)
#
# 用法:
#   bash scripts/setup.sh              # 交互式检查，有问题则引导填写
#   bash scripts/setup.sh --check      # 仅检查 + 连通性测试
#   bash scripts/setup.sh --edit       # 强制进入编辑模式（即使配置正常）
#   bash scripts/setup.sh --reset      # 备份旧 .env 后重新生成
#   bash scripts/setup.sh --sync       # 仅同步 .env 到已安装的 skill 目录

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# ==================== Node.js 检查 ====================

check_node() {
  if command -v node &>/dev/null; then
    local node_ver
    node_ver=$(node -v 2>/dev/null)
    echo -e "\033[32m✔\033[0m Node.js 已安装: $node_ver"
    return 0
  fi

  echo -e "\033[31m✘ 未检测到 Node.js，yw-enhance 脚本无法运行\033[0m"
  echo ""
  echo "请选择安装方式:"
  echo "  1) Homebrew (推荐 macOS)"
  echo "  2) nvm (Node Version Manager)"
  echo "  3) 官网下载 https://nodejs.org"
  echo "  0) 跳过，稍后手动安装"
  echo ""

  local choice
  read -rp "请输入选项 [0-3]: " choice

  case "$choice" in
    1)
      if ! command -v brew &>/dev/null; then
        echo -e "\033[33m⚠ 未检测到 Homebrew，正在安装...\033[0m"
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      fi
      echo "正在通过 Homebrew 安装 Node.js..."
      brew install node
      ;;
    2)
      if command -v nvm &>/dev/null || [[ -s "$HOME/.nvm/nvm.sh" ]]; then
        [[ -s "$HOME/.nvm/nvm.sh" ]] && source "$HOME/.nvm/nvm.sh"
        echo "正在通过 nvm 安装 Node.js LTS..."
        nvm install --lts
        nvm use --lts
      else
        echo "正在安装 nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
        echo "正在通过 nvm 安装 Node.js LTS..."
        nvm install --lts
        nvm use --lts
      fi
      ;;
    3)
      echo ""
      echo "请访问 https://nodejs.org 下载安装后重新运行此脚本"
      exit 1
      ;;
    0)
      echo ""
      echo -e "\033[33m⚠ 跳过安装。请手动安装 Node.js 后重新运行此脚本\033[0m"
      exit 1
      ;;
    *)
      echo "无效选项，退出"
      exit 1
      ;;
  esac

  if command -v node &>/dev/null; then
    echo ""
    echo -e "\033[32m✔ Node.js 安装成功: $(node -v)\033[0m"
    return 0
  else
    echo -e "\033[31m✘ Node.js 安装失败，请手动安装后重试\033[0m"
    exit 1
  fi
}

# ==================== 颜色 ====================
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
BOLD='\033[1m'
RESET='\033[0m'

# ==================== 变量定义 ====================
# 格式: key|label|default|required|secret|options
VARS=(
  "YOUWEN_API_URL|后端 API 地址|https://b.aigy.de|0|0|"
  "YOUWEN_TOKEN|兑换码 / Token||1|1|"
  "YOUWEN_ENHANCE_MODE|增强模式|agent|0|0|agent,disabled"
  "YOUWEN_ENABLE_SEARCH|启用联合搜索|true|0|0|true,false"
  "YOUWEN_MGREP_API_KEY|Mixedbread 语义检索 API Key||0|1|"
  "YOUWEN_CALL_MODE|调用模式|smart|0|0|smart,always"
)

# ==================== 工具函数 ====================

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
  if [[ ! -f "$ENV_FILE" ]]; then return; fi
  while IFS= read -r line; do
    line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)\ *=\ *(.*) ]]; then
      local k="${BASH_REMATCH[1]}"
      local v="${BASH_REMATCH[2]}"
      v=$(echo "$v" | sed 's/^["'\'']\|["'\'']\s*$//g')
      ENV_VALS["$k"]="$v"
    fi
  done < "$ENV_FILE"
}

mask_value() {
  local val="$1"
  local len=${#val}
  if [[ $len -le 4 ]]; then
    echo "****"
  else
    echo "${val:0:2}$(printf '*%.0s' $(seq 1 $((len - 4))))${val: -2}"
  fi
}

# ==================== 检查逻辑 ====================

check_all() {
  local has_issue=0

  echo ""
  echo "╭─────────────────────────────────────────╮"
  echo "│     yw-enhance 环境配置检查              │"
  echo "╰─────────────────────────────────────────╯"
  echo ""

  for def in "${VARS[@]}"; do
    parse_var "$def"

    local env_val="${!VAR_KEY:-}"
    local file_val="${ENV_VALS[$VAR_KEY]:-}"
    local effective="${env_val:-${file_val:-${VAR_DEFAULT}}}"
    local source="默认值"
    if [[ -n "$env_val" ]]; then
      source="环境变量"
    elif [[ -n "$file_val" ]]; then
      source=".env文件"
    elif [[ -z "$effective" ]]; then
      source="未设置"
    fi

    local display="$effective"
    if [[ "$VAR_SECRET" == "1" && -n "$effective" ]]; then
      display=$(mask_value "$effective")
    fi
    [[ -z "$display" ]] && display="(空)"

    local icon color status_msg=""
    if [[ "$VAR_REQUIRED" == "1" && -z "$effective" ]]; then
      icon="✘"; color="$RED"; status_msg="→ 必填项未配置"
      has_issue=1
    elif [[ -n "$VAR_OPTIONS" && -n "$effective" ]]; then
      if echo ",$VAR_OPTIONS," | grep -q ",$effective,"; then
        icon="✔"; color="$GREEN"
      else
        icon="⚠"; color="$YELLOW"; status_msg="→ 可选值: $VAR_OPTIONS"
        has_issue=1
      fi
    else
      icon="✔"; color="$GREEN"
    fi

    echo -e "  ${color}${icon}${RESET} ${VAR_LABEL}"
    echo -e "    ${VAR_KEY} = ${display}  [${source}]"
    [[ -n "$status_msg" ]] && echo -e "    ${color}${status_msg}${RESET}"
    echo ""
  done

  return $has_issue
}

# ==================== 连通性测试 ====================

test_connection() {
  local api_url="${1:-https://b.aigy.de}"
  local token="${2:-}"

  echo -n "🔗 测试后端连通性..."

  local curl_args=(-s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15)
  curl_args+=(-H "Accept: application/json")
  [[ -n "$token" ]] && curl_args+=(-H "Authorization: Bearer $token")

  local status_code
  status_code=$(curl "${curl_args[@]}" "${api_url}/api/skill/version?name=yw-enhance" 2>/dev/null || echo "000")

  echo ""
  if [[ "$status_code" == "200" ]]; then
    echo -e "  ${GREEN}✔ 后端连接正常${RESET}"
  elif [[ "$status_code" == "401" || "$status_code" == "403" ]]; then
    echo -e "  ${RED}✘ Token 无效或已过期 (HTTP $status_code)${RESET}"
  elif [[ "$status_code" == "000" ]]; then
    echo -e "  ${RED}✘ 无法连接到服务器（网络问题或地址错误）${RESET}"
  else
    echo -e "  ${YELLOW}⚠ 服务器返回 HTTP $status_code${RESET}"
  fi
  echo ""
}

# ==================== 写入 .env ====================

write_env_file() {
  local target="${1:-$ENV_FILE}"
  {
    echo "# yw-enhance 配置文件"
    echo "# 由 setup.sh 自动生成"
    echo "# 生成时间: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo ""

    for def in "${VARS[@]}"; do
      parse_var "$def"
      local val="${ENV_VALS[$VAR_KEY]:-${VAR_DEFAULT}}"
      local req_tag=""
      [[ "$VAR_REQUIRED" == "1" ]] && req_tag=" (必填)"
      local opt_tag=""
      [[ -n "$VAR_OPTIONS" ]] && opt_tag=" [$VAR_OPTIONS]"

      echo "# ${VAR_LABEL}${req_tag}${opt_tag}"
      if [[ -n "$val" ]]; then
        echo "${VAR_KEY}=${val}"
      else
        echo "# ${VAR_KEY}="
      fi
      echo ""
    done
  } > "$target"
}

# ==================== Skill 同步 ====================

# 已知的编程工具 skill 目录
SKILL_DIRS_PATTERNS=(
  "$HOME/.claude/skills/yw-enhance"
  "$HOME/.config/opencode/skill/yw-enhance"
  "$HOME/.cursor/skills/yw-enhance"
  "$HOME/.windsurf/skills/yw-enhance"
  "$HOME/.cline/skills/yw-enhance"
  "$HOME/.continue/skills/yw-enhance"
  "$HOME/.codium/skills/yw-enhance"
  "$HOME/.aider/skills/yw-enhance"
)

TOOL_NAMES=(
  "Claude Code"
  "OpenCode"
  "Cursor"
  "Windsurf"
  "Cline"
  "Continue"
  "Codium"
  "Aider"
)

# 扫描已安装 yw-enhance 的 skill 目录
detect_skill_dirs() {
  DETECTED_DIRS=()
  DETECTED_NAMES=()
  for i in "${!SKILL_DIRS_PATTERNS[@]}"; do
    local dir="${SKILL_DIRS_PATTERNS[$i]}"
    local name="${TOOL_NAMES[$i]}"
    # 检查目录存在且包含 SKILL.md 或 scripts/youwen.js
    if [[ -d "$dir" ]] && { [[ -f "$dir/SKILL.md" ]] || [[ -f "$dir/scripts/youwen.js" ]]; }; then
      # 排除当前项目目录自身
      local real_dir
      real_dir=$(cd "$dir" 2>/dev/null && pwd -P)
      local real_project
      real_project=$(cd "$PROJECT_DIR" 2>/dev/null && pwd -P)
      if [[ "$real_dir" != "$real_project" ]]; then
        DETECTED_DIRS+=("$dir")
        DETECTED_NAMES+=("$name")
      fi
    fi
  done
}

sync_env_to_skills() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo -e "${RED}✘ 项目 .env 文件不存在，请先完成配置${RESET}"
    return 1
  fi

  detect_skill_dirs

  if [[ ${#DETECTED_DIRS[@]} -eq 0 ]]; then
    echo ""
    echo -e "${YELLOW}未检测到其他工具中安装的 yw-enhance skill${RESET}"
    echo ""
    echo "已扫描以下路径:"
    for dir in "${SKILL_DIRS_PATTERNS[@]}"; do
      echo "  · $dir"
    done
    echo ""
    echo "如需同步到自定义路径，请手动复制:"
    echo "  cp $ENV_FILE <目标skill目录>/.env"
    return 0
  fi

  echo ""
  echo "─── 同步 .env 到编程工具 ───"
  echo ""
  echo "检测到以下工具中安装了 yw-enhance:"
  echo ""

  for i in "${!DETECTED_DIRS[@]}"; do
    local dir="${DETECTED_DIRS[$i]}"
    local name="${DETECTED_NAMES[$i]}"
    local env_target="$dir/.env"
    local status_icon="·"
    local status_text="未同步"
    if [[ -f "$env_target" ]]; then
      if diff -q "$ENV_FILE" "$env_target" &>/dev/null; then
        status_icon="${GREEN}✔${RESET}"
        status_text="已同步（一致）"
      else
        status_icon="${YELLOW}⚠${RESET}"
        status_text="已有 .env（内容不同）"
      fi
    fi
    echo -e "  $((i+1))) ${BOLD}${name}${RESET}"
    echo -e "     $dir"
    echo -e "     ${status_icon} ${status_text}"
    echo ""
  done

  echo "  a) 全部同步"
  echo "  0) 跳过"
  echo ""

  local choice
  read -rp "请选择要同步的工具 [编号/a/0]: " choice

  if [[ "$choice" == "0" ]]; then
    echo "已跳过同步"
    return 0
  fi

  local targets=()
  local target_names=()
  if [[ "$choice" == "a" || "$choice" == "A" ]]; then
    targets=("${DETECTED_DIRS[@]}")
    target_names=("${DETECTED_NAMES[@]}")
  else
    # 支持逗号分隔的多选: 1,3
    IFS=',' read -ra selections <<< "$choice"
    for sel in "${selections[@]}"; do
      sel=$(echo "$sel" | tr -d ' ')
      local idx=$((sel - 1))
      if [[ $idx -ge 0 && $idx -lt ${#DETECTED_DIRS[@]} ]]; then
        targets+=("${DETECTED_DIRS[$idx]}")
        target_names+=("${DETECTED_NAMES[$idx]}")
      fi
    done
  fi

  if [[ ${#targets[@]} -eq 0 ]]; then
    echo "无有效选择"
    return 0
  fi

  echo ""
  for i in "${!targets[@]}"; do
    local dir="${targets[$i]}"
    local name="${target_names[$i]}"
    local env_target="$dir/.env"

    # 如果目标已有不同的 .env，先备份
    if [[ -f "$env_target" ]] && ! diff -q "$ENV_FILE" "$env_target" &>/dev/null; then
      cp "$env_target" "${env_target}.bak.$(date +%s)"
    fi

    cp "$ENV_FILE" "$env_target"
    echo -e "  ${GREEN}✔${RESET} 已同步到 ${BOLD}${name}${RESET}: $env_target"
  done
  echo ""
}

# ==================== 交互式配置 ====================

interactive_setup() {
  echo ""
  echo "─── 交互式配置 ───"
  echo ""
  echo "按 Enter 保留当前值，输入新值覆盖"
  echo ""

  for def in "${VARS[@]}"; do
    parse_var "$def"

    local current="${ENV_VALS[$VAR_KEY]:-${VAR_DEFAULT}}"
    local display_current="$current"
    if [[ "$VAR_SECRET" == "1" && -n "$current" ]]; then
      display_current=$(mask_value "$current")
    fi
    [[ -z "$display_current" ]] && display_current="(空)"

    local req_tag=""
    [[ "$VAR_REQUIRED" == "1" ]] && req_tag=" ${RED}*必填*${RESET}"
    local opt_tag=""
    [[ -n "$VAR_OPTIONS" ]] && opt_tag=" [${VAR_OPTIONS}]"

    echo -e "${BOLD}${VAR_LABEL}${RESET}${req_tag}${opt_tag}"
    echo "  当前: $display_current"

    local new_val
    read -rp "  新值: " new_val

    if [[ -n "$new_val" ]]; then
      # 校验 options
      if [[ -n "$VAR_OPTIONS" ]]; then
        if ! echo ",$VAR_OPTIONS," | grep -q ",$new_val,"; then
          echo -e "  ${YELLOW}⚠ 可选值: $VAR_OPTIONS${RESET}"
          read -rp "  重新输入: " new_val
          [[ -z "$new_val" ]] && new_val="$current"
        fi
      fi
      # 校验 URL
      if [[ "$VAR_KEY" == "YOUWEN_API_URL" && -n "$new_val" ]]; then
        if [[ ! "$new_val" =~ ^https?:// ]]; then
          echo -e "  ${YELLOW}⚠ 需要有效的 URL（http:// 或 https://）${RESET}"
          read -rp "  重新输入: " new_val
          [[ -z "$new_val" ]] && new_val="$current"
        fi
      fi
      ENV_VALS["$VAR_KEY"]="$new_val"
    elif [[ -n "$current" ]]; then
      ENV_VALS["$VAR_KEY"]="$current"
    fi

    echo ""
  done

  # 写入 .env
  write_env_file "$ENV_FILE"
  echo -e "${GREEN}✔ 配置已写入 $ENV_FILE${RESET}"
  echo ""

  # 重新加载并展示最终结果
  load_env_file
  check_all || true

  # 连通性测试
  local api_url="${ENV_VALS[YOUWEN_API_URL]:-https://b.aigy.de}"
  local token="${ENV_VALS[YOUWEN_TOKEN]:-}"
  if [[ -n "$token" ]]; then
    test_connection "$api_url" "$token"
  fi

  # 同步到其他工具
  sync_env_to_skills
}

# ==================== 主流程 ====================

main() {
  local mode="interactive"
  for arg in "$@"; do
    case "$arg" in
      --check) mode="check" ;;
      --edit)  mode="edit" ;;
      --reset) mode="reset" ;;
      --sync)  mode="sync" ;;
      --help|-h) mode="help" ;;
    esac
  done

  if [[ "$mode" == "help" ]]; then
    echo "用法:"
    echo "  bash scripts/setup.sh              # 交互式检查，有问题则引导填写"
    echo "  bash scripts/setup.sh --check      # 仅检查 + 连通性测试"
    echo "  bash scripts/setup.sh --edit       # 强制编辑（即使配置正常）"
    echo "  bash scripts/setup.sh --reset      # 备份旧 .env 后重新配置"
    echo "  bash scripts/setup.sh --sync       # 仅同步 .env 到已安装的 skill 目录"
    exit 0
  fi

  # Node.js 前置检查
  check_node
  echo ""

  # --sync: 仅同步
  if [[ "$mode" == "sync" ]]; then
    load_env_file
    sync_env_to_skills
    exit 0
  fi

  # --reset: 备份旧文件
  if [[ "$mode" == "reset" && -f "$ENV_FILE" ]]; then
    local backup="${ENV_FILE}.bak.$(date +%s)"
    cp "$ENV_FILE" "$backup"
    rm -f "$ENV_FILE"
    echo "已备份旧配置到 $(basename "$backup")"
  fi

  load_env_file

  # --check: 仅检查
  if [[ "$mode" == "check" ]]; then
    local exit_code=0
    check_all || exit_code=$?
    local api_url="${ENV_VALS[YOUWEN_API_URL]:-https://b.aigy.de}"
    local token="${ENV_VALS[YOUWEN_TOKEN]:-}"
    test_connection "$api_url" "$token"
    exit $exit_code
  fi

  # 先展示当前状态
  local has_issue=0
  check_all || has_issue=$?

  # --edit / --reset: 强制进入编辑
  if [[ "$mode" == "edit" || "$mode" == "reset" ]]; then
    interactive_setup
    exit 0
  fi

  # 交互模式: 有问题直接进入编辑，没问题则询问
  if [[ $has_issue -ne 0 ]]; then
    interactive_setup
  else
    echo "所有配置项正常。"
    echo ""
    local answer
    read -rp "是否要修改配置？(y/N): " answer
    if [[ "$answer" =~ ^[Yy] ]]; then
      interactive_setup
    else
      echo ""
      # 即使不编辑，也询问是否同步
      detect_skill_dirs
      if [[ ${#DETECTED_DIRS[@]} -gt 0 ]]; then
        read -rp "是否同步 .env 到其他编程工具？(y/N): " answer
        if [[ "$answer" =~ ^[Yy] ]]; then
          sync_env_to_skills
        fi
      fi
      echo "提示: 使用 --check 测试连通性，--edit 强制编辑，--sync 同步到其他工具"
      echo ""
    fi
  fi
}

main "$@"
