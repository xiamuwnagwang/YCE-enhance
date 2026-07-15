const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

/**
 * Resolve public skill-version API.
 * Priority:
 * 1. YCE_VERSION_API_URL
 * 2. {origin}/api/public/skill-version from YCE_RELAY_URL / YCE_API_URL
 * 3. production default https://yce.aigy.de/api/public/skill-version
 */
function resolveVersionEndpoint() {
  const explicit = (process.env.YCE_VERSION_API_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const relay =
    (process.env.YCE_RELAY_URL || "").trim() ||
    (process.env.YCE_API_URL || "").trim() ||
    (process.env.YCE_YOUWEN_API_URL || "").trim();
  if (relay) {
    try {
      const u = new URL(relay);
      return `${u.origin}/api/public/skill-version`;
    } catch {
      // ignore
    }
  }

  return "https://yce.aigy.de/api/public/skill-version";
}

const VERSION_ENDPOINT = resolveVersionEndpoint();
const REMOTE_SKILL_NAME =
  process.env.YCE_VERSION_SKILL_NAME ||
  "yce";
// Short TTL so server-side version bumps show up quickly; banner still shows
// every call when local < remote (cache only avoids hammering the API).
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const CACHE_FILE = path.join(os.tmpdir(), "yce-version-check.json");

function readVersionFromText(text) {
  if (!text) return null;
  const m = String(text).match(/^version:\s*(\S+)/m);
  return m ? m[1].trim() : null;
}

function readLocalVersion(rootDir) {
  try {
    const skillPath = path.join(rootDir, "SKILL.md");
    return readVersionFromText(fs.readFileSync(skillPath, "utf8"));
  } catch {
    return null;
  }
}

function compareSemver(a, b) {
  const strip = (v) => String(v || "").replace(/^v/i, "");
  const pa = strip(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = strip(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

function getCacheKey() {
  return `${VERSION_ENDPOINT || "disabled"}::${REMOTE_SKILL_NAME}`;
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (
      raw &&
      typeof raw.checkedAt === "number" &&
      typeof raw.remoteVersion === "string" &&
      raw.cacheKey === getCacheKey()
    ) {
      return raw;
    }
  } catch {}
  return null;
}

function writeCache(payload) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload), "utf8");
  } catch {}
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    try {
      const lib = url.startsWith("https:") ? https : http;
      const req = lib.get(url, { timeout: timeoutMs, headers: { Accept: "application/json" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchJson(res.headers.location, timeoutMs).then(done);
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 64 * 1024) {
            req.destroy();
            done(null);
          }
        });
        res.on("end", () => {
          try {
            done({ statusCode: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            done(null);
          }
        });
      });
      req.on("timeout", () => {
        req.destroy();
        done(null);
      });
      req.on("error", () => done(null));
    } catch {
      done(null);
    }
  });
}

async function getRemoteVersionMeta({ force = false } = {}) {
  if (!VERSION_ENDPOINT) {
    return { version: null, fromCache: false, meta: null };
  }

  const cache = readCache();
  if (!force && cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) {
    return {
      version: cache.remoteVersion,
      fromCache: true,
      meta: {
        downloadUrl: cache.downloadUrl || null,
        upgradeHint: cache.upgradeHint || null,
        notes: cache.notes || null,
      },
    };
  }

  const url = new URL(VERSION_ENDPOINT);
  url.searchParams.set("name", REMOTE_SKILL_NAME);
  const response = await fetchJson(url.toString(), 3000);
  if (!response || response.statusCode !== 200 || !response.body || typeof response.body.version !== "string") {
    // Fall back to stale cache if network fails
    if (cache && cache.remoteVersion) {
      return {
        version: cache.remoteVersion,
        fromCache: true,
        meta: {
          downloadUrl: cache.downloadUrl || null,
          upgradeHint: cache.upgradeHint || null,
          notes: cache.notes || null,
        },
      };
    }
    return { version: null, fromCache: false, meta: null };
  }

  const version = response.body.version.trim().replace(/^v/i, "");
  const downloadUrl =
    typeof response.body.downloadUrl === "string" ? response.body.downloadUrl.trim() : "";
  const upgradeHint =
    typeof response.body.upgradeHint === "string" ? response.body.upgradeHint.trim() : "";
  const notes = typeof response.body.notes === "string" ? response.body.notes.trim() : "";

  if (version) {
    writeCache({
      cacheKey: getCacheKey(),
      checkedAt: Date.now(),
      remoteVersion: version,
      downloadUrl,
      upgradeHint,
      notes,
    });
  }
  return {
    version,
    fromCache: false,
    meta: { downloadUrl: downloadUrl || null, upgradeHint: upgradeHint || null, notes: notes || null },
  };
}

async function getRemoteVersion({ force = false } = {}) {
  const result = await getRemoteVersionMeta({ force });
  return { version: result.version, fromCache: result.fromCache };
}

async function checkForUpdate({ rootDir, force = false } = {}) {
  if (process.env.YCE_DISABLE_UPDATE_CHECK === "1") return null;
  const localVersion = readLocalVersion(rootDir);
  if (!localVersion) return null;
  const { version: remoteVersion, meta } = await getRemoteVersionMeta({ force });
  if (!remoteVersion) return null;
  const cmp = compareSemver(localVersion, remoteVersion);
  return {
    localVersion,
    remoteVersion,
    remoteSkillName: REMOTE_SKILL_NAME,
    versionApiUrl: VERSION_ENDPOINT,
    downloadUrl: meta?.downloadUrl || null,
    upgradeHint: meta?.upgradeHint || null,
    notes: meta?.notes || null,
    rootDir: rootDir || null,
    updateAvailable: cmp < 0,
  };
}

function looksLikeHardcodedUserPath(hint) {
  const text = String(hint || "");
  // Server-side hints often hardcode one user's install path; clients install to
  // ~/.claude/skills, ~/.cursor/skills, ~/.agents/skills, etc.
  return /\$HOME\/\.|~\/\.|\/Users\/|\/home\//.test(text);
}

function resolveLocalInstallScript(rootDir) {
  if (!rootDir) return null;
  const candidates = [
    path.join(rootDir, "install.sh"),
    path.join(rootDir, "scripts", "install.sh"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {}
  }
  return null;
}

function formatUpdateBanner(info, options = {}) {
  if (!info || !info.updateAvailable) return null;
  const rootDir = options.rootDir || info.rootDir || null;
  const installScript = resolveLocalInstallScript(rootDir);
  const lines = [];
  lines.push("");
  lines.push("==================================================");
  lines.push("⬆  yce skill 有新版本可用！请先升级后再继续使用。");
  lines.push(`   当前本地版本: v${info.localVersion}`);
  lines.push(`   最新远端版本: v${info.remoteVersion}`);
  lines.push(`   远端检测源: ${info.versionApiUrl}?name=${info.remoteSkillName}`);
  if (info.notes) {
    lines.push(`   说明: ${info.notes}`);
  }
  if (info.downloadUrl) {
    lines.push(`   下载: ${info.downloadUrl}`);
  }
  lines.push("   升级方法（按你本机当前 skill 目录，勿照搬他人路径）:");
  if (installScript) {
    lines.push(`     bash "${installScript}" --install`);
    lines.push("   Windows:");
    lines.push(`     powershell -ExecutionPolicy Bypass -File "${path.join(rootDir, "install.ps1")}" -Install`);
  } else if (rootDir) {
    lines.push(`     cd "${rootDir}" && bash ./install.sh --install`);
  } else {
    lines.push("     在本机 yce skill 根目录执行: bash ./install.sh --install");
  }
  lines.push("   说明: --install 会下载最新版并更新已检测到的安装目标（claude/cursor/agents 等）");
  // Only show remote custom hint when it is not a hardcoded single-user path.
  if (info.upgradeHint && !looksLikeHardcodedUserPath(info.upgradeHint)) {
    lines.push(`   额外说明: ${info.upgradeHint}`);
  }
  lines.push("==================================================");
  return lines.join("\n");
}

module.exports = {
  checkForUpdate,
  formatUpdateBanner,
  compareSemver,
  readLocalVersion,
  resolveVersionEndpoint,
  VERSION_ENDPOINT,
};
