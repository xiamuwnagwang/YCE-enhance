import { readdirSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ENTRIES = 12000;
const DEFAULT_MAX_BYTES = 512 * 1024;

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function testRegex(rx, value) {
  if (!rx || typeof rx.test !== "function") return false;
  rx.lastIndex = 0;
  return rx.test(value);
}

function shouldExclude(name, relPath, excludeRegexes) {
  if (!Array.isArray(excludeRegexes) || excludeRegexes.length === 0) return false;
  const normalizedRel = relPath.split(sep).join("/");
  return excludeRegexes.some((rx) => testRegex(rx, name) || testRegex(rx, normalizedRel));
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    const aDir = a.isDirectory && !a.isSymlink;
    const bDir = b.isDirectory && !b.isSymlink;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Build a compact, deterministic directory tree without external packages.
 *
 * @param {string} rootPath
 * @param {{
 *   virtualRoot?: string,
 *   maxDepth?: number,
 *   excludeRegexes?: RegExp[],
 *   maxEntries?: number,
 *   maxBytes?: number
 * }} [options]
 * @returns {string}
 */
export function buildDirectoryTree(rootPath, options = {}) {
  const virtualRoot = options.virtualRoot || rootPath;
  const maxDepth = clampInt(options.maxDepth, DEFAULT_MAX_DEPTH, 1, 8);
  const maxEntries = clampInt(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, 100000);
  const maxBytes = clampInt(options.maxBytes, DEFAULT_MAX_BYTES, 1024, 20 * 1024 * 1024);
  const excludeRegexes = Array.isArray(options.excludeRegexes) ? options.excludeRegexes : [];

  const lines = [virtualRoot];
  let entriesSeen = 0;
  let sizeBytes = Buffer.byteLength(lines[0], "utf-8") + 1;
  let truncated = false;

  const pushLine = (line) => {
    if (truncated) return false;
    const nextSize = sizeBytes + Buffer.byteLength(line, "utf-8") + 1;
    if (entriesSeen >= maxEntries || nextSize > maxBytes) {
      truncated = true;
      lines.push("... (tree truncated)");
      return false;
    }
    lines.push(line);
    entriesSeen += 1;
    sizeBytes = nextSize;
    return true;
  };

  const readEntries = (dir, relDir) => {
    let rawEntries;
    try {
      rawEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const entries = [];
    for (const entry of rawEntries) {
      const relPath = relDir ? join(relDir, entry.name) : entry.name;
      if (shouldExclude(entry.name, relPath, excludeRegexes)) continue;

      const abs = join(dir, entry.name);
      let isDirectory = false;
      let isSymlink = false;
      try {
        const st = lstatSync(abs);
        isDirectory = st.isDirectory();
        isSymlink = st.isSymbolicLink();
      } catch {
        // Keep unreadable entries visible, but do not descend into them.
      }
      entries.push({ name: entry.name, abs, relPath, isDirectory, isSymlink });
    }
    return sortEntries(entries);
  };

  const walk = (dir, relDir, prefix, depthRemaining) => {
    if (truncated || depthRemaining <= 0) return;
    const entries = readEntries(dir, relDir);

    entries.forEach((entry, index) => {
      if (truncated) return;
      const isLast = index === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      if (!pushLine(`${prefix}${connector}${entry.name}`)) return;
      if (entry.isDirectory && !entry.isSymlink) {
        walk(entry.abs, entry.relPath, childPrefix, depthRemaining - 1);
      }
    });
  };

  walk(rootPath, "", "", maxDepth);
  return lines.join("\n");
}
