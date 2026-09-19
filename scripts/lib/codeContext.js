const fs = require("fs");
const path = require("path");

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

module.exports = {
  CHARS_PER_TOKEN,
  DEFAULT_CODE_CONTEXT_MAX_TOKENS,
  EXPAND_MIN_LINES,
  EXPAND_PAD_LINES,
  MERGE_GAP_LINES,
  PER_FILE_SEGMENT_CAP,
  buildCodeContext,
  curateRanges,
  mergeRanges,
  normalizeRanges,
};
