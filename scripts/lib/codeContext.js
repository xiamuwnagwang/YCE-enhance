const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// These constants independently reproduce the curation behavior documented for
// Better Context Engine (curate.go/service.go); this implementation does not
// copy its source code. BCE is PolyForm Noncommercial, so only the observed
// behavior and constants are used here.
const DEFAULT_CODE_CONTEXT_MAX_TOKENS = 6400;
const MERGE_GAP_LINES = 2;
const EXPAND_MIN_LINES = 6;
const EXPAND_PAD_LINES = 3;
const PER_FILE_SEGMENT_CAP = 3;
const CHARS_PER_TOKEN = 4;

function integerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function normalizeRange(range) {
  if (Array.isArray(range) && range.length >= 2) {
    const start = integerOrNull(range[0]);
    const end = integerOrNull(range[1]);
    if (start === null || end === null || start < 1 || end < start) return null;
    return { start, end };
  }

  if (!range || typeof range !== "object") return null;
  const start = integerOrNull(range.start ?? range.startLine ?? range.start_line);
  const end = integerOrNull(range.end ?? range.endLine ?? range.end_line);
  if (start === null || end === null || start < 1 || end < start) return null;
  return { start, end };
}

function normalizeRanges(ranges) {
  if (!Array.isArray(ranges)) return [];
  return ranges.map(normalizeRange).filter(Boolean);
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    // A gap of N lines means the next start is at most previous.end + N + 1.
    if (previous && range.start <= previous.end + MERGE_GAP_LINES + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function clampRanges(ranges, lineCount) {
  if (lineCount <= 0) return [];
  return ranges
    .map((range) => ({
      start: Math.max(1, Math.min(lineCount, range.start)),
      end: Math.max(1, Math.min(lineCount, range.end)),
    }))
    .filter((range) => range.start <= range.end);
}

function curateRanges(ranges, lineCount) {
  const merged = mergeRanges(clampRanges(ranges, lineCount));
  const expanded = merged.map((range) => {
    const length = range.end - range.start + 1;
    if (length >= EXPAND_MIN_LINES) return range;
    return {
      start: Math.max(1, range.start - EXPAND_PAD_LINES),
      end: Math.min(lineCount, range.end + EXPAND_PAD_LINES),
    };
  });

  // Expansion can make two originally separate short ranges overlap. Merge
  // them before applying the per-file cap so the output never repeats lines.
  return mergeRanges(expanded).slice(0, PER_FILE_SEGMENT_CAP);
}

function splitLinesWithEndings(content) {
  if (!content) return [];
  const lines = [];
  let offset = 0;
  while (offset < content.length) {
    let cursor = offset;
    while (cursor < content.length && content[cursor] !== "\n" && content[cursor] !== "\r") {
      cursor += 1;
    }
    if (cursor >= content.length) {
      lines.push(content.slice(offset));
      break;
    }
    if (content[cursor] === "\r" && content[cursor + 1] === "\n") {
      cursor += 2;
    } else {
      cursor += 1;
    }
    lines.push(content.slice(offset, cursor));
    offset = cursor;
  }
  return lines;
}

function contentForRange(lines, start, end) {
  return lines.slice(start - 1, end).join("");
}

function fitContentToChars(lines, start, end, maxChars) {
  if (maxChars <= 0) return null;
  let content = "";
  let lastLine = start - 1;
  for (let line = start; line <= end; line += 1) {
    const next = lines[line - 1] || "";
    if (content.length + next.length > maxChars) break;
    content += next;
    lastLine = line;
  }
  if (lastLine < start) return null;
  return {
    content,
    end: lastLine,
    complete: lastLine === end,
  };
}

function readFileLines(filePath) {
  try {
    return splitLinesWithEndings(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveInputFiles(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.files)) return input.files;
  return [];
}

function normalizeBudget(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return DEFAULT_CODE_CONTEXT_MAX_TOKENS;
  return number;
}

/**
 * Build the bounded, line-preserving code context for search results.
 *
 * The result deliberately keeps metadata for segments whose body did not fit
 * the budget or could not be read. That lets callers retain the engine's
 * location signal without turning a file read failure into a search failure.
 */
function buildCodeContext(input, options = {}) {
  const files = resolveInputFiles(input);
  const budgetTokens = normalizeBudget(options.budgetTokens ?? options.maxTokens);
  const projectRoot = typeof options.projectRoot === "string" && options.projectRoot
    ? options.projectRoot
    : process.cwd();

  const grouped = new Map();
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const rawPath = item.path || item.filePath;
    if (typeof rawPath !== "string" || rawPath.trim() === "") continue;
    const ranges = normalizeRanges(item.ranges);
    if (ranges.length === 0) continue;
    const key = rawPath;
    let group = grouped.get(key);
    if (!group) {
      group = { path: rawPath, ranges: [] };
      grouped.set(key, group);
    }
    group.ranges.push(...ranges);
  }

  const sections = [];
  for (const group of grouped.values()) {
    const absolutePath = path.isAbsolute(group.path)
      ? group.path
      : path.resolve(projectRoot, group.path);
    const lines = readFileLines(absolutePath);
    if (!lines) {
      for (const range of mergeRanges(group.ranges).slice(0, PER_FILE_SEGMENT_CAP)) {
        sections.push({ path: group.path, ...range, lines: null });
      }
      continue;
    }

    const curated = curateRanges(group.ranges, lines.length);
    for (const range of curated) {
      sections.push({ path: group.path, ...range, lines });
    }
  }

  if (sections.length === 0) return null;

  const output = [];
  const maxChars = budgetTokens * CHARS_PER_TOKEN;
  let usedChars = 0;
  let budgetExhausted = false;
  let bodySeen = false;

  for (const section of sections) {
    const metadata = {
      path: section.path,
      startLine: section.start,
      endLine: section.end,
    };
    if (!section.lines || section.lines.length === 0) {
      output.push(metadata);
      continue;
    }

    if (budgetExhausted) {
      output.push(metadata);
      continue;
    }

    const remainingChars = maxChars - usedChars;
    const fullContent = contentForRange(section.lines, section.start, section.end);
    if (!bodySeen) {
      // The first readable segment is always attempted. If it is larger than
      // the budget, keep a complete prefix of lines and adjust its end line so
      // used-tokens remains bounded and the CDATA still matches its range.
      const fitted = fitContentToChars(
        section.lines,
        section.start,
        section.end,
        remainingChars,
      );
      bodySeen = true;
      if (!fitted) {
        output.push(metadata);
        budgetExhausted = true;
        continue;
      }
      output.push({
        ...metadata,
        endLine: fitted.end,
        content: fitted.content,
      });
      usedChars += fitted.content.length;
      if (!fitted.complete) budgetExhausted = true;
      continue;
    }

    if (fullContent.length <= remainingChars) {
      output.push({ ...metadata, content: fullContent });
      usedChars += fullContent.length;
    } else {
      output.push(metadata);
      budgetExhausted = true;
    }
  }

  return {
    budgetTokens,
    usedTokens: Math.ceil(usedChars / CHARS_PER_TOKEN),
    files: output,
  };
}

// This reproduces the observed intent of BCE's relatedSymbolHints
// (relate.go:359-428) -- surface grep-able leads for identifiers that show
// up in the curated snippets but are not themselves declared there -- using
// only regex extraction and `rg` lookups. It does not read or copy BCE
// source.
const RELATED_SYMBOLS_MIN_IDENTIFIER_LENGTH = 4;
const RELATED_SYMBOLS_MAX_RESULTS = 8;
const RELATED_SYMBOLS_MAX_FANOUT_FILES = 15;
const RELATED_SYMBOLS_RG_TIMEOUT_MS = 1200;
const RELATED_SYMBOLS_DECLARATION_KEYWORDS = ["func", "function", "class", "type", "interface", "struct", "def"];
const RELATED_SYMBOLS_RG_GLOBS = [
  "!node_modules/**",
  "!.git/**",
  "!dist/**",
  "!build/**",
  "!coverage/**",
  "!vendor/**",
];

const DECLARATION_KEYWORD_SET = new Set(RELATED_SYMBOLS_DECLARATION_KEYWORDS);
const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g;
const DECLARATION_RE = new RegExp(`\\b(${RELATED_SYMBOLS_DECLARATION_KEYWORDS.join("|")})\\s+([A-Za-z_][A-Za-z0-9_]*)`, "g");
const DECLARATION_LINE_RE = new RegExp(`\\b(${RELATED_SYMBOLS_DECLARATION_KEYWORDS.join("|")})\\s+([A-Za-z_][A-Za-z0-9_]*)\\b`);

let cachedRelatedSymbolsRgPath = null;

function resolveRelatedSymbolsRgPath() {
  if (cachedRelatedSymbolsRgPath !== null) return cachedRelatedSymbolsRgPath;
  try {
    const rootDir = path.resolve(__dirname, "..", "..");
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const ripgrep = require(path.join(rootDir, "vendor/yce-engine/node_modules/@vscode/ripgrep"));
    cachedRelatedSymbolsRgPath = ripgrep.rgPath || "rg";
  } catch {
    cachedRelatedSymbolsRgPath = "rg";
  }
  return cachedRelatedSymbolsRgPath;
}

function escapeRegExpLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan the already-curated snippet bodies for candidate identifiers: tokens
 * of at least 4 characters that are not themselves declared (via one of the
 * BCE-observed declaration keywords) inside the shown snippets. Candidates
 * are ranked by how often they are referenced across the snippets.
 */
function extractCandidateSymbols(codeContext) {
  const files = codeContext && Array.isArray(codeContext.files) ? codeContext.files : [];
  const defined = new Set();
  const counts = new Map();
  const order = [];

  for (const file of files) {
    if (!file || typeof file.content !== "string" || file.content === "") continue;
    const content = file.content;

    DECLARATION_RE.lastIndex = 0;
    let declMatch;
    while ((declMatch = DECLARATION_RE.exec(content))) {
      defined.add(declMatch[2]);
    }

    IDENTIFIER_RE.lastIndex = 0;
    let idMatch;
    while ((idMatch = IDENTIFIER_RE.exec(content))) {
      const token = idMatch[0];
      if (DECLARATION_KEYWORD_SET.has(token)) continue;
      if (!counts.has(token)) {
        counts.set(token, 0);
        order.push(token);
      }
      counts.set(token, counts.get(token) + 1);
    }
  }

  return order
    .filter((token) => !defined.has(token))
    .map((name) => ({ name, count: counts.get(name) }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Resolve declaration sites for a bounded set of candidate symbol names with
 * a single `rg` invocation (one process spawn regardless of candidate
 * count), matching the probe-grep spawn/timeout/ignore conventions used by
 * localFastSearch.js. Symbols declared in more than
 * RELATED_SYMBOLS_MAX_FANOUT_FILES files are treated as too generic and
 * dropped.
 */
function findSymbolDeclarations(candidateNames, options = {}) {
  const result = new Map();
  if (!Array.isArray(candidateNames) || candidateNames.length === 0) return result;

  const projectRoot = typeof options.projectRoot === "string" && options.projectRoot
    ? options.projectRoot
    : process.cwd();
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : RELATED_SYMBOLS_RG_TIMEOUT_MS;

  const namesPattern = candidateNames.map(escapeRegExpLiteral).join("|");
  const pattern = `\\b(${RELATED_SYMBOLS_DECLARATION_KEYWORDS.join("|")})\\s+(${namesPattern})\\b`;
  const args = [
    "--no-heading",
    "-n",
    "--max-count",
    "20",
    ...RELATED_SYMBOLS_RG_GLOBS.flatMap((glob) => ["--glob", glob]),
    pattern,
    projectRoot,
  ];

  let spawnResult;
  try {
    spawnResult = spawnSync(resolveRelatedSymbolsRgPath(), args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
    });
  } catch {
    return result;
  }
  if (!spawnResult || !spawnResult.stdout) return result;

  const candidateSet = new Set(candidateNames);
  const fanoutFiles = new Map();
  const firstSeen = new Map();

  for (const rawLine of spawnResult.stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const lineMatch = rawLine.match(/^(.+?):(\d+):(.*)$/);
    if (!lineMatch) continue;
    const [, filePath, lineNoText, content] = lineMatch;
    const declMatch = content.match(DECLARATION_LINE_RE);
    if (!declMatch) continue;
    const kind = declMatch[1];
    const name = declMatch[2];
    if (!candidateSet.has(name)) continue;

    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    const relPath = path.relative(projectRoot, absolutePath).replace(/\\/g, "/") || filePath;

    let files = fanoutFiles.get(name);
    if (!files) {
      files = new Set();
      fanoutFiles.set(name, files);
    }
    files.add(relPath);

    if (!firstSeen.has(name)) {
      firstSeen.set(name, { path: relPath, line: Number(lineNoText), kind });
    }
  }

  for (const name of candidateNames) {
    const files = fanoutFiles.get(name);
    if (!files || files.size === 0) continue;
    if (files.size > RELATED_SYMBOLS_MAX_FANOUT_FILES) continue;
    const first = firstSeen.get(name);
    if (first) result.set(name, first);
  }

  return result;
}

/**
 * Build the `<related-symbols>` payload for a code-context result: grep
 * leads for referenced-but-not-shown identifiers, capped at
 * RELATED_SYMBOLS_MAX_RESULTS entries. Returns null when there is nothing to
 * report (no snippet bodies, no surviving candidates, or no declaration
 * found for any of them).
 */
function buildRelatedSymbols(codeContext, options = {}) {
  const maxResults = Number.isInteger(options.maxResults) && options.maxResults > 0
    ? options.maxResults
    : RELATED_SYMBOLS_MAX_RESULTS;

  const candidates = extractCandidateSymbols(codeContext).slice(0, maxResults);
  if (candidates.length === 0) return null;

  const declarations = findSymbolDeclarations(candidates.map((candidate) => candidate.name), {
    projectRoot: options.projectRoot,
    timeoutMs: options.timeoutMs,
  });

  const symbols = [];
  for (const candidate of candidates) {
    const declaration = declarations.get(candidate.name);
    if (!declaration) continue;
    symbols.push({
      name: candidate.name,
      path: declaration.path,
      line: declaration.line,
      kind: declaration.kind,
    });
  }

  if (symbols.length === 0) return null;
  return { symbols };
}

module.exports = {
  CHARS_PER_TOKEN,
  DEFAULT_CODE_CONTEXT_MAX_TOKENS,
  EXPAND_MIN_LINES,
  EXPAND_PAD_LINES,
  MERGE_GAP_LINES,
  PER_FILE_SEGMENT_CAP,
  RELATED_SYMBOLS_MAX_FANOUT_FILES,
  RELATED_SYMBOLS_MAX_RESULTS,
  RELATED_SYMBOLS_MIN_IDENTIFIER_LENGTH,
  buildCodeContext,
  buildRelatedSymbols,
  curateRanges,
  extractCandidateSymbols,
  findSymbolDeclarations,
  mergeRanges,
  normalizeRanges,
};
