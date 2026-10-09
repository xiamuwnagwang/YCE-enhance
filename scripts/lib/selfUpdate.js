const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { execFile, spawn } = require("child_process");
const { readLocalVersion } = require("./versionCheck");

/**
 * 强制自更新：versionCheck 检测到服务端版本更高时，下载对应 tag 的
 * tar.gz 原地替换 skill 文件，然后由 CLI 重跑本次命令。
 *
 * 约束：
 * - 只换 install 脚本同一份清单里的条目；.env 永不触碰。
 * - vendor/yce-engine/node_modules 整目录保留（发布包不含平台 ripgrep
 *   二进制，删了就得每次更新重下），换完按需补一次 npm install。
 * - 任何一步失败都退回「手动升级横幅 + 继续执行」，绝不阻塞本次调用。
 * - 解压用系统 tar（Windows 10+ 自带 bsdtar），不依赖 PowerShell/bash。
 */

const DEFAULT_REPO = "xiamuwnagwang/YCE-enhance";
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_MAX_REDIRECTS = 4;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const NPM_REPAIR_TIMEOUT_MS = 180 * 1000;

// 与 install.sh / install.ps1 的 INSTALL_FILES 对齐；压缩包里没有的条目跳过。
const SWAP_ITEMS = [
  "scripts",
  "vendor",
  "test",
  "references",
  "mcp",
  "SKILL.md",
  "README.md",
  "install.sh",
  "install.ps1",
];

function repoSlug() {
  return (process.env.YCE_SELF_UPDATE_REPO || "").trim() || DEFAULT_REPO;
}

// downloadUrl 只有指向 .tar.gz 直链时才直接用；管理台目前填的是仓库主页，
// 此时按远端版本号拼 codeload tag 地址（tag 由 publish-release.js 与 Release 同步打）。
function resolveArchiveUrl(info) {
  const direct = String((info && info.downloadUrl) || "").trim();
  if (/^https?:\/\//i.test(direct) && /\.t(?:ar\.)?gz$/i.test(direct)) {
    return direct;
  }
  const version = String((info && info.remoteVersion) || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return `https://codeload.github.com/${repoSlug()}/tar.gz/refs/tags/v${version}`;
}

function autoSelfUpdateEnabled() {
  // YCE_SELF_UPDATED 是重跑子进程的防循环标记，外部设置同样生效。
  if (process.env.YCE_SELF_UPDATED === "1") return false;
  const flag = (process.env.YCE_AUTO_SELF_UPDATE || "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(flag);
}

function lockPathFor(rootDir) {
  const hash = crypto
    .createHash("sha1")
    .update(path.resolve(rootDir))
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), `yce-selfupdate-${hash}.lock`);
}

// 并发调用同时触发更新时只放行一个；10 分钟未释放视为残留锁可抢占。
function acquireLock(rootDir) {
  const file = lockPathFor(rootDir);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return null;
    fs.rmSync(file, { force: true });
  } catch {}
  try {
    fs.writeFileSync(file, String(Date.now()), { flag: "wx" });
    return file;
  } catch {
    return null;
  }
}

function releaseLock(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

function downloadToFile(url, destPath, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = DOWNLOAD_MAX_REDIRECTS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let stream = null;
    try {
      const lib = url.startsWith("https:") ? https : http;
      const req = lib.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          downloadToFile(res.headers.location, destPath, redirectsLeft - 1).then(done);
          return;
        }
        if (status !== 200) {
          res.resume();
          done(false);
          return;
        }
        let bytes = 0;
        stream = fs.createWriteStream(destPath);
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_ARCHIVE_BYTES) {
            req.destroy();
            stream.destroy();
            done(false);
          }
        });
        res.pipe(stream);
        stream.on("finish", () => done(true));
        stream.on("error", () => done(false));
      });
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
    } catch {
      done(false);
    }
  });
}

function extractTarGz(archivePath, destDir) {
  return new Promise((resolve) => {
    execFile(
      "tar",
      ["-xzf", archivePath, "-C", destDir],
      { timeout: EXTRACT_TIMEOUT_MS },
      (error) => resolve(!error),
    );
  });
}

// codeload tag 包根目录形如 YCE-enhance-3.8.4/；解包后必须恰好一个顶层目录。
function findPackageRoot(extractDir) {
  try {
    const entries = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    if (entries.length !== 1) return null;
    return path.join(extractDir, entries[0].name);
  } catch {
    return null;
  }
}

function swapFiles(srcRoot, rootDir) {
  const nodeModules = path.join(rootDir, "vendor", "yce-engine", "node_modules");
  // tmpdir 可能与 skill 目录不在同一卷，rename 会 EXDEV，用 cpSync 兜底。
  let preserved = null;
  if (fs.existsSync(nodeModules)) {
    preserved = path.join(os.tmpdir(), `yce-nm-${Date.now()}-${process.pid}`);
    fs.cpSync(nodeModules, preserved, { recursive: true });
  }
  try {
    for (const item of SWAP_ITEMS) {
      const src = path.join(srcRoot, item);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(rootDir, item);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  } finally {
    if (preserved) {
      try {
        fs.rmSync(nodeModules, { recursive: true, force: true });
        fs.cpSync(preserved, nodeModules, { recursive: true });
      } catch {}
      try {
        fs.rmSync(preserved, { recursive: true, force: true });
      } catch {}
    }
  }
}

function platformRipgrepPackage() {
  return `@vscode/ripgrep-${process.platform}-${process.arch}`;
}

function needsNpmRepair(rootDir) {
  const pkgDir = path.join(
    rootDir,
    "vendor",
    "yce-engine",
    "node_modules",
    "@vscode",
    platformRipgrepPackage(),
  );
  return !fs.existsSync(pkgDir);
}

// 参数是固定常量，shell:true 只为兼容 Windows 的 npm.cmd；失败不致命。
function runNpmRepair(rootDir) {
  return new Promise((resolve) => {
    const engineDir = path.join(rootDir, "vendor", "yce-engine");
    let child;
    try {
      child = spawn(
        "npm",
        ["install", "--omit=dev", "--no-audit", "--fund=false"],
        { cwd: engineDir, shell: true, stdio: "ignore" },
      );
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, NPM_REPAIR_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * 执行一次自更新。info 是 versionCheck.checkForUpdate 的返回值。
 * archivePath 供测试注入本地压缩包，跳过网络下载。
 */
async function performSelfUpdate({ rootDir, info, archivePath, skipNpmRepair }) {
  const fromVersion = readLocalVersion(rootDir);
  const expected = String((info && info.remoteVersion) || "").trim().replace(/^v/i, "");
  const url = archivePath ? null : resolveArchiveUrl(info);
  if (!archivePath && !url) {
    return { ok: false, reason: "no-archive-url" };
  }
  const lock = acquireLock(rootDir);
  if (!lock) {
    return { ok: false, reason: "locked" };
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "yce-selfupdate-"));
  try {
    const archive = archivePath || path.join(work, "pkg.tar.gz");
    if (!archivePath) {
      const downloaded = await downloadToFile(url, archive);
      if (!downloaded) {
        return { ok: false, reason: "download-failed" };
      }
    }
    const extractDir = path.join(work, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    if (!(await extractTarGz(archive, extractDir))) {
      return { ok: false, reason: "extract-failed" };
    }
    const srcRoot = findPackageRoot(extractDir);
    if (!srcRoot) {
      return { ok: false, reason: "no-package-root" };
    }
    // 完整性锚点：包内版本必须等于服务端报的版本，防止下错包或被篡改。
    const gotVersion = readLocalVersion(srcRoot);
    if (!expected || gotVersion !== expected) {
      return { ok: false, reason: "version-mismatch", gotVersion: gotVersion || "" };
    }
    swapFiles(srcRoot, rootDir);
    if (!skipNpmRepair && needsNpmRepair(rootDir)) {
      await runNpmRepair(rootDir);
    }
    return { ok: true, fromVersion, toVersion: expected };
  } catch (error) {
    return { ok: false, reason: (error && error.message) || "unexpected" };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {}
    releaseLock(lock);
  }
}

// 更新成功后用同一 argv 重跑；YCE_SELF_UPDATED=1 防止子进程再次触发更新。
function rerunAfterUpdate() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
        env: { ...process.env, YCE_SELF_UPDATED: "1" },
        stdio: "inherit",
      });
    } catch {
      resolve(null);
      return;
    }
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === null ? 1 : code));
  });
}

module.exports = {
  performSelfUpdate,
  resolveArchiveUrl,
  autoSelfUpdateEnabled,
  rerunAfterUpdate,
};
