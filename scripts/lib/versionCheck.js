const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

const VERSION_ENDPOINT =
  process.env.YCE_VERSION_API_URL ||
  "https://a.aigy.de/api/skill/version";
const REMOTE_SKILL_NAME =
  process.env.YCE_VERSION_SKILL_NAME ||
  "yce";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
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
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

function getCacheKey() {
  return `${VERSION_ENDPOINT}::${REMOTE_SKILL_NAME}`;
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

async function getRemoteVersion({ force = false } = {}) {
  const cache = readCache();
  if (!force && cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) {
    return { version: cache.remoteVersion, fromCache: true };
  }

  const url = new URL(VERSION_ENDPOINT);
  url.searchParams.set("name", REMOTE_SKILL_NAME);
  const response = await fetchJson(url.toString(), 3000);
  if (!response || response.statusCode !== 200 || !response.body || typeof response.body.version !== "string") {
    return { version: null, fromCache: false };
  }

  const version = response.body.version.trim();
  if (version) {
    writeCache({
      cacheKey: getCacheKey(),
      checkedAt: Date.now(),
      remoteVersion: version,
    });
  }
  return { version, fromCache: false };
}

async function checkForUpdate({ rootDir, force = false } = {}) {
  if (process.env.YCE_DISABLE_UPDATE_CHECK === "1") return null;
  const localVersion = readLocalVersion(rootDir);
  if (!localVersion) return null;
  const { version: remoteVersion } = await getRemoteVersion({ force });
  if (!remoteVersion) return null;
  const cmp = compareSemver(localVersion, remoteVersion);
  return {
    localVersion,
    remoteVersion,
    remoteSkillName: REMOTE_SKILL_NAME,
    versionApiUrl: VERSION_ENDPOINT,
    updateAvailable: cmp < 0,
  };
}

function formatUpdateBanner(info) {
  if (!info || !info.updateAvailable) return null;
  const lines = [];
  lines.push("");
  lines.push("==================================================");
  lines.push("⬆  yce skill 有新版本可用！");
  lines.push(`   当前本地版本: v${info.localVersion}`);
  lines.push(`   最新远端版本: v${info.remoteVersion}`);
  lines.push(`   远端检测源: ${info.versionApiUrl}?name=${info.remoteSkillName}`);
  lines.push("   升级方法:");
  lines.push("     bash $HOME/.agents/skills/yce/install.sh --sync");
  lines.push("   （或重新跑 install.sh --install / install.ps1 -Install）");
  lines.push("==================================================");
  return lines.join("\n");
}

module.exports = {
  checkForUpdate,
  formatUpdateBanner,
  compareSemver,
  readLocalVersion,
};
