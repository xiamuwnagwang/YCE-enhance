const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let cachedRgPath = null;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const RRF_K = 60;

const DEFAULT_SKIP_DIRS = new Set([
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

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".config",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "code",
  "do",
  "does",
  "file",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "here",
  "how",
  "in",
  "is",
  "it",
  "like",
  "logic",
  "new",
  "of",
  "on",
  "or",
  "return",
  "set",
  "that",
  "the",
  "this",
  "to",
  "use",
  "used",
  "using",
  "what",
  "where",
  "which",
  "with",
  "you",
  "your",
  "代码",
  "当前",
  "定位",
  "逻辑",
  "哪里",
  "如何",
  "实现",
  "文件",
  "检索",
  "能力",
  "现在",
  "修复",
  "怎么",
  "在哪里",
]);

const SOURCE_PATH_PATTERNS = [
  "/app/",
  "/cmd/",
  "/components/",
  "/core/",
  "/internal/",
  "/lib/",
  "/pages/",
  "/pkg/",
  "/routes/",
  "/scripts/",
  "/server/",
  "/services/",
  "/src/",
  "/ycemcp-relay-main/",
];

const NOISE_PATH_PATTERNS = [
  "/__tests__/",
  "/examples/",
  "/fixtures/",
  "/i18n/",
  "/locales/",
  "/mock/",
  "/mocks/",
  "/test/",
  "/tests/",
  "/versions/",
];

const CONFIG_FILES = new Set([
  "cargo.toml",
  "composer.json",
  "go.mod",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
]);

function stem(word) {
  if (!word || word.length < 3) return word;
  return word
    .replace(/^(.+)(ies)$/, "$1y")
    .replace(/^(.+)([^aeiou])(es)$/, "$1$2")
    .replace(/^(.+)([^aeiou])(s)$/, "$1$2")
    .replace(/^(.+)(ing|edly|ally|ation|tion|ment|ness|ful|less|able|ible|ive|ity|ly|ed)$/, "$1");
}

function splitCamelCase(text) {
  return String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function tokenize(text, options = {}) {
  const { minLen = 2 } = options;
  const raw = splitCamelCase(text)
    .toLowerCase()
    .replace(/[^\w\s\-./@$:\u4e00-\u9fa5]/g, " ")
    .split(/[\s\-./\\@$:]+/)
    .filter(Boolean);

  const out = [];
  for (const token of raw) {
    if (/^[\u4e00-\u9fa5]+$/.test(token)) {
      for (let index = 0; index < token.length - 1; index += 1) {
        const pair = token.slice(index, index + 2);
        if (!STOP_WORDS.has(pair)) out.push(pair);
      }
      if (token.length >= 2 && !STOP_WORDS.has(token)) out.push(token);
      continue;
    }
    if (token.length < minLen || STOP_WORDS.has(token)) continue;
    out.push(stem(token));
  }
  return [...new Set(out)];
}

function extractQueryAnchors(query) {
  const anchors = [];
  const text = String(query || "");
  const matches = text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}|[A-Za-z0-9_.:/-]{4,}/g) || [];
  for (const item of matches) {
    const normalized = item.toLowerCase().replace(/^[-_.$/:]+|[-_.$/:]+$/g, "");
    if (!normalized || STOP_WORDS.has(normalized)) continue;
    anchors.push(normalized);
  }
  return [...new Set(anchors)];
}

function buildQueryTerms(query) {
  return [...new Set([...tokenize(query, { minLen: 2 }), ...extractQueryAnchors(query)])];
}

function specificQueryTerms(queryTerms) {
  return queryTerms.filter((term) => (
    term.length >= 8 ||
    /\d/.test(term) ||
    /[_./:-]/.test(term)
  ));
}

function tokenizePath(pathText) {
  return tokenize(String(pathText || "").replace(/[\\/]/g, " "), { minLen: 2 });
}

function isTextFile(filePath) {
  const base = path.basename(filePath);
  if (base === ".env") return false;
  const ext = path.extname(base).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return /(^|\.)(env\.example|gitignore|dockerignore|npmrc|yarnrc|prettierrc|eslintrc|babelrc)$/i.test(base);
}

function shouldSkipEntry(entryName) {
  if (entryName === ".env") return true;
  if (DEFAULT_SKIP_DIRS.has(entryName)) return true;
  if (entryName.startsWith(".") && ![".env.example", ".github", ".gitignore"].includes(entryName)) return true;
  return false;
}

function safeRead(filePath, maxBytes = 48 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 3 * 1024 * 1024) return "";
    const fd = fs.openSync(filePath, "r");
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function collectTopDirs(projectRoot) {
  const dirs = [];
  try {
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (shouldSkipEntry(entry.name)) continue;
      if (entry.isDirectory()) dirs.push(entry.name);
    }
  } catch {}
  return dirs;
}

function collectFiles(projectRoot, options = {}) {
  const { maxDepth = 8, maxFiles = 8000 } = options;
  const files = [];

  function walk(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (shouldSkipEntry(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && isTextFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  walk(projectRoot, 0);
  return files;
}

function extractMetadata(projectRoot, topDir) {
  const dirPath = path.join(projectRoot, topDir);
  const chunks = [];
  for (const name of CONFIG_FILES) {
    const filePath = path.join(dirPath, name);
    if (!fs.existsSync(filePath)) continue;
    const content = safeRead(filePath, 12 * 1024);
    if (content) chunks.push(content);
  }
  return chunks.join("\n");
}

function extractHeaders(filePath) {
  const content = safeRead(filePath, 3000);
  if (!content) return "";
  const headers = [];
  const mdHeaders = content.match(/^#{1,6}\s+.+$/gm) || [];
  headers.push(...mdHeaders.map((line) => line.replace(/^#{1,6}\s+/, "")));
  for (const line of content.split(/\r?\n/).slice(0, 14)) {
    const match = line.match(/^\s*(?:(?:\/\/|#|;|\*)\s*)(.+)$/);
    if (match) headers.push(match[1]);
    const symbol = line.match(/\b(function|class|interface|type|const|async function|func)\s+([A-Za-z0-9_$]+)/);
    if (symbol) headers.push(symbol[2]);
  }
  return headers.join(" ");
}

function buildProfiles(projectRoot, files) {
  const profiles = {};
  const topDirs = collectTopDirs(projectRoot);
  for (const dir of topDirs) {
    profiles[dir] = {
      dir,
      metadata: extractMetadata(projectRoot, dir),
      headers: [],
      filePaths: [],
      pathTokensText: "",
      fileCount: 0,
    };
  }

  for (const filePath of files) {
    const rel = path.relative(projectRoot, filePath).replace(/\\/g, "/");
    const first = rel.split("/")[0] || ".";
    if (!profiles[first]) {
      profiles[first] = {
        dir: first,
        metadata: "",
        headers: [],
        filePaths: [],
        pathTokensText: "",
        fileCount: 0,
      };
    }
    profiles[first].filePaths.push(rel);
    profiles[first].fileCount += 1;
    if (/\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(rel)) {
      const headers = extractHeaders(filePath);
      if (headers) profiles[first].headers.push(headers);
    }
  }

  for (const profile of Object.values(profiles)) {
    profile.pathTokensText = profile.filePaths.join(" ");
    profile.headersText = profile.headers.join(" ");
    profile.tokens = {
      dir: tokenize(profile.dir),
      path: tokenizePath(profile.pathTokensText),
      metadata: tokenize(profile.metadata),
      headers: tokenize(profile.headersText),
    };
  }

  return profiles;
}

function computeIdf(docs) {
  const idf = {};
  const counts = {};
  const n = docs.length || 1;
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      counts[term] = (counts[term] || 0) + 1;
    }
  }
  for (const [term, count] of Object.entries(counts)) {
    idf[term] = Math.log((n - count + 0.5) / (count + 0.5) + 1);
  }
  return idf;
}

function bm25(queryTerms, fieldTerms, avgLen, idf) {
  if (!fieldTerms.length) return 0;
  const tf = {};
  for (const term of fieldTerms) tf[term] = (tf[term] || 0) + 1;
  let score = 0;
  for (const term of queryTerms) {
    const f = tf[term] || 0;
    if (!f) continue;
    const numerator = f * (BM25_K1 + 1);
    const denominator = f + BM25_K1 * (1 - BM25_B + BM25_B * (fieldTerms.length / Math.max(1, avgLen)));
    score += (idf[term] || Math.log(2)) * (numerator / denominator);
  }
  return score;
}

function rrf(rankings) {
  const scores = {};
  for (const ranking of rankings) {
    for (let index = 0; index < ranking.length; index += 1) {
      const item = ranking[index];
      scores[item.dir] = (scores[item.dir] || 0) + 1 / (RRF_K + index + 1);
    }
  }
  return Object.entries(scores)
    .map(([dir, score]) => ({ dir, score }))
    .sort((a, b) => b.score - a.score);
}

function resolveRgPath() {
  if (cachedRgPath !== null) return cachedRgPath;
  try {
    const ripgrep = require(path.join(ROOT_DIR, "vendor/yce-engine/node_modules/@vscode/ripgrep"));
    cachedRgPath = ripgrep.rgPath || "rg";
  } catch {
    cachedRgPath = "rg";
  }
  return cachedRgPath;
}

const ROOT_DIR = path.resolve(__dirname, "..", "..");

function probeGrep(projectRoot, queryTerms) {
  const hits = new Map();
  const terms = queryTerms.slice(0, 8);
  if (terms.length === 0) return hits;
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const args = [
    "--no-heading",
    "-n",
    "--max-count",
    "30",
    "--ignore-case",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!.git/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!build/**",
    "--glob",
    "!coverage/**",
    "--glob",
    "!vendor/**",
    pattern,
    projectRoot,
  ];
  try {
    const result = spawnSync(resolveRgPath(), args, {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
    });
    if (!result.stdout) return hits;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(/^(.+?):(\d+):/);
      if (!match) continue;
      const realPath = path.resolve(match[1]);
      const rel = path.relative(projectRoot, realPath).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..")) continue;
      const item = hits.get(rel) || { count: 0, lines: [] };
      item.count += 1;
      if (item.lines.length < 6) item.lines.push(Number(match[2]));
      hits.set(rel, item);
    }
  } catch {}
  return hits;
}

function scoreDirectories(queryTerms, profiles, probeHits) {
  const profileList = Object.values(profiles);
  const idf = computeIdf(profileList.map((profile) => [
    ...profile.tokens.dir,
    ...profile.tokens.path,
    ...profile.tokens.metadata,
    ...profile.tokens.headers,
  ]));
  const fields = ["dir", "path", "metadata", "headers"];
  const weights = { dir: 1, path: 4, metadata: 3, headers: 2 };
  const avg = {};
  for (const field of fields) {
    avg[field] = profileList.reduce((sum, profile) => sum + profile.tokens[field].length, 0) / Math.max(1, profileList.length);
  }

  const bm25Ranking = profileList
    .map((profile) => {
      let score = 0;
      for (const field of fields) {
        score += weights[field] * bm25(queryTerms, profile.tokens[field], avg[field], idf);
      }
      return { dir: profile.dir, score };
    })
    .sort((a, b) => b.score - a.score);

  const probeDirCounts = {};
  for (const [rel, hit] of probeHits.entries()) {
    const dir = rel.split("/")[0] || ".";
    probeDirCounts[dir] = (probeDirCounts[dir] || 0) + hit.count;
  }
  const probeRanking = profileList
    .map((profile) => ({
      dir: profile.dir,
      score: Math.log(1 + (probeDirCounts[profile.dir] || 0)) / Math.sqrt(1 + profile.fileCount),
    }))
    .sort((a, b) => b.score - a.score);

  const fileAggRanking = profileList
    .map((profile) => {
      let score = 0;
      for (const rel of profile.filePaths.slice(0, 300)) {
        const pathTokens = tokenizePath(rel);
        for (const term of queryTerms) {
          if (pathTokens.includes(term)) score += 2;
          else if (rel.toLowerCase().includes(term)) score += 1;
        }
      }
      return { dir: profile.dir, score };
    })
    .sort((a, b) => b.score - a.score);

  return {
    fused: rrf([bm25Ranking, probeRanking, fileAggRanking]),
    signals: {
      bm25f: bm25Ranking.slice(0, 6).map((item) => `${item.dir}:${item.score.toFixed(2)}`),
      probe: probeRanking.slice(0, 6).map((item) => `${item.dir}:${item.score.toFixed(2)}`),
      fileAgg: fileAggRanking.slice(0, 6).map((item) => `${item.dir}:${item.score.toFixed(2)}`),
    },
  };
}

function lineRangesFromLines(lines, around = 2) {
  if (!lines.length) return [];
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges = [];
  for (const line of sorted) {
    const start = Math.max(1, line - around);
    const end = line + around;
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end + 3) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
    if (ranges.length >= 3) break;
  }
  return ranges;
}

function findContentLines(content, queryTerms) {
  const lines = content.split(/\r?\n/);
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase();
    if (queryTerms.some((term) => lower.includes(term))) {
      hits.push(index + 1);
    }
    if (hits.length >= 8) break;
  }
  return { lines, hits };
}

function rangesToText(ranges) {
  return ranges.map((range) => (range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`));
}

function scoreFile({ projectRoot, filePath, queryTerms, requiredTerms, hotDirRank, probeHit }) {
  const rel = path.relative(projectRoot, filePath).replace(/\\/g, "/");
  const lowerRel = rel.toLowerCase();
  const fileName = path.basename(rel, path.extname(rel)).toLowerCase();
  const pathTokens = tokenizePath(rel);
  let score = 0;
  let hasFileSignal = false;
  let hasRequiredSignal = requiredTerms.length === 0;

  if (probeHit) {
    score += 10 + probeHit.count * 2;
    hasFileSignal = true;
  }

  for (const term of queryTerms) {
    if (fileName === term) {
      score += 16;
      hasFileSignal = true;
      if (requiredTerms.includes(term)) hasRequiredSignal = true;
    } else if (fileName.includes(term)) {
      score += 10;
      hasFileSignal = true;
      if (requiredTerms.includes(term)) hasRequiredSignal = true;
    }
    if (pathTokens.includes(term)) {
      score += 8;
      hasFileSignal = true;
      if (requiredTerms.includes(term)) hasRequiredSignal = true;
    } else if (lowerRel.includes(term)) {
      score += 4;
      hasFileSignal = true;
      if (requiredTerms.includes(term)) hasRequiredSignal = true;
    }
  }

  if (!hasFileSignal) return 0;
  if (!hasRequiredSignal) return 0;
  if (hotDirRank >= 0) score += Math.max(0, 10 - hotDirRank);

  const normalized = `/${lowerRel}`;
  if (SOURCE_PATH_PATTERNS.some((item) => normalized.includes(item))) score *= 1.35;
  if (NOISE_PATH_PATTERNS.some((item) => normalized.includes(item))) score *= 0.35;
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.tsbuildinfo)$/i.test(rel)) score *= 0.15;
  if (/(^|\/)(readme|notice|license)(\.|$)/i.test(rel)) score *= 0.45;
  if (/\.env\.example$/i.test(rel)) score *= 0.6;

  return score;
}

function applyContentScore({ filePath, baseScore, queryTerms, requiredTerms, probeHit }) {
  if (baseScore <= 0 && !probeHit) return { score: baseScore, ranges: [] };
  const content = safeRead(filePath, 256 * 1024);
  if (!content) return { score: baseScore, ranges: probeHit ? lineRangesFromLines(probeHit.lines) : [] };

  const found = findContentLines(content, queryTerms);
  let score = baseScore + found.hits.length * 2;
  const lower = content.toLowerCase();
  let hasRequiredSignal = requiredTerms.length === 0 || baseScore > 0;
  for (const term of queryTerms) {
    if (term.length >= 5 && lower.includes(term)) {
      score += term.length >= 10 ? 18 : 7;
      if (requiredTerms.includes(term)) hasRequiredSignal = true;
    }
    const declarationPattern = new RegExp(`\\\\b(function|class|interface|type|const|let|var|func)\\\\s+${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\\b`, "i");
    if (declarationPattern.test(content)) {
      score += 30;
      if (requiredTerms.includes(term)) hasRequiredSignal = true;
    }
  }

  if (!hasRequiredSignal) return { score: 0, ranges: [] };

  const ranges = probeHit && probeHit.lines.length
    ? lineRangesFromLines([...probeHit.lines, ...found.hits])
    : lineRangesFromLines(found.hits);
  return { score, ranges };
}

function runLocalFastSearch({ query, cwd, maxResults = 10 }) {
  const queryTerms = buildQueryTerms(query);
  const requiredTerms = specificQueryTerms(queryTerms);
  if (!queryTerms.length || !cwd || !fs.existsSync(cwd)) {
    return {
      resultPresent: false,
      emptyResult: true,
      output: "No relevant files found by local fast fallback.",
      diagnostics: [],
    };
  }

  const startedAt = Date.now();
  const files = collectFiles(cwd);
  const profiles = buildProfiles(cwd, files);
  const probeHits = probeGrep(cwd, queryTerms);
  const dirScores = scoreDirectories(queryTerms, profiles, probeHits);
  const hotDirs = dirScores.fused.slice(0, 8).map((item) => item.dir);
  const hotDirIndex = new Map(hotDirs.map((dir, index) => [dir, index]));

  const scored = [];
  for (const filePath of files) {
    const rel = path.relative(cwd, filePath).replace(/\\/g, "/");
    const top = rel.split("/")[0] || ".";
    const probeHit = probeHits.get(rel);
    const baseScore = scoreFile({
      projectRoot: cwd,
      filePath,
      queryTerms,
      requiredTerms,
      hotDirRank: hotDirIndex.has(top) ? hotDirIndex.get(top) : -1,
      probeHit,
    });
    const { score, ranges } = applyContentScore({ filePath, baseScore, queryTerms, requiredTerms, probeHit });
    if (score <= 0) continue;
    scored.push({ filePath, rel, score, ranges });
  }

  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const picked = scored.slice(0, Math.max(1, maxResults || 10));

  if (picked.length === 0) {
    return {
      resultPresent: false,
      emptyResult: true,
      output: "No relevant files found by local fast fallback.",
      diagnostics: [
        `local fast fallback tokens: ${queryTerms.join(", ")}`,
        `hot dirs: ${hotDirs.join(", ") || "(none)"}`,
      ],
    };
  }

  const elapsed = Date.now() - startedAt;
  const output = [
    `Found ${picked.length} relevant files by local fast fallback.`,
    "",
    ...picked.map((item, index) => {
      const rangeText = item.ranges.length ? ` (${rangesToText(item.ranges).join(", ")})` : "";
      return `  [${index + 1}/${picked.length}] ${item.filePath}${rangeText}`;
    }),
    "",
    `local fast fallback tokens: ${queryTerms.join(", ")}`,
    `hot dirs: ${hotDirs.join(", ") || "(none)"}`,
    `signals bm25f: ${dirScores.signals.bm25f.join(", ")}`,
    `signals probe: ${dirScores.signals.probe.join(", ")}`,
    `signals fileAgg: ${dirScores.signals.fileAgg.join(", ")}`,
    `[local-config] files=${files.length}, elapsed_ms=${elapsed}`,
  ].join("\n");

  return {
    resultPresent: true,
    emptyResult: false,
    output,
    diagnostics: ["local fast fallback search"],
  };
}

module.exports = {
  runLocalFastSearch,
  tokenize,
};
