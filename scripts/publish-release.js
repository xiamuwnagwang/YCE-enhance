#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BUILD_SCRIPT = path.join(__dirname, "build-release.sh");
const UPLOAD_SCRIPT = path.join(__dirname, "upload-release.sh");
const API_BASE = "https://api.github.com";
const DEFAULT_REPO = "xiamuwnagwang/YCE-enhance";
const DEFAULT_TARGET_COMMITISH = "main";
const EXCLUDED_TRACKED_FILES = new Set([".env.example", ".gitignore"]);

function readVersion() {
  const skillPath = path.join(ROOT, "SKILL.md");
  const text = fs.readFileSync(skillPath, "utf8");
  const match = text.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m);
  if (!match) {
    throw new Error("Cannot find semver 'version: x.y.z' in SKILL.md");
  }
  return match[1];
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function parseGitCredentialFill() {
  try {
    const output = execFileSync(
      "git",
      ["credential", "fill"],
      {
        cwd: ROOT,
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const data = {};
    for (const line of output.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) data[key] = value;
    }
    return data;
  } catch {
    return {};
  }
}

function getAuthToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken && envToken.trim()) {
    return { header: `Bearer ${envToken.trim()}`, source: "env-token" };
  }

  const cred = parseGitCredentialFill();
  if (cred.password) {
    const user = cred.username || "x-access-token";
    const basic = Buffer.from(`${user}:${cred.password}`, "utf8").toString("base64");
    return { header: `Basic ${basic}`, source: "git-credential" };
  }

  throw new Error("未找到 GitHub 凭据，请设置 GITHUB_TOKEN / GH_TOKEN 或配置 git credential helper");
}

function isExecutable(filePath) {
  return (fs.statSync(filePath).mode & 0o111) !== 0;
}

function isBinaryBuffer(buffer) {
  if (!buffer || buffer.length === 0) return false;
  if (buffer.includes(0)) return true;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function sanitizeText(text) {
  return String(text).replace(/yce_[0-9a-f]{16,}/gi, "");
}

function trackedFiles() {
  const raw = runGit(["ls-files", "-z"]);
  return raw
    .split("\0")
    .filter(Boolean)
    .filter((file) => !EXCLUDED_TRACKED_FILES.has(file));
}

function requestJson(method, url, tokenHeader, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = https.request(
      url,
      {
        method,
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": tokenHeader,
          "Content-Type": "application/json",
          "User-Agent": "yce-publish-release",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed, text: data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function githubRequest(method, url, tokenHeader, body) {
  const res = await requestJson(method, url, tokenHeader, body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const detail = typeof res.body === "string" ? res.body : JSON.stringify(res.body || {});
    const err = new Error(`${method} ${url} failed with HTTP ${res.statusCode}: ${detail}`);
    err.statusCode = res.statusCode;
    throw err;
  }
  return res.body;
}

async function upsertGitRef(tokenHeader, ref, sha) {
  const refPath = `refs/${ref}`;
  const getUrl = `${API_BASE}/repos/${REPO_SLUG}/git/${refPath}`;
  const existing = await requestJson("GET", getUrl, tokenHeader);

  if (existing.statusCode === 404) {
    await githubRequest("POST", `${API_BASE}/repos/${REPO_SLUG}/git/refs`, tokenHeader, {
      ref: `refs/${ref}`,
      sha,
    });
    return "created";
  }

  if (existing.statusCode >= 200 && existing.statusCode < 300 && existing.body && existing.body.object && existing.body.object.sha === sha) {
    return "unchanged";
  }

  await githubRequest("PATCH", `${API_BASE}/repos/${REPO_SLUG}/git/refs/${ref}`, tokenHeader, {
    sha,
    force: true,
  });
  return "updated";
}

async function ensureRelease(tokenHeader, repo, tag, releaseName, body, targetCommitish, isDraft, isPrerelease) {
  const releaseUrl = `${API_BASE}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const existing = await requestJson("GET", releaseUrl, tokenHeader);
  if (existing.statusCode === 404) {
    return githubRequest("POST", `${API_BASE}/repos/${repo}/releases`, tokenHeader, {
      tag_name: tag,
      target_commitish: targetCommitish,
      name: releaseName,
      body,
      draft: isDraft,
      prerelease: isPrerelease,
    });
  }
  if (existing.statusCode >= 200 && existing.statusCode < 300) {
    return existing.body;
  }
  const detail = typeof existing.body === "string" ? existing.body : JSON.stringify(existing.body || {});
  throw new Error(`GET release failed with HTTP ${existing.statusCode}: ${detail}`);
}

async function buildReleaseIfNeeded(shouldBuild) {
  if (!shouldBuild) return;
  execFileSync("bash", [BUILD_SCRIPT], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
}

async function main() {
  let repo = DEFAULT_REPO;
  let tag = `v${readVersion()}`;
  let releaseName = tag;
  let body = "Release assets generated by scripts/build-release.sh.";
  let targetCommitish = DEFAULT_TARGET_COMMITISH;
  let shouldBuild = true;
  let draft = false;
  let prerelease = false;

  const args = process.argv.slice(2);
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--build":
        shouldBuild = true;
        break;
      case "--no-build":
        shouldBuild = false;
        break;
      case "--repo":
        repo = args.shift() || "";
        break;
      case "--tag":
        tag = args.shift() || "";
        break;
      case "--release-name":
        releaseName = args.shift() || "";
        break;
      case "--notes":
        body = args.shift() || "";
        break;
      case "--body-file": {
        const file = args.shift() || "";
        if (!fs.existsSync(file)) throw new Error(`Body file not found: ${file}`);
        body = fs.readFileSync(file, "utf8");
        break;
      }
      case "--target":
        targetCommitish = args.shift() || "";
        break;
      case "--draft":
        draft = true;
        break;
      case "--prerelease":
        prerelease = true;
        break;
      case "--help":
      case "-h":
        console.log([
          "YCE 组合发布脚本",
          "",
          "用法: node ./scripts/publish-release.js [--build|--no-build] [--repo owner/name] [--tag vX.Y.Z] [--release-name name] [--notes text|--body-file path] [--target branch-or-sha] [--draft] [--prerelease]",
          "",
          "默认行为:",
          "  1. 打包 dist",
          "  2. 使用当前仓 tracked 文件生成 GitHub 上的脱敏源码快照",
          "  3. 创建或更新同名 tag",
          "  4. 上传 dist 资产",
        ].join("\n"));
        return;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!repo) throw new Error("--repo cannot be empty");
  if (!tag) throw new Error("--tag cannot be empty");
  if (!releaseName) throw new Error("--release-name cannot be empty");

  REPO_SLUG = repo;
  const { header: authHeader, source } = getAuthToken();

  console.log(`▸ GitHub 鉴权来源: ${source}`);
  console.log(`▸ 仓库: ${repo}`);
  console.log(`▸ Tag: ${tag}`);
  console.log(`▸ Build: ${shouldBuild ? "yes" : "no"}`);

  await buildReleaseIfNeeded(shouldBuild);

  const files = trackedFiles();
  if (files.length === 0) {
    throw new Error("No tracked files found");
  }

  console.log(`▸ tracked files: ${files.length}`);

  const treeEntries = [];
  for (const file of files) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      continue;
    }
    const raw = fs.readFileSync(full);
    const executable = isExecutable(full);
    const binary = isBinaryBuffer(raw);
    let blob;
    if (binary) {
      blob = await githubRequest("POST", `${API_BASE}/repos/${repo}/git/blobs`, authHeader, {
        content: raw.toString("base64"),
        encoding: "base64",
      });
    } else {
      const text = sanitizeText(raw.toString("utf8"));
      blob = await githubRequest("POST", `${API_BASE}/repos/${repo}/git/blobs`, authHeader, {
        content: text,
        encoding: "utf-8",
      });
    }
    treeEntries.push({
      path: file,
      mode: executable ? "100755" : "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  const tree = await githubRequest("POST", `${API_BASE}/repos/${repo}/git/trees`, authHeader, {
    tree: treeEntries,
  });

  let parentSha = null;
  try {
    const branchRef = await requestJson("GET", `${API_BASE}/repos/${repo}/git/ref/heads/${encodeURIComponent(targetCommitish)}`, authHeader);
    if (branchRef.statusCode >= 200 && branchRef.statusCode < 300 && branchRef.body && branchRef.body.object && branchRef.body.object.sha) {
      parentSha = branchRef.body.object.sha;
    }
  } catch {}

  const commit = await githubRequest("POST", `${API_BASE}/repos/${repo}/git/commits`, authHeader, {
    message: `release ${tag} sanitized snapshot`,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  });

  const tagStatus = await upsertGitRef(authHeader, `tags/${tag}`, commit.sha);
  const branchStatus = await upsertGitRef(authHeader, `heads/${targetCommitish}`, commit.sha);
  console.log(`▸ tag status: ${tagStatus}`);
  console.log(`▸ branch status: ${branchStatus}`);
  console.log(`▸ commit sha: ${commit.sha}`);

  const releaseArgs = [
    "--repo", repo,
    "--tag", tag,
    "--release-name", releaseName,
    "--notes", body,
    "--target", targetCommitish,
  ];
  if (draft) releaseArgs.push("--draft");
  if (prerelease) releaseArgs.push("--prerelease");

  execFileSync("bash", [UPLOAD_SCRIPT, ...releaseArgs], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
}

let REPO_SLUG = DEFAULT_REPO;

main().catch((error) => {
  console.error(`Error: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
