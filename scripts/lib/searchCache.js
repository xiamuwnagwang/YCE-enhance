"use strict";

/**
 * Content-addressed cache for yce-engine search results.
 *
 * Key = sha256(revision | fingerprint | cwd | query | max-results | max-turns
 * | engineScriptPath | bootstrap-mode). The fingerprint proves the workspace
 * didn't change since the cached call; the rest of the tuple proves the call
 * itself didn't change. Only the engine's raw payload is cached — never the
 * <code-context> body, which must be re-read from disk on every hit so a
 * cache hit can't serve stale file content.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CACHE_REVISION = "v1";
const DEFAULT_TTL_MS = 21600000; // 6h
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

// Mirrors scripts/lib/localFastSearch.js's DEFAULT_SKIP_DIRS. Not imported
// because that module doesn't export it and fingerprinting needs *every*
// file (not just text files), so the two walkers can't share a function.
const PLAIN_SKIP_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  ".vercel",
  "__pycache__",
  "build",
  "bundle",
  "bundled",
  "coverage",
  "data",
  "deps",
  "dist",
  "fixtures",
  "logs",
  "node_modules",
  "out",
  "target",
  "third_party",
  "vendor",
  "venv",
]);

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function defaultCacheDir() {
  // Lazy require: avoids a hard dependency cycle risk and keeps this module
  // usable standalone in tests that don't need resultSink at all.
  const { defaultResultDir } = require("./resultSink");
  return path.join(path.dirname(defaultResultDir()), "yce-cache");
}

function resolveCacheConfig(env = {}) {
  const rawEnabled = String((env && env.YCE_SEARCH_CACHE) || "").trim().toLowerCase();
  const enabled = !DISABLED_VALUES.has(rawEnabled);

  let ttlMs = DEFAULT_TTL_MS;
  const rawTtl = env && env.YCE_SEARCH_CACHE_TTL_MS;
  if (rawTtl !== undefined && rawTtl !== null && String(rawTtl).trim() !== "") {
    const parsed = Number.parseInt(String(rawTtl).trim(), 10);
    // Only strictly positive TTLs are honored: 0 would mean "every entry
    // expires instantly" and a sweeping cutoff of now, which would wipe
    // entries written under a normal TTL. Non-positive values fall back to
    // the default, matching utils.js's toPositiveInt on the CLI path.
    if (Number.isFinite(parsed) && parsed > 0) {
      ttlMs = parsed;
    }
  }

  const overrideDir = String((env && env.YCE_SEARCH_CACHE_DIR) || "").trim();
  const dir = overrideDir || defaultCacheDir();

  return { enabled, ttlMs, dir };
}

/**
 * Decode git's C-style double-quoted path form. Defense in depth for the
 * quotePath=false spawn above: old git versions (or odd user config) still
 * emit quoted paths, and a naive strip-the-quotes fallback would leave
 * literal `\346\226\207` octal escapes behind, which then never stat.
 * Octal escapes encode raw UTF-8 bytes, so they are collected into a byte
 * array and decoded once — String.fromCharCode per escape would shred
 * multi-byte characters.
 */
function unquoteGitPath(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  if (!body.includes("\\")) return body;
  const bytes = [];
  const simpleEscape = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    i += 1;
    if (i >= body.length) break;
    const esc = body[i];
    if (esc >= "0" && esc <= "7") {
      let digits = esc;
      while (digits.length < 3 && i + 1 < body.length && body[i + 1] >= "0" && body[i + 1] <= "7") {
        digits += body[i + 1];
        i += 1;
      }
      bytes.push(parseInt(digits, 8) & 0xff);
    } else {
      const code = Object.prototype.hasOwnProperty.call(simpleEscape, esc)
        ? simpleEscape[esc]
        : body.charCodeAt(i);
      bytes.push(code);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * `git status --porcelain` can't reveal content changes to already-untracked
 * files (the "??" line is presence-only), so callers must stat every listed
 * path and fold (size, mtime) into the fingerprint too.
 */
function parsePorcelainPaths(statusOut) {
  const paths = [];
  for (const rawLine of statusOut.split("\n")) {
    if (!rawLine) continue;
    let rest = rawLine.slice(3);
    const arrowIndex = rest.indexOf(" -> ");
    if (arrowIndex !== -1) {
      rest = rest.slice(arrowIndex + 4);
    }
    rest = unquoteGitPath(rest);
    if (rest) paths.push(rest);
  }
  return paths;
}

function statTriple(cwd, relPath) {
  const abs = path.resolve(cwd, relPath);
  try {
    const st = fs.statSync(abs);
    return `${relPath}\t${st.size}\t${Math.round(st.mtimeMs)}`;
  } catch {
    return `${relPath}\tMISSING`;
  }
}

function computeGitFingerprint(cwd) {
  // No separate "is this a git repo" probe: `ls-files` itself fails with a
  // non-zero exit outside a work tree (or if git is missing), so this one
  // call does double duty and halves the spawns on the hot cache-lookup path.
  const lsFiles = spawnSync("git", ["-C", cwd, "ls-files", "-s"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (lsFiles.error || lsFiles.status !== 0) {
    return null;
  }
  const status = spawnSync(
    "git",
    // core.quotePath=false stops git from octal-escaping non-ASCII paths;
    // escaped names would defeat the (size, mtime) supplement below and let
    // content edits to those files slip through as cache hits.
    ["-C", cwd, "-c", "core.quotePath=false", "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (status.error || status.status !== 0) {
    return null;
  }

  const lsOut = lsFiles.stdout || "";
  const statusOut = status.stdout || "";
  const supplement = parsePorcelainPaths(statusOut)
    .map((relPath) => statTriple(cwd, relPath))
    .join("\n");

  return sha256(`${lsOut}\n${statusOut}\n${supplement}`);
}

function collectAllFiles(rootDir) {
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (PLAIN_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function computePlainFingerprint(cwd) {
  const relPaths = collectAllFiles(cwd)
    .map((absPath) => path.relative(cwd, absPath))
    .sort();
  const lines = relPaths.map((relPath) => statTriple(cwd, relPath));
  return sha256(lines.join("\n"));
}

function computeFingerprint(cwd) {
  const startedAt = Date.now();
  const git = computeGitFingerprint(cwd);
  if (git !== null) {
    return { fingerprint: git, elapsedMs: Date.now() - startedAt, mode: "git" };
  }
  const plain = computePlainFingerprint(cwd);
  return { fingerprint: plain, elapsedMs: Date.now() - startedAt, mode: "plain" };
}

function buildCacheKey({ fingerprint, cwd, query, maxResults, maxTurns, scriptPath, bootstrapMode }) {
  const raw = [
    CACHE_REVISION,
    fingerprint,
    cwd,
    query,
    maxResults,
    maxTurns,
    scriptPath,
    bootstrapMode,
  ].join("|");
  return sha256(raw);
}

function cacheFilePath(dir, key) {
  return path.join(dir, `${key}.json`);
}

function readCacheEntry(dir, key, ttlMs) {
  const file = cacheFilePath(dir, key);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    try {
      fs.unlinkSync(file);
    } catch {}
    return null;
  }

  if (typeof entry.storedAt !== "number" || Date.now() - entry.storedAt > ttlMs) {
    try {
      fs.unlinkSync(file);
    } catch {}
    return null;
  }

  return entry;
}

/**
 * Best-effort: drop other expired entries so the cache dir can't grow forever.
 * Each entry is judged by the TTL it was written with, not the caller's: a
 * process running with a 1s TTL must not evict a 6h entry another process
 * just wrote. Corrupt entries are removed outright.
 */
function sweepExpired(dir, callerTtlMs) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (name.endsWith(".tmp")) {
        // Staging residue from a crashed writer (never picked up by reads,
        // which only look for <key>.json). The age gate keeps a live
        // writer's in-flight staging file safe.
        if (Date.now() - st.mtimeMs > 10 * 60 * 1000) fs.unlinkSync(full);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      let ttl = callerTtlMs;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
        if (typeof parsed?.ttlMs === "number" && parsed.ttlMs > 0) ttl = parsed.ttlMs;
      } catch {
        fs.unlinkSync(full);
        continue;
      }
      if (Date.now() - st.mtimeMs > ttl) fs.unlinkSync(full);
    } catch {}
  }
}

/**
 * Best-effort by design: a read-only, missing, or otherwise broken cache
 * dir must never turn an already-successful search into a CLI error. Every
 * failure mode here resolves to "the entry just isn't cached".
 */
function writeCacheEntry(dir, key, payload, ttlMs) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const entry = { ...payload, storedAt: Date.now(), ttlMs };
    const file = cacheFilePath(dir, key);
    const staging = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(staging, JSON.stringify(entry));
      fs.renameSync(staging, file);
    } catch (writeErr) {
      try {
        fs.unlinkSync(staging);
      } catch {}
      throw writeErr;
    }
    sweepExpired(dir, ttlMs);
  } catch {
    // Intentionally swallowed: the search result itself is intact.
  }
}

module.exports = {
  CACHE_REVISION,
  DEFAULT_TTL_MS,
  buildCacheKey,
  cacheFilePath,
  computeFingerprint,
  readCacheEntry,
  resolveCacheConfig,
  unquoteGitPath,
  writeCacheEntry,
};
