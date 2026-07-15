import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Read project-local YCE exclusions. The syntax intentionally matches the
 * engine's existing simple exclude globs: one pattern per line, blank lines
 * and lines beginning with # are ignored.
 */
export function loadYceIgnore(projectRoot) {
  const ignorePath = join(resolve(projectRoot), ".yceignore");
  if (!existsSync(ignorePath)) {
    return { path: null, patterns: [] };
  }

  const patterns = [];
  const seen = new Set();
  const content = readFileSync(ignorePath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of content.split(/\r?\n/)) {
    const pattern = rawLine.trim();
    if (!pattern || pattern.startsWith("#") || pattern.includes("\0")) continue;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return { path: ignorePath, patterns };
}
