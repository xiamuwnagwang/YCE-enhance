import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { TOKENIZER_VERSION } from "./lexicon.cjs";

export const PRERANK_INDEX_VERSION = 1;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_REFRESH_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_DOCUMENTS = 64;

const memoryCache = new Map();

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function prerankIndexPath(projectRoot) {
  const dir = String(process.env.YCE_PRERANK_INDEX_DIR || "").trim()
    || join(homedir(), ".cache", "yce-engine", "prerank-index");
  const digest = createHash("sha256").update(resolve(projectRoot)).digest("hex");
  return join(dir, `${digest}.json`);
}

class PrerankIndex {
  constructor(projectRoot, options) {
    this.projectRoot = projectRoot;
    this.path = options.path;
    this.maxBytes = options.maxBytes;
    this.minDocuments = options.minDocuments;
    this.now = options.now;
    this.entries = new Map();
    this.mode = "memory";
    this.hits = 0;
    this.misses = 0;
    this.loadMs = 0;
    this.saveMs = 0;
    this.dirty = false;
    this.loadedFromDisk = false;
  }

  load() {
    const startedAt = Date.now();
    try {
      const stat = statSync(this.path);
      const cached = memoryCache.get(this.path);
      if (
        cached
        && cached.projectRoot === this.projectRoot
        && cached.size === stat.size
        && cached.mtimeMs === stat.mtimeMs
      ) {
        this.entries = cached.entries;
        this.loadedFromDisk = true;
        return;
      }

      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      if (
        !raw
        || typeof raw !== "object"
        || raw.version !== PRERANK_INDEX_VERSION
        || raw.tokenizerVersion !== TOKENIZER_VERSION
        || raw.projectRoot !== this.projectRoot
        || !raw.entries
        || typeof raw.entries !== "object"
      ) return;

      this.entries = new Map(Object.entries(raw.entries));
      this.loadedFromDisk = true;
      memoryCache.set(this.path, {
        entries: this.entries,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        projectRoot: this.projectRoot,
      });
    } catch {
      // A missing, corrupt, or unreadable cache is a cold run.
    } finally {
      this.loadMs = Date.now() - startedAt;
    }
  }

  get(relPath, size, mtimeMs) {
    const entry = this.entries.get(relPath);
    if (!entry || typeof entry !== "object" || entry.size !== size || entry.mtimeMs !== mtimeMs) {
      return null;
    }
    const validSkip = entry.skip === 1;
    const validProfile = !entry.skip
      && Number.isInteger(entry.len)
      && entry.len >= 0
      && entry.tf
      && typeof entry.tf === "object"
      && !Array.isArray(entry.tf)
      && Array.isArray(entry.decl)
      && entry.decl.every((name) => typeof name === "string")
      && Array.isArray(entry.beh)
      && entry.beh.every((name) => typeof name === "string");
    if (!validSkip && !validProfile) {
      this.entries.delete(relPath);
      this.dirty = true;
      return null;
    }
    this.hits += 1;
    const previousSeenAt = Number(entry.seenAt) || 0;
    entry.seenAt = this.now;
    if (this.now - previousSeenAt > SEEN_REFRESH_MS) this.dirty = true;
    return entry;
  }

  put(relPath, profile) {
    this.entries.set(relPath, { ...profile, seenAt: this.now });
    this.dirty = true;
    this.misses += 1;
  }

  putSkip(relPath, size, mtimeMs) {
    this.entries.set(relPath, { size, mtimeMs, skip: 1, seenAt: this.now });
    this.dirty = true;
    this.misses += 1;
  }

  countMiss() {
    this.misses += 1;
  }

  save(documentCount) {
    const startedAt = Date.now();
    let tmp = "";
    try {
      if (!this.dirty) {
        this.mode = this.loadedFromDisk ? "disk" : "memory";
        return;
      }
      if (documentCount < this.minDocuments) {
        this.mode = "memory";
        return;
      }

      this.prune();
      const payload = JSON.stringify({
        version: PRERANK_INDEX_VERSION,
        tokenizerVersion: TOKENIZER_VERSION,
        projectRoot: this.projectRoot,
        entries: Object.fromEntries(this.entries),
      });
      if (Buffer.byteLength(payload) > this.maxBytes) {
        this.mode = "memory";
        return;
      }

      mkdirSync(dirname(this.path), { recursive: true });
      tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, payload);
      renameSync(tmp, this.path);
      const stat = statSync(this.path);
      memoryCache.set(this.path, {
        entries: this.entries,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        projectRoot: this.projectRoot,
      });
      this.loadedFromDisk = true;
      this.mode = "disk";
    } catch {
      this.mode = "memory";
      if (tmp) {
        try { rmSync(tmp, { force: true }); } catch {}
      }
    } finally {
      this.saveMs = Date.now() - startedAt;
    }
  }

  prune() {
    for (const [key, entry] of this.entries) {
      if (
        !entry
        || typeof entry !== "object"
        || !(this.now - Number(entry.seenAt) <= PRUNE_AFTER_MS)
      ) this.entries.delete(key);
    }
  }
}

export function openPrerankIndex(projectRoot, options = {}) {
  if (process.env.YCE_PRERANK_INDEX === "0") return null;
  const root = resolve(projectRoot);
  const index = new PrerankIndex(root, {
    path: prerankIndexPath(root),
    maxBytes: positiveInt(process.env.YCE_PRERANK_INDEX_MAX_BYTES, DEFAULT_MAX_BYTES),
    minDocuments: nonNegativeInt(process.env.YCE_PRERANK_INDEX_MIN_DOCS, DEFAULT_MIN_DOCUMENTS),
    now: options.now || Date.now(),
  });
  index.load();
  return index;
}

function clearMemoryCache() {
  memoryCache.clear();
}

export const __test = { clearMemoryCache };
