#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -P "$HERE/.." && pwd)"
DIST_DIR="$ROOT/dist"
BUILD_SCRIPT="$HERE/build-release.sh"
DEFAULT_REPO="xiamuwnagwang/YCE-enhance"
DEFAULT_TARGET_COMMITISH="main"
API_BASE="https://api.github.com"

BLUE='\033[34m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "${BLUE}▸${NC} %b\n" "$1"; }
ok()    { printf "${GREEN}✔${NC} %b\n" "$1"; }
warn()  { printf "${YELLOW}⚠${NC} %b\n" "$1"; }
fail()  { printf "${YELLOW}✘${NC} %b\n" "$1" >&2; }

die() {
  fail "$1"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

read_version() {
  python3 - "$ROOT/SKILL.md" <<'PY'
import re, sys
from pathlib import Path
txt = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
m = re.search(r'(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$', txt)
if not m:
    raise SystemExit(1)
print(m.group(1))
PY
}

usage() {
  cat <<EOF
YCE GitHub Release 上传脚本

用法:
  bash ./scripts/upload-release.sh [选项]

选项:
  --build                     上传前先执行 ./scripts/build-release.sh
  --repo <owner/name>         GitHub 仓库，默认: ${DEFAULT_REPO}
  --tag <tag>                 Release tag，默认: v<SKILL.md version>
  --release-name <name>       Release 名称，默认同 tag
  --notes <text>              Release 文案（创建 release 时使用）
  --body-file <path>          从文件读取 Release 文案
  --target <branch-or-sha>    创建 release 时绑定的 commitish，默认: ${DEFAULT_TARGET_COMMITISH}
  --dist-dir <path>           待上传产物目录，默认: ${DIST_DIR}
  --draft                     创建为 draft release
  --prerelease                创建为 prerelease
  --help, -h                  显示帮助

鉴权优先级:
  1. GITHUB_TOKEN / GH_TOKEN
  2. git credential helper（例如 macOS 的 osxkeychain）

行为说明:
  - 若 tag 对应 Release 不存在，会自动创建
  - 若同名资产已存在，会先删除再上传
  - 默认上传 dist 目录下的所有顶层文件
EOF
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"
}

file_mime() {
  local path="$1"
  if command -v file >/dev/null 2>&1; then
    file -b --mime-type "$path"
  else
    case "$path" in
      *.zip) echo "application/zip" ;;
      *.tar.gz) echo "application/gzip" ;;
      *) echo "application/octet-stream" ;;
    esac
  fi
}

resolve_auth_header() {
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [[ -n "$token" ]]; then
    AUTH_HEADER="Authorization: Bearer $token"
    AUTH_DESC="env-token"
    return 0
  fi

  need_cmd git

  local cred_output username password
  cred_output="$(
    printf 'protocol=https\nhost=github.com\npath=%s\n\n' "$REPO_SLUG" | git credential fill 2>/dev/null || true
  )"
  username="$(printf '%s\n' "$cred_output" | awk -F= '$1=="username"{print substr($0,10)}')"
  password="$(printf '%s\n' "$cred_output" | awk -F= '$1=="password"{print substr($0,10)}')"

  if [[ -z "$password" && -x /usr/bin/security ]]; then
    password="$(security find-internet-password -s github.com -g 2>&1 | awk -F\" '/password: /{print $2}' | tail -n 1 || true)"
  fi

  if [[ -n "$password" ]]; then
    [[ -n "$username" ]] || username="x-access-token"
    AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$username" "$password" | base64 | tr -d '\n')"
    AUTH_DESC="git-credential"
    return 0
  fi

  return 1
}

collect_assets() {
  mapfile -t ASSET_FILES < <(find "$DIST_DIR" -maxdepth 1 -type f | sort)
  [[ ${#ASSET_FILES[@]} -gt 0 ]] || die "No release assets found in: $DIST_DIR"
}

api_request() {
  local method="$1"
  local url="$2"
  local output="$3"
  shift 3
  curl -sS -o "$output" -w '%{http_code}' \
    -X "$method" \
    -H "$AUTH_HEADER" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'User-Agent: yce-upload-release' \
    "$@" \
    "$url"
}

prepare_release_payload() {
  local output="$1"
  python3 - "$output" "$TAG" "$TARGET_COMMITISH" "$RELEASE_NAME" "$RELEASE_BODY" "$IS_DRAFT" "$IS_PRERELEASE" <<'PY'
import json, sys
out, tag, target, name, body, draft, prerelease = sys.argv[1:]
payload = {
    "tag_name": tag,
    "target_commitish": target,
    "name": name,
    "body": body,
    "draft": draft.lower() == "true",
    "prerelease": prerelease.lower() == "true",
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)
PY
}

parse_release_metadata() {
  python3 - "$1" > "$TMP_DIR/release.meta" <<'PY'
import json, sys
from pathlib import Path
obj = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(obj["id"])
print(obj["html_url"])
print(obj["upload_url"].split("{", 1)[0])
for asset in obj.get("assets", []):
    print(f"ASSET\t{asset['name']}\t{asset['id']}")
PY
  RELEASE_ID="$(sed -n '1p' "$TMP_DIR/release.meta")"
  RELEASE_URL="$(sed -n '2p' "$TMP_DIR/release.meta")"
  UPLOAD_URL="$(sed -n '3p' "$TMP_DIR/release.meta")"
}

delete_asset_if_exists() {
  local name="$1"
  local asset_id delete_http
  asset_id="$(awk -F '\t' -v n="$name" '$1=="ASSET" && $2==n {print $3}' "$TMP_DIR/release.meta")"
  [[ -n "$asset_id" ]] || return 0
  info "删除已有资产: $name"
  delete_http="$(api_request DELETE "${API_BASE}/repos/${REPO_SLUG}/releases/assets/${asset_id}" "$TMP_DIR/delete-${asset_id}.json")"
  [[ "$delete_http" == "204" ]] || die "Delete asset failed: ${name} (HTTP ${delete_http})"
}

upload_asset() {
  local path="$1"
  local name mime upload_http encoded_name
  name="$(basename "$path")"
  mime="$(file_mime "$path")"
  encoded_name="$(urlencode "$name")"
  delete_asset_if_exists "$name"
  info "上传资产: $name"
  upload_http="$(
    curl -sS -o "$TMP_DIR/upload-${name}.json" -w '%{http_code}' \
      -X POST \
      -H "$AUTH_HEADER" \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      -H 'User-Agent: yce-upload-release' \
      -H "Content-Type: ${mime}" \
      --data-binary @"$path" \
      "${UPLOAD_URL}?name=${encoded_name}"
  )"
  [[ "$upload_http" == "201" ]] || die "Upload asset failed: ${name} (HTTP ${upload_http})"
  ok "已上传: $name"
}

main() {
  need_cmd curl
  need_cmd python3

  local version
  version="$(read_version)" || die "Cannot read version from SKILL.md"

  REPO_SLUG="$DEFAULT_REPO"
  TAG="v${version}"
  RELEASE_NAME="$TAG"
  RELEASE_BODY="Release assets generated by scripts/build-release.sh."
  TARGET_COMMITISH="$DEFAULT_TARGET_COMMITISH"
  IS_DRAFT="false"
  IS_PRERELEASE="false"
  SHOULD_BUILD="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --build)
        SHOULD_BUILD="true"
        shift
        ;;
      --repo)
        REPO_SLUG="${2:-}"
        shift 2
        ;;
      --tag)
        TAG="${2:-}"
        shift 2
        ;;
      --release-name)
        RELEASE_NAME="${2:-}"
        shift 2
        ;;
      --notes)
        RELEASE_BODY="${2:-}"
        shift 2
        ;;
      --body-file)
        [[ -f "${2:-}" ]] || die "Body file not found: ${2:-}"
        RELEASE_BODY="$(cat "${2:-}")"
        shift 2
        ;;
      --target)
        TARGET_COMMITISH="${2:-}"
        shift 2
        ;;
      --dist-dir)
        DIST_DIR="${2:-}"
        shift 2
        ;;
      --draft)
        IS_DRAFT="true"
        shift
        ;;
      --prerelease)
        IS_PRERELEASE="true"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done

  [[ -n "$REPO_SLUG" ]] || die "--repo cannot be empty"
  [[ -n "$TAG" ]] || die "--tag cannot be empty"
  [[ -n "$RELEASE_NAME" ]] || die "--release-name cannot be empty"
  [[ -d "$DIST_DIR" ]] || die "dist dir not found: $DIST_DIR"

  if [[ "$SHOULD_BUILD" == "true" ]]; then
    [[ -x "$BUILD_SCRIPT" || -f "$BUILD_SCRIPT" ]] || die "Build script not found: $BUILD_SCRIPT"
    info "执行 build-release.sh ..."
    bash "$BUILD_SCRIPT"
  fi

  collect_assets
  resolve_auth_header || die "未找到 GitHub 凭据。请设置 GITHUB_TOKEN / GH_TOKEN，或先配置 git credential helper。"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  info "GitHub 鉴权来源: $AUTH_DESC"
  info "仓库: $REPO_SLUG"
  info "Tag: $TAG"
  info "资产目录: $DIST_DIR"

  local release_http
  release_http="$(api_request GET "${API_BASE}/repos/${REPO_SLUG}/releases/tags/${TAG}" "$TMP_DIR/release.json")"
  if [[ "$release_http" == "404" ]]; then
    info "Release 不存在，准备创建..."
    prepare_release_payload "$TMP_DIR/create-release.json"
    local create_http
    create_http="$(
      api_request POST "${API_BASE}/repos/${REPO_SLUG}/releases" "$TMP_DIR/release.json" \
        -H 'Content-Type: application/json' \
        --data @"$TMP_DIR/create-release.json"
    )"
    [[ "$create_http" == "201" ]] || die "Create release failed (HTTP ${create_http})"
    ok "已创建 Release: $TAG"
  elif [[ "$release_http" == "200" ]]; then
    info "复用已存在 Release: $TAG"
  else
    die "Fetch release failed (HTTP ${release_http})"
  fi

  parse_release_metadata "$TMP_DIR/release.json"

  local asset
  for asset in "${ASSET_FILES[@]}"; do
    upload_asset "$asset"
  done

  echo ""
  ok "Release 上传完成"
  echo "  - release_id: $RELEASE_ID"
  echo "  - release_url: $RELEASE_URL"
}

main "$@"
