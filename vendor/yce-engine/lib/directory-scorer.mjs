/**
 * Directory Scorer - BM25F + Probe + RRF
 *
 * Based on IR research:
 * - BM25F for multi-field structured documents (Robertson & Zaragoza)
 * - Probe grep signal with IDF weighting
 * - RRF fusion for combining multiple rankers (Cormack et al.)
 *
 * Directory Profile Fields:
 * - dir_name: Top-level directory name (weight: 1.0)
 * - path_tokens: All file paths under the directory (weight: 4.0) <- MAIN SIGNAL
 * - metadata: package.json, go.mod, Cargo.toml info (weight: 3.0)
 * - headers: First N lines / markdown headers (weight: 2.0)
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, resolve, relative, extname, basename, dirname } from "path";
import { spawnSync } from "child_process";
import { resolveRipgrepPath } from "./ripgrep.mjs";
import { createTokenizer, stem, PRERANK_PROFILE } from "./lexicon.cjs";

// ─── Constants ───────────────────────────────────────────────

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const RRF_K = 60;
const FILE_SCORE_MAX_BYTES = 1024 * 1024;
const FILE_PROBE_MAX_TERMS = 8;
const FILE_FALLBACK_CANDIDATES = 20;
const FILE_MIN_SIGNAL_SCORE = 0.01;
const FILE_RRF_WEIGHTS = [2, 1.5, 1];
const FILE_LOW_CONFIDENCE_SCORE = 0.03;
// Test files mention every query term without defining anything, so they crowd
// the head of the fused list — 22.5% of the top 10 across the local eval set.
// Only tests are demoted here. The directory-level NOISE_PATH_PATTERNS set is
// deliberately not reused: whether vendor/, examples/ or migrations/ are noise
// is repo-specific, and applying that set at file level measurably hurt (two
// queries whose answer was rank 1 fell to 18 and 24).
const FILE_TEST_PENALTY = 0.7;
const TEST_DIR_PATTERN = /(^|\/)(test|tests|__tests__|spec)\//;
const TEST_FILE_PATTERN = /(_test|\.test|\.spec)\.[^/]+$/;
const STRUCTURE_PATH_WEIGHT = 8;
const STRUCTURE_DECL_EXACT_WEIGHT = 6;
const STRUCTURE_DECL_PREFIX_WEIGHT = 3;

// Keep the declaration matcher deliberately broad.  This is a cheap
// structural hint, not an AST replacement; language-specific parsing would
// make the local pre-ranker both slower and harder to run in a skill install.
const DECLARATION_PATTERNS = [
  /^\s*(?:func|function|def|class|type|struct|interface|enum|trait|module|namespace|protocol|const|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*(?:CREATE|ALTER)\s+(?:TABLE|VIEW|FUNCTION|PROCEDURE|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][\w$]*)/gim,
  /^\s*(?:@[A-Za-z_$][\w$]*\s+)?(?:public|private|protected|static|final|async|virtual|override\s+)*[A-Za-z_$][\w$<>[\], ?]*\s+([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*\{/gm,
];

// `const|var` earns a declaration slot only when its right-hand side is a
// function: a name bound to a function defines behavior, `const limit = 42`
// names a value. The distinction is applied when the names are handed to the
// semantic screen and to grep, not inside DECLARATION_PATTERNS — structure
// scoring is calibrated on the broad extraction and measurably regresses when
// the local bindings are taken away from it.
const BOUND_NAME_PATTERN = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const FUNCTION_VALUED_BINDING_PATTERN =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)\n]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm;
const rgPath = resolveRipgrepPath();

// Field weights for BM25F (from research recommendations)
const FIELD_WEIGHTS = {
  dir_name: 1.0,
  path_tokens: 4.0,  // Main signal
  metadata: 3.0,
  headers: 2.0,
};

// Default exclude patterns
const DEFAULT_EXCLUDES = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".venv", "venv",
  "target", "out", ".cache", "__pycache__", "deps", "third_party",
  "logs", "data", ".next", ".nuxt", "bundle", "bundled", "fixtures",
]);

// Stopwords for tokenization
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "and", "but", "or", "nor", "so", "yet", "both", "either", "neither",
  "not", "only", "own", "same", "than", "too", "very", "just", "also",
  "this", "that", "these", "those", "here", "there", "all", "any",
  "some", "no", "none", "each", "every", "other", "another", "such",
  "get", "set", "use", "used", "using", "make", "made", "if", "then",
  "else", "return", "new", "like", "well", "where", "which", "who",
  "what", "when", "why", "how", "it", "its", "we", "you", "your",
]);

// ─── Tokenization ─────────────────────────────────────────────

/**
 * Tokenize text with stemming and stopword removal.
 *
 * The stemmer and the camelCase splitter live in lib/lexicon.cjs, shared with
 * the offline fallback searcher so the two layers cannot drift apart again.
 */
const tokenize = createTokenizer({ profile: PRERANK_PROFILE, stopWords: STOPWORDS });

/**
 * Tokenize file path (handles code paths better)
 */
function tokenizePath(pathStr) {
  if (!pathStr) return [];
  return pathStr
    .toLowerCase()
    .replace(/[\/\\]/g, " ")
    .replace(/[._-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2)
    .map(stem);
}

// ─── Directory Profile Builder ────────────────────────────────

/**
 * Extract metadata from common config files
 */
function extractMetadata(dirPath) {
  const metadata = [];

  // package.json
  const pkgPath = join(dirPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) metadata.push(pkg.name);
      if (pkg.description) metadata.push(...tokenize(pkg.description));
      if (pkg.keywords) metadata.push(...pkg.keywords.flatMap(k => tokenize(k)));
      if (pkg.dependencies) metadata.push(...Object.keys(pkg.dependencies).flatMap(k => tokenize(k)));
    } catch {}
  }

  // go.mod
  const goModPath = join(dirPath, "go.mod");
  if (existsSync(goModPath)) {
    try {
      const content = readFileSync(goModPath, "utf-8");
      const moduleMatch = content.match(/module\s+(\S+)/);
      if (moduleMatch) metadata.push(...tokenizePath(moduleMatch[1]));
    } catch {}
  }

  // Cargo.toml
  const cargoPath = join(dirPath, "Cargo.toml");
  if (existsSync(cargoPath)) {
    try {
      const content = readFileSync(cargoPath, "utf-8");
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      if (nameMatch) metadata.push(...tokenizePath(nameMatch[1]));
    } catch {}
  }

  // pyproject.toml
  const pyprojectPath = join(dirPath, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, "utf-8");
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      if (nameMatch) metadata.push(...tokenizePath(nameMatch[1]));
    } catch {}
  }

  return metadata.join(" ");
}

/**
 * Extract headers from a file (markdown headers, code comments, etc.)
 */
function extractFileHeaders(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8").slice(0, 2000); // First 2KB
    const headers = [];

    // Markdown headers
    const mdHeaders = content.match(/^#+\s+.+$/gm) || [];
    headers.push(...mdHeaders.map(h => h.replace(/^#+\s+/, "")));

    // Code comments (first 10 lines)
    const lines = content.split("\n").slice(0, 10);
    for (const line of lines) {
      const comment = line.match(/^\s*(?:(?:\/\/|#|;|\*)\s*)(.+)$/);
      if (comment) headers.push(comment[1]);
    }

    return headers.join(" ");
  } catch {
    return "";
  }
}

// ─── Profile Cache (process-level TTL) ───────────────────────
//
// MCP server is long-running: repeated search() calls for the same project
// would re-walk every directory each time (~200ms+ per large dir due to
// readFileSync for headers). This cache avoids that.
//
// Key:   projectRoot + "|" + dirName + "|" + sortedExcludes
// TTL:   120s (configurable via FC_PROFILE_CACHE_TTL env)
// Scope: process lifetime only, not persisted

const _profileCache = new Map();
const PROFILE_CACHE_TTL_MS = (parseInt(process.env.FC_PROFILE_CACHE_TTL, 10) || 120) * 1000;

/**
 * Invalidate all cached profiles for a project root.
 * Call this if you know files have changed (optional — TTL handles normal staleness).
 */
export function invalidateProfileCache(projectRoot) {
  for (const key of _profileCache.keys()) {
    if (key.startsWith(projectRoot + "|")) {
      _profileCache.delete(key);
    }
  }
}

/**
 * Build a profile for a top-level directory (with TTL cache)
 */
export function buildDirectoryProfile(projectRoot, dirName, excludePaths = [], maxDepth = 3) {
  // Cache lookup
  const cacheKey = `${projectRoot}|${dirName}|${[...excludePaths].sort().join(",")}`;
  const cached = _profileCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < PROFILE_CACHE_TTL_MS) {
    return cached.profile;
  }
  const dirPath = join(projectRoot, dirName);
  const profile = {
    dir_name: dirName,
    path_tokens: [],
    metadata: "",
    headers: [],
    file_count: 0,
    file_paths: [], // Store actual file paths for path spines
  };

  const excludeSet = new Set(excludePaths);

  function walk(currentPath, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;

        // Skip excluded and noise
        if (DEFAULT_EXCLUDES.has(name) || excludeSet.has(name)) continue;
        if (name.startsWith(".") && name !== ".github") continue;

        const fullPath = join(currentPath, name);
        const relPath = relative(projectRoot, fullPath);

        if (entry.isDirectory()) {
          profile.path_tokens.push(relPath);
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          profile.path_tokens.push(relPath);
          profile.file_paths.push(relPath);
          profile.file_count++;

          // Extract headers from relevant files
          const ext = extname(name);
          if ([".md", ".mdx", ".ts", ".tsx", ".js", ".jsx", ".py", ".go"].includes(ext)) {
            const headers = extractFileHeaders(fullPath);
            if (headers) profile.headers.push(headers);
          }
        }
      }
    } catch { /* ignore walk errors */ }
  }

  walk(dirPath, 1);

  // Extract metadata from config files
  profile.metadata = extractMetadata(dirPath);

  // Convert arrays to text
  profile.path_tokens_text = profile.path_tokens.join(" ");
  profile.headers_text = profile.headers.join(" ");

  // Store in cache
  _profileCache.set(cacheKey, { profile, cachedAt: Date.now() });

  return profile;
}

// ─── BM25/BM25F Implementation ────────────────────────────────

/**
 * Compute IDF for terms across documents
 */
function computeIDF(documents) {
  const docCount = documents.length;
  const termDocCount = {};
  const idf = {};

  for (const doc of documents) {
    const uniqueTerms = new Set(doc);
    for (const term of uniqueTerms) {
      termDocCount[term] = (termDocCount[term] || 0) + 1;
    }
  }

  for (const [term, count] of Object.entries(termDocCount)) {
    // Standard IDF formula
    idf[term] = Math.log((docCount - count + 0.5) / (count + 0.5) + 1);
  }

  return idf;
}

/**
 * BM25 score for a single field
 */
function bm25FieldScore(queryTerms, fieldTerms, avgLen, fieldLen, idf) {
  const termFreqs = {};
  fieldTerms.forEach(t => { termFreqs[t] = (termFreqs[t] || 0) + 1; });

  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreqs[term] || 0;
    if (tf === 0) continue;

    const termIDF = idf[term] || Math.log(2); // Default IDF for unseen terms
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (fieldLen / avgLen));
    score += termIDF * (numerator / denominator);
  }

  return score;
}

/**
 * BM25F score across all fields (uses pre-cached tokenized fields when available)
 */
function bm25fScore(queryTerms, profile, avgFieldLens, idf) {
  const tok = profile._tok;
  const fields = [
    { name: "dir_name", terms: tok ? tok.dir_name : tokenize(profile.dir_name || ""), weight: FIELD_WEIGHTS.dir_name },
    { name: "path_tokens", terms: tok ? tok.path_tokens : tokenize(profile.path_tokens_text || ""), weight: FIELD_WEIGHTS.path_tokens },
    { name: "metadata", terms: tok ? tok.metadata : tokenize(profile.metadata || ""), weight: FIELD_WEIGHTS.metadata },
    { name: "headers", terms: tok ? tok.headers : tokenize(profile.headers_text || ""), weight: FIELD_WEIGHTS.headers },
  ];

  let totalScore = 0;
  for (const field of fields) {
    const avgLen = avgFieldLens[field.name] || 50;
    const fieldLen = field.terms.length || 1;
    const fieldScore = bm25FieldScore(queryTerms, field.terms, avgLen, fieldLen, idf);
    totalScore += field.weight * fieldScore;
  }

  return totalScore;
}

// ─── Probe Grep Signal ────────────────────────────────────────

/**
 * Select probe terms from query (prioritize high IDF, but include diverse terms)
 */
function selectProbeTerms(queryTerms, idf, maxTerms = 6) {
  // Sort by IDF (descending) and select top terms
  const sorted = queryTerms
    .map(t => ({ term: t, idf: idf[t] || 0 }))
    .sort((a, b) => b.idf - a.idf);

  // Return unique terms (top-N by IDF)
  const unique = [...new Set(sorted.map(t => t.term))];
  return unique.slice(0, maxTerms);
}

/**
 * Execute probe grep to count matches per directory.
 * Uses a single rg call with regex alternation (term1|term2|...) instead of
 * N sequential calls — saves (N-1) process spawns (~2-5s).
 *
 * Scoring: each matching file contributes 1 hit to its directory.
 * RRF only cares about rank order, which is robust to this simplification.
 */
function probeGrep(projectRoot, topDirs, probeTerms, excludePaths = []) {
  if (probeTerms.length === 0) return {};

  const dirHits = {};
  const excludeSet = new Set([...excludePaths, ...DEFAULT_EXCLUDES]);

  for (const dir of topDirs) {
    dirHits[dir] = 0;
  }

  // Build single regex alternation: escape each term for regex safety
  const pattern = probeTerms
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  try {
    const result = spawnSync(rgPath, [
      "-l", // List matching files only
      "--hidden",
      "-g", `!{${[...excludeSet].join(",")}}`,
      // No extension filter - let ripgrep search all text files
      pattern,
      projectRoot,
    ], {
      encoding: "utf-8",
      timeout: 8000,  // Slightly longer for combined search
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
    });

    if (result.error) return dirHits;

    if (result.stdout) {
      const files = result.stdout.trim().split("\n").filter(Boolean);
      for (const file of files) {
        const relPath = relative(projectRoot, file);
        const topDir = relPath.split(/[\/\\]/)[0];
        if (dirHits.hasOwnProperty(topDir)) {
          dirHits[topDir]++;
        }
      }
    }
  } catch { /* rg not found or error - skip */ }

  return dirHits;
}

/**
 * Compute probe score with normalization
 */
function computeProbeScore(hits, fileCount) {
  if (hits === 0) return 0;
  // Normalize by log(hits) / sqrt(fileCount) to prevent large dirs from dominating
  return Math.log(1 + hits) / Math.sqrt(1 + fileCount);
}

// ─── RRF Fusion ────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion
 */
function rrfFusion(rankings, weights = null) {
  const finalScores = {};
  const w = weights || rankings.map(() => 1);

  for (let r = 0; r < rankings.length; r++) {
    const ranking = rankings[r];
    for (let pos = 0; pos < ranking.length; pos++) {
      const { dir } = ranking[pos];
      const rrfScore = w[r] / (RRF_K + pos + 1);
      finalScores[dir] = (finalScores[dir] || 0) + rrfScore;
    }
  }

  return Object.entries(finalScores)
    .map(([dir, score]) => ({ dir, score }))
    .sort((a, b) => b.score - a.score);
}

// ─── Adaptive TopK (Literature-backed) ───────────────────────────
//
// References:
// [1] Taguchi et al. (2025) "Adaptive-k" — max-gap on sorted scores
// [2] Xu et al. (2025) "CAR" — entropy-based cluster cutoff
// [3] CMU Selective Search — shard cutoff via distribution features
// [4] Kratzwald et al. (2018) — cumulative threshold for query-dependent k
//
// Three signals combined:
//   K_base:  N-proportional safety floor (handles degenerate cases)
//   K_knee:  Kneedle gap detection (query-sensitive, finds natural breakpoint)
//   H_norm:  Entropy scaling (flat distributions → expand K)
// Tail inclusion uses adaptive threshold based on score decay rate.

const K_MIN = 3;
const K_MAX = 10;
const ENTROPY_GAMMA = 0.5;    // Entropy scaling factor
const SOFTMAX_TEMP = 1.0;     // Temperature for softmax normalization
const TAIL_SCAN_WINDOW = 6;   // Max dirs to scan beyond cutoff

/**
 * Adaptive topK selection based on RRF score distribution.
 *
 * @param {Array<{dir: string, score: number}>} fused - RRF-fused sorted rankings
 * @param {number} userTopK - User-specified topK (default 4)
 * @param {number} N - Total number of top-level directories
 * @returns {string[]} Selected hotDirs
 */
function _adaptiveTopK(fused, userTopK, N) {
  if (fused.length <= K_MIN) return fused.map(r => r.dir);

  const scores = fused.map(r => r.score);

  // ── Signal 1: K_base (N-proportional safety floor) ──
  const kBase = Math.max(userTopK, Math.min(K_MAX, Math.ceil(N * 0.15)));

  // ── Signal 2: K_knee (Kneedle max-gap detection) ──
  // Find the position with the largest score drop (Taguchi Adaptive-k).
  // This is where the "relevance cliff" occurs.
  // Only search within [K_MIN-1, min(K_MAX, scores.length-1)] to stay bounded.
  let maxGap = 0;
  let kKnee = kBase;
  const searchEnd = Math.min(K_MAX, scores.length - 1);
  for (let i = K_MIN - 1; i < searchEnd; i++) {
    const gap = scores[i] - scores[i + 1];
    if (gap > maxGap) {
      maxGap = gap;
      kKnee = i + 1; // Include everything up to and including position i
    }
  }

  // ── Signal 3: Entropy scaling (distribution flatness) ──
  // Softmax-normalized entropy: H_norm ∈ [0, 1].
  // High H_norm (flat distribution) → relevance is dispersed → expand K.
  // Low H_norm (peaked distribution) → relevance is concentrated → keep K tight.
  const maxScore = scores[0];
  const expScores = scores.map(s => Math.exp((s - maxScore) / SOFTMAX_TEMP)); // shifted for numerical stability
  const expSum = expScores.reduce((a, b) => a + b, 0);
  const probs = expScores.map(e => e / expSum);
  const entropy = -probs.reduce((h, p) => h + (p > 0 ? p * Math.log(p) : 0), 0);
  const hNorm = scores.length > 1 ? entropy / Math.log(scores.length) : 0;

  // Entropy-adjusted K: scale kBase by distribution flatness
  const kEntropy = Math.ceil(kBase * (1 + ENTROPY_GAMMA * hNorm));

  // ── Combine: take the max of all signals, clamp to [K_MIN, K_MAX] ──
  const primaryK = Math.max(K_MIN, Math.min(K_MAX, Math.max(kBase, kKnee, kEntropy)));
  let hotDirs = fused.slice(0, primaryK).map(r => r.dir);

  // ── Adaptive tail inclusion ──
  // Instead of fixed 0.6 threshold, use score decay rate to determine tail cutoff.
  // If scores are still decaying slowly (flat tail), include more;
  // if there's a sharp drop, stop.
  if (fused.length > primaryK) {
    const cutoffScore = scores[primaryK - 1];
    // Adaptive threshold: based on the average decay rate in the head
    // If head decays slowly (flat), threshold is lenient; if steep, threshold is strict.
    const headDecayRate = primaryK > 1 ? (scores[0] - cutoffScore) / (primaryK - 1) : 0;
    // Threshold = cutoffScore minus one "average step" worth of decay
    // This is more lenient when the head is flat (small headDecayRate)
    const tailThreshold = Math.max(cutoffScore - headDecayRate, cutoffScore * 0.4);

    for (let i = primaryK; i < fused.length && i < primaryK + TAIL_SCAN_WINDOW; i++) {
      if (scores[i] >= tailThreshold) {
        hotDirs.push(fused[i].dir);
      } else {
        break; // Stop at first dir below threshold (scores are sorted)
      }
    }
  }

  return hotDirs;
}

// ─── Path Spine Extraction ──────────────────────────────────────

/**
 * Extract path spines from matched files.
 *
 * Previous approach: first-match iteration with topN break — caused files from
 * later-iterated directories to be missed even when relevant (e.g., prompt.go
 * in server/, shape.ts in packages/element/).
 *
 * New approach: score ALL candidate files, sort by relevance, take topN.
 * Includes path-quality signals:
 * - Source-code paths (src/, core/, lib/, internal/) get a bonus
 * - Noise paths (migrations/, test/, fixtures/) get a penalty
 * - Filename-level term matches get a bonus
 */
// Paths that indicate core source code (bonus)
const SOURCE_PATH_PATTERNS = ["/src/", "/core/", "/lib/", "/internal/", "/pkg/", "/cmd/"];
// Paths that indicate non-essential files (penalty)
const NOISE_PATH_PATTERNS = ["/migrations/", "/test/", "/__tests__/", "/fixtures/", "/examples/", "/vendor/", "/mock/", "/mocks/", "/i18n/", "/locales/", "/versions/"];

function extractPathSpines(profiles, queryTerms, keywords, topN = 30) {
  const allTerms = [...new Set([...queryTerms, ...keywords])];
  if (allTerms.length === 0) return [];

  // Score all candidate files across all directories
  const candidates = [];

  for (const [dir, profile] of Object.entries(profiles)) {
    for (const filePath of profile.file_paths || []) {
      const pathTokens = tokenizePath(filePath);
      const pathText = filePath.toLowerCase();
      // Extract bare filename without extension for filename-level matching
      const parts = filePath.split("/");
      const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, "").toLowerCase();
      const fileNameTokens = tokenizePath(fileName);

      let score = 0;
      for (const term of allTerms) {
        // Filename match (highest signal — file is specifically about this concept)
        if (fileName.includes(term) || fileNameTokens.some(ft => ft === term)) {
          score += 4;
        }
        // Direct path text match
        else if (pathText.includes(term)) {
          score += 2;
        }
        // Token-level match (partial overlap)
        else if (pathTokens.some(pt => pt.includes(term) || term.includes(pt))) {
          score += 1;
        }
      }

      if (score > 0) {
        // Path quality adjustments
        const lowerPath = "/" + pathText;
        if (SOURCE_PATH_PATTERNS.some(p => lowerPath.includes(p))) {
          score *= 1.5; // Bonus for source code paths
        }
        if (NOISE_PATH_PATTERNS.some(p => lowerPath.includes(p))) {
          score *= 0.3; // Heavy penalty for noise paths
        }

        candidates.push({ path: filePath, score });
      }
    }
  }

  // Sort by score descending, take topN
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topN).map(c => c.path);
}

// ─── Git History RFM Signal ──────────────────────────────────────

/**
 * Compute evolutionary activity scores for directories based on Git history.
 *
 * Uses the RFM (Recency-Frequency-Modification) model:
 * - R: Time since last commit (exponential decay, half-life 30 days)
 * - F: Commit frequency relative to total commits
 * - M: Code churn volume (log2 scale)
 *
 * @param {string} projectRoot
 * @param {string[]} topDirs
 * @param {object} options
 * @returns {Array<{dir: string, score: number, recency: number, frequency: number, modification: number}>}
 */
// Git RFM cache: git log is expensive (~1-10s for large repos).
// TTL shorter than profile cache since commits happen more frequently.
const _gitRFMCache = new Map();
const GIT_RFM_CACHE_TTL_MS = (parseInt(process.env.FC_GIT_CACHE_TTL, 10) || 300) * 1000;

function computeGitRFM(projectRoot, topDirs, options = {}) {
  // Cache lookup — key includes sorted topDirs to handle different dir sets
  const cacheKey = `${projectRoot}|${topDirs.join(",")}`;
  const cached = _gitRFMCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < GIT_RFM_CACHE_TTL_MS) {
    return cached.ranking;
  }

  const {
    windowDays = 180,       // 6 month lookback
    halfLifeDays = 30,      // Recency decay half-life
    wr = 0.4,               // Recency weight
    wf = 0.35,              // Frequency weight
    wm = 0.25,              // Modification weight
  } = options;

  const lambda = Math.LN2 / halfLifeDays;
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceDate = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);

  // Gather per-directory stats in a single git log pass
  const dirStats = {};
  for (const d of topDirs) {
    dirStats[d] = { lastCommitSec: 0, commits: 0, linesChanged: 0 };
  }

  try {
    // Single git log: author-date + numstat, limited to window
    const result = spawnSync("git", [
      "log",
      "--format=%at",        // author timestamp (epoch)
      "--numstat",
      `--since=${sinceDate}`,
      "--no-merges",
    ], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });

    if (result.stdout) {
      let currentTimestamp = 0;
      const seenDirsForCommit = new Set();

      for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          // Empty line = commit boundary
          seenDirsForCommit.clear();
          continue;
        }

        // Timestamp line
        if (/^\d+$/.test(trimmed)) {
          currentTimestamp = parseInt(trimmed, 10);
          seenDirsForCommit.clear();
          continue;
        }

        // Numstat line: added \t deleted \t filepath
        const parts = trimmed.split("\t");
        if (parts.length >= 3) {
          const added = parseInt(parts[0], 10) || 0;
          const deleted = parseInt(parts[1], 10) || 0;
          const filePath = parts[2];
          const topDir = filePath.split(/[\/\\]/)[0];

          if (dirStats[topDir]) {
            dirStats[topDir].linesChanged += added + deleted;
            if (currentTimestamp > dirStats[topDir].lastCommitSec) {
              dirStats[topDir].lastCommitSec = currentTimestamp;
            }
            // Count unique commits per dir (not per file)
            if (!seenDirsForCommit.has(topDir)) {
              seenDirsForCommit.add(topDir);
              dirStats[topDir].commits++;
            }
          }
        }
      }
    }
  } catch { /* git not available or not a git repo - return empty */ }

  // Compute total commits for frequency normalization
  const totalCommits = Object.values(dirStats).reduce((s, d) => s + d.commits, 0) || 1;

  // Compute RFM scores
  const ranking = [];
  for (const dir of topDirs) {
    const stats = dirStats[dir];

    // R: Recency (exponential decay)
    let recency = 0;
    if (stats.lastCommitSec > 0) {
      const daysSince = (nowSec - stats.lastCommitSec) / 86400;
      recency = Math.exp(-lambda * daysSince);
    }

    // F: Frequency (relative to total)
    const frequency = stats.commits / totalCommits;

    // M: Modification (log2 scale)
    const modification = Math.log2(1 + stats.linesChanged);
    // Normalize M to [0,1] range approximately
    const mNorm = modification / (modification + 10);

    const score = wr * recency + wf * frequency + wm * mNorm;
    ranking.push({ dir, score, recency, frequency, modification: stats.linesChanged, commits: stats.commits });
  }

  ranking.sort((a, b) => b.score - a.score);

  // Store in cache
  _gitRFMCache.set(cacheKey, { ranking, cachedAt: Date.now() });

  return ranking;
}

// ─── File-level Log-Sum Aggregation ─────────────────────────────

/**
 * Compute file-level BM25 scores then aggregate to directory using Log-Sum.
 *
 * Instead of treating the entire directory as one flat text blob,
 * score individual files independently then aggregate:
 *   Score(D) = max(file_scores) + α * log(1 + Σ(s_i - τ) for s_i > τ)
 *
 * @param {string[]} queryTerms
 * @param {object} profile - Directory profile with file_paths
 * @param {string} projectRoot
 * @param {object} options
 * @returns {number}
 */
function fileAggregateScore(queryTerms, profile, projectRoot, options = {}) {
  const {
    alpha = 0.5,            // Density bonus weight
    threshold = 0.3,        // Noise filter threshold (τ)
    maxFiles = 200,         // Cap files to score for performance
    sampleHeaderLines = 5,  // Lines to read per file for scoring
  } = options;

  if (!profile.file_paths || profile.file_paths.length === 0) return 0;

  // Score each file by matching query terms against its path + header content
  const fileScores = [];
  const filesToScore = profile.file_paths.slice(0, maxFiles);

  for (const relPath of filesToScore) {
    const pathTokens = tokenizePath(relPath);
    let score = 0;

    // Path-based matching (fast, no I/O)
    for (const qt of queryTerms) {
      // Exact token match in path
      if (pathTokens.some(pt => pt === qt)) {
        score += 2.0;
      }
      // Partial match in path
      else if (pathTokens.some(pt => pt.includes(qt) || qt.includes(pt))) {
        score += 1.0;
      }
      // Raw path string match (catches compound names like "RLSManagement")
      else if (relPath.toLowerCase().includes(qt)) {
        score += 0.5;
      }
    }

    if (score > 0) {
      fileScores.push(score);
    }
  }

  if (fileScores.length === 0) return 0;

  fileScores.sort((a, b) => b - a);

  // Log-Sum aggregation
  const maxScore = fileScores[0];
  const aboveThreshold = fileScores.filter(s => s > threshold);
  const densitySum = aboveThreshold.reduce((sum, s) => sum + (s - threshold), 0);
  const densityBonus = Math.log(1 + densitySum);

  return maxScore + alpha * densityBonus;
}

// ─── File-level Local Preranker ───────────────────────────────

function normalizeRelativePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isExcludedRelativePath(relPath, excludePaths = []) {
  const parts = normalizeRelativePath(relPath).split("/");
  const explicit = excludePaths.map((item) => String(item || "").replace(/\\/g, "/"));
  return parts.some((part) => DEFAULT_EXCLUDES.has(part) || explicit.includes(part)) ||
    explicit.some((pattern) => {
      if (!pattern) return false;
      if (pattern.includes("*")) {
        const escaped = pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        return new RegExp(`^${escaped}$`).test(relPath) || new RegExp(`(?:^|/)${escaped}$`).test(relPath);
      }
      return relPath === pattern || relPath.startsWith(`${pattern}/`);
    });
}

function readFileForScoring(projectRoot, relPath) {
  try {
    const fullPath = join(projectRoot, relPath);
    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size > FILE_SCORE_MAX_BYTES) return "";
    const content = readFileSync(fullPath, "utf-8");
    // Binary blobs are not useful to a text pre-ranker and can make tokenizing
    // unexpectedly expensive.
    if (content.includes("\u0000")) return "";
    return content;
  } catch {
    return "";
  }
}

function collectFileDocuments(projectRoot, topDirs = [], excludePaths = [], queryTerms = []) {
  const documents = [];
  const seen = new Set();
  const dirs = topDirs.length > 0 ? topDirs : ["."];

  for (const dir of dirs) {
    const profile = buildDirectoryProfile(projectRoot, dir, excludePaths, 8);
    const profileText = `${dir} ${profile.path_tokens_text || ""}`.toLowerCase();
    const pathRelevant = queryTerms.length === 0 || queryTerms.some((term) => profileText.includes(term));
    // Large sibling applications can contain thousands of generated or
    // unrelated files. Keep small directories for recall, but avoid reading
    // every file in a large directory when its path spine has no query term.
    if (!pathRelevant && profile.file_count > 200) continue;
    for (const candidate of profile.file_paths || []) {
      const relPath = normalizeRelativePath(candidate);
      if (!relPath || seen.has(relPath) || isExcludedRelativePath(relPath, excludePaths)) continue;
      seen.add(relPath);
      const content = readFileForScoring(projectRoot, relPath);
      if (!content) continue;
      documents.push({
        path: relPath,
        content,
        pathTokens: tokenizePath(relPath),
      });
    }
  }

  // Include root-level files even when nested directories also contributed
  // documents.  Relay repositories commonly keep the hot path at the root
  // beside helper packages; omitting those files makes a file-level scorer
  // systematically miss the main implementation.
  if (topDirs.length > 0) {
    const rootProfile = buildDirectoryProfile(projectRoot, ".", excludePaths, 1);
    for (const candidate of rootProfile.file_paths || []) {
      const relPath = normalizeRelativePath(candidate);
      if (!relPath || seen.has(relPath) || isExcludedRelativePath(relPath, excludePaths)) continue;
      const content = readFileForScoring(projectRoot, relPath);
      if (!content) continue;
      seen.add(relPath);
      documents.push({ path: relPath, content, pathTokens: tokenizePath(relPath) });
    }
  }

  return documents;
}

function splitIdentifier(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_$]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 2);
}

function extractDeclarationNames(content) {
  const names = [];
  for (const pattern of DECLARATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = String(match[1] || "").trim();
      if (name && !names.includes(name)) names.push(name);
      if (match[0] === "") pattern.lastIndex += 1;
    }
  }
  return names;
}

const DECLARATION_NAME_LIMIT = 16;
// Enough to show what a probe hit looks like without turning the screen input
// back into a file dump.
const PROBE_SNIPPET_LINES = 3;
const PROBE_SNIPPET_CHARS = 160;

function declarationOverlapScore(name, queryTerms) {
  const tokens = splitIdentifier(name);
  let score = 0;
  for (const term of queryTerms) {
    if (tokens.includes(term)) score += 2;
    else if (tokens.some((token) => token.startsWith(term) || term.startsWith(token))) score += 1;
  }
  return score;
}

/**
 * Which declarations of a file to expose is a ranking problem, not a
 * truncation problem: taking the first N in file order hands the slots to
 * whatever the file happens to define first. Rank by overlap with the query
 * instead and keep file order as the tie-break, so the result stays
 * deterministic.
 */
function selectDeclarationNames(names = [], queryTerms = [], limit = DECLARATION_NAME_LIMIT) {
  if (names.length <= limit) return names.slice();
  return names
    .map((name, index) => ({ name, index, score: declarationOverlapScore(name, queryTerms) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => item.name);
}

/**
 * Keep only the declaration names that actually touch the query. A grep for
 * `message`, `config` or `details` matches the whole repository and costs a
 * remote turn to learn nothing.
 */
export function selectQueryRelevantNames(names = [], queryTerms = []) {
  if (queryTerms.length === 0) return [];
  return names.filter((name) => declarationOverlapScore(name, queryTerms) > 0);
}

/**
 * The first few lines a probe actually matched, carried on the candidate so a
 * later semantic screen can quote real source without re-reading the file.
 */
function buildProbeSnippet(content, ranges = []) {
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  const lines = String(content || "").split("\n");
  const snippet = [];
  for (const [start] of ranges) {
    for (let line = start; line < start + PROBE_SNIPPET_LINES && line <= lines.length; line += 1) {
      const text = String(lines[line - 1] || "").trim().slice(0, PROBE_SNIPPET_CHARS);
      if (!text) continue;
      snippet.push({ line, text });
      if (snippet.length >= PROBE_SNIPPET_LINES) return snippet;
    }
    if (snippet.length >= PROBE_SNIPPET_LINES) break;
  }
  return snippet;
}

function matchedNames(pattern, content) {
  const names = new Set();
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const name = String(match[1] || "").trim();
    if (name) names.add(name);
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return names;
}

/**
 * Drop the names that are only ever bound to a plain value. What is left is
 * the set of names that answer "what does this file define" — which is the
 * question the semantic screen is asked, and the only kind of name worth
 * spending a grep on.
 */
function extractBehaviorDeclarationNames(names, content) {
  const bound = matchedNames(BOUND_NAME_PATTERN, content);
  if (bound.size === 0) return names;
  const functionValued = matchedNames(FUNCTION_VALUED_BINDING_PATTERN, content);
  const kept = names.filter((name) => !bound.has(name) || functionValued.has(name));
  // `export const handler = () => {}` never reaches DECLARATION_PATTERNS at
  // all — the line starts with `export` — yet in modern JS/TS it is the most
  // common shape a file uses to define the thing it is named after.
  for (const name of functionValued) {
    if (!kept.includes(name)) kept.push(name);
  }
  return kept;
}

function scoreStructure(queryTerms, relPath, declarationNames) {
  let score = 0;
  const pathText = relPath.toLowerCase();
  const pathTokens = tokenizePath(relPath);
  const declarationTokens = declarationNames.flatMap(splitIdentifier);

  for (const term of queryTerms) {
    if (pathTokens.includes(term) || pathText.includes(term)) score += STRUCTURE_PATH_WEIGHT;
    if (declarationTokens.includes(term)) score += STRUCTURE_DECL_EXACT_WEIGHT;
    else if (declarationTokens.some((name) => name.startsWith(term) || term.startsWith(name))) {
      score += STRUCTURE_DECL_PREFIX_WEIGHT;
    }
  }
  return score;
}

function buildLineRanges(content, queryTerms, probeLines = []) {
  const lines = String(content || "").split("\n");
  const matching = new Set(probeLines.map((line) => Number(line)).filter((line) => Number.isInteger(line) && line > 0));
  if (matching.size === 0 && queryTerms.length > 0) {
    for (let index = 0; index < lines.length; index += 1) {
      const lower = lines[index].toLowerCase();
      if (queryTerms.some((term) => lower.includes(term))) matching.add(index + 1);
    }
  }
  if (matching.size === 0 && lines.length > 0) return [[1, Math.min(lines.length, 20)]];

  const sorted = [...matching].sort((a, b) => a - b);
  const ranges = [];
  for (const line of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && line <= previous[1] + 1) previous[1] = line;
    else ranges.push([line, line]);
  }
  return ranges.slice(0, 6);
}

function probeFileGrep(projectRoot, documents, queryTerms, excludePaths = []) {
  const hits = new Map();
  if (queryTerms.length === 0 || documents.length === 0) return hits;

  const pattern = queryTerms
    .slice(0, FILE_PROBE_MAX_TERMS)
    .map((term) => String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return hits;

  const known = new Set(documents.map((document) => document.path));
  const excludeSet = new Set([...excludePaths, ...DEFAULT_EXCLUDES]);
  try {
    const result = spawnSync(rgPath, [
      "-n",
      "--no-heading",
      "--hidden",
      "-g", `!{${[...excludeSet].join(",")}}`,
      pattern,
      projectRoot,
    ], {
      encoding: "utf-8",
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
    });
    for (const line of String(result.stdout || "").split("\n")) {
      const match = line.match(/^(.*):(\d+):/);
      if (!match) continue;
      const relPath = normalizeRelativePath(relative(projectRoot, match[1]));
      if (!known.has(relPath)) continue;
      const lines = hits.get(relPath) || [];
      lines.push(Number(match[2]));
      hits.set(relPath, lines);
    }
  } catch {
    // Probe is an optional signal; BM25 and structure remain usable.
  }
  return hits;
}

function rankFiles(documents, scoreKey) {
  return documents
    .map((document) => ({ path: document.path, score: Number(document[scoreKey] || 0) }))
    .filter((item) => item.score >= FILE_MIN_SIGNAL_SCORE)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function rrfFileFusion(rankings, weights = null) {
  const scores = new Map();
  for (const [rankingIndex, ranking] of rankings.entries()) {
    const weight = Number(weights?.[rankingIndex]) || 1;
    ranking.forEach((item, index) => {
      scores.set(item.path, (scores.get(item.path) || 0) + weight / (RRF_K + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function isTestPath(relPath) {
  const lower = String(relPath || "").toLowerCase();
  return TEST_DIR_PATTERN.test(lower) || TEST_FILE_PATTERN.test(lower);
}

/**
 * Demote test files after RRF fusion, then re-sort with the same tie-break the
 * fusion uses.
 */
function applyTestFilePenalty(fused) {
  return fused
    .map((entry) => (isTestPath(entry.path)
      ? { ...entry, score: entry.score * FILE_TEST_PENALTY }
      : entry))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * Score files using lexical BM25, declaration/path structure, and probe grep,
 * then fuse those rankings with the same RRF constant as directory scoring.
 * The returned candidatePool is intentionally bounded so a later semantic
 * screen can send a compact batch instead of the entire repository.
 */
export function scoreFiles(query, projectRoot, topDirs = [], excludePaths = [], options = {}) {
  const startedAt = Date.now();
  const maxResults = Math.max(1, Number(options.maxResults) || 10);
  const candidateLimit = Math.max(FILE_FALLBACK_CANDIDATES, Number(options.candidateLimit) || maxResults);
  const queryTerms = tokenize(query);
  const documents = collectFileDocuments(projectRoot, topDirs, excludePaths, queryTerms);

  if (documents.length === 0) {
    return {
      candidates: [],
      candidatePool: [],
      hotDirs: [],
      rgPatterns: queryTerms.slice(0, 30),
      queryTerms,
      lexicalHits: 0,
      topScore: 0,
      lowConfidence: true,
      semanticGap: /[\u3400-\u9fff]/.test(String(query || "")),
      elapsedMs: Date.now() - startedAt,
    };
  }

  const lexicalDocs = [];
  const lexicalCorpus = [];
  for (const document of documents) {
    const contentTokens = tokenize(document.content.slice(0, FILE_SCORE_MAX_BYTES));
    const tokens = [...contentTokens, ...document.pathTokens];
    document.lexicalTokens = tokens;
    lexicalCorpus.push(tokens);
  }
  const idf = computeIDF(lexicalCorpus);
  const avgLength = lexicalCorpus.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, lexicalCorpus.length);

  for (const document of documents) {
    document.lexicalScore = bm25FieldScore(queryTerms, document.lexicalTokens, avgLength || 1, document.lexicalTokens.length || 1, idf);
    lexicalDocs.push({ path: document.path, score: document.lexicalScore });
  }

  const probeHits = probeFileGrep(projectRoot, documents, queryTerms, excludePaths);
  for (const document of documents) {
    document.declarationNames = extractDeclarationNames(document.content);
    document.behaviorNames = extractBehaviorDeclarationNames(document.declarationNames, document.content);
    document.structureScore = scoreStructure(queryTerms, document.path, document.declarationNames);
    document.probeScore = probeHits.has(document.path)
      ? Math.log(1 + probeHits.get(document.path).length)
      : 0;
    document.ranges = buildLineRanges(document.content, queryTerms, probeHits.get(document.path) || []);
  }

  const rankings = [
    lexicalDocs
      .filter((item) => item.score >= FILE_MIN_SIGNAL_SCORE)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)),
    rankFiles(documents, "structureScore"),
    rankFiles(documents, "probeScore"),
  ];
  const fused = applyTestFilePenalty(rrfFileFusion(rankings, FILE_RRF_WEIGHTS));
  const byPath = new Map(documents.map((document) => [document.path, document]));
  const candidatePool = fused.slice(0, candidateLimit).map((entry) => {
    const document = byPath.get(entry.path);
    const reasons = [];
    if (document.lexicalScore > 0) reasons.push(`bm25=${document.lexicalScore.toFixed(2)}`);
    if (document.structureScore > 0) reasons.push(`structure=${document.structureScore.toFixed(2)}`);
    if (document.probeScore > 0) reasons.push(`probe=${document.probeScore.toFixed(2)}`);
    return {
      path: entry.path,
      ranges: document.ranges,
      score: entry.score,
      lexicalScore: document.lexicalScore,
      structureScore: document.structureScore,
      probeScore: document.probeScore,
      declarationNames: selectDeclarationNames(document.behaviorNames, queryTerms),
      snippet: buildProbeSnippet(document.content, document.ranges),
      reasons,
    };
  });

  const positive = candidatePool.some((candidate) => candidate.lexicalScore > 0 || candidate.structureScore > 0 || candidate.probeScore > 0);
  const selected = candidatePool.slice(0, maxResults);
  const lexicalHits = documents.filter((document) => document.lexicalScore > 0).length;
  const topScore = Number(candidatePool[0]?.score || 0);
  const hotDirs = [...new Set(candidatePool.slice(0, Math.max(1, maxResults)).map((candidate) => candidate.path.split("/")[0]).filter(Boolean))].slice(0, 12);
  const declarations = candidatePool.flatMap((candidate) => candidate.declarationNames || []);
  const rgPatterns = [...new Set([
    ...queryTerms,
    ...selectQueryRelevantNames(declarations, queryTerms),
  ])].filter((item) => item.length >= 3).slice(0, 30);

  const semanticGap = /[\u3400-\u9fff]/.test(String(query || ""));
  return {
    candidates: selected,
    candidatePool: positive ? candidatePool : documents
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, candidateLimit)
      .map((document) => ({
        path: document.path,
        ranges: document.ranges,
        score: 0,
        lexicalScore: 0,
        structureScore: 0,
        probeScore: 0,
        declarationNames: selectDeclarationNames(document.behaviorNames, queryTerms),
        snippet: buildProbeSnippet(document.content, document.ranges),
        reasons: [],
      })),
    hotDirs,
    rgPatterns,
    queryTerms,
    lexicalHits,
    topScore,
    lowConfidence: lexicalHits === 0 || semanticGap || topScore < FILE_LOW_CONFIDENCE_SCORE,
    semanticGap,
    elapsedMs: Date.now() - startedAt,
  };
}

// ─── Main API ────────────────────────────────────────────────────

/**
 * Score directories using BM25F + Probe + Git RFM + File Aggregation + RRF
 *
 * @param {string} query - User query
 * @param {string} projectRoot - Project root path
 * @param {string[]} topDirs - List of top-level directories
 * @param {string[]} excludePaths - Paths to exclude
 * @param {object} options - Configuration options
 * @returns {{ hotDirs: string[], pathSpines: string[], signals: object }}
 */
export function scoreDirectories(query, projectRoot, topDirs, excludePaths = [], options = {}) {
  const {
    topK = 4,
    useProbe = true,
    useGitRFM = true,
    useFileAgg = true,
    keywords = [], // From bootstrap phase
    minReturn = 2,
  } = options;

  const queryTerms = tokenize(query);

  // Step 1: Build profiles for all directories + pre-tokenize fields (once)
  const profiles = {};
  for (const dir of topDirs) {
    const profile = buildDirectoryProfile(projectRoot, dir, excludePaths);
    // Cache tokenized fields on profile — avoids triple tokenization in IDF/avgLen/BM25F
    profile._tok = {
      dir_name: tokenize(profile.dir_name),
      path_tokens: tokenize(profile.path_tokens_text),
      metadata: tokenize(profile.metadata),
      headers: tokenize(profile.headers_text),
    };
    profiles[dir] = profile;
  }

  // Step 2: Compute IDF across all profiles (uses cached tokens)
  const allFieldTerms = [];
  for (const profile of Object.values(profiles)) {
    const t = profile._tok;
    allFieldTerms.push([...t.dir_name, ...t.path_tokens, ...t.metadata, ...t.headers]);
  }
  const idf = computeIDF(allFieldTerms);

  // Step 3: Compute average field lengths (uses cached tokens)
  const avgFieldLens = { dir_name: 0, path_tokens: 0, metadata: 0, headers: 0 };
  const counts = { dir_name: 0, path_tokens: 0, metadata: 0, headers: 0 };

  for (const profile of Object.values(profiles)) {
    const t = profile._tok;
    avgFieldLens.dir_name += t.dir_name.length;
    counts.dir_name++;
    avgFieldLens.path_tokens += t.path_tokens.length;
    counts.path_tokens++;
    avgFieldLens.metadata += t.metadata.length;
    counts.metadata++;
    avgFieldLens.headers += t.headers.length;
    counts.headers++;
  }

  for (const field of Object.keys(avgFieldLens)) {
    avgFieldLens[field] = counts[field] > 0 ? avgFieldLens[field] / counts[field] : 10;
  }

  // Step 4: Signal 1 - BM25F scores
  const bm25fRanking = [];
  for (const dir of topDirs) {
    const score = bm25fScore(queryTerms, profiles[dir], avgFieldLens, idf);
    bm25fRanking.push({ dir, score });
  }
  bm25fRanking.sort((a, b) => b.score - a.score);

  const rankings = [bm25fRanking];
  const signals = { bm25f: bm25fRanking.map(r => r.dir) };

  // Step 5: Signal 2 - Probe grep (if enabled)
  if (useProbe && queryTerms.length > 0) {
    // Fuse query terms with bootstrap keywords for probe selection
    const keywordTerms = keywords && keywords.length > 0
      ? keywords.flatMap(k => tokenize(k))
      : [];
    const allProbeCandidates = [...new Set([...queryTerms, ...keywordTerms])];

    const probeTerms = selectProbeTerms(allProbeCandidates, idf);
    if (probeTerms.length > 0) {
      const dirHits = probeGrep(projectRoot, topDirs, probeTerms, excludePaths);

      const probeRanking = [];
      for (const dir of topDirs) {
        const hits = dirHits[dir] || 0;
        const fileCount = profiles[dir].file_count || 1;
        const score = computeProbeScore(hits, fileCount);
        probeRanking.push({ dir, score, hits, fileCount });
      }
      probeRanking.sort((a, b) => b.score - a.score);
      rankings.push(probeRanking);
      signals.probe = probeRanking.map(r => `${r.dir}:${r.hits}`);
    }
  }

  // Step 6: Signal 3 - Keywords from bootstrap (if provided)
  if (keywords && keywords.length > 0) {
    const keywordTerms = keywords.flatMap(k => tokenize(k));
    const keywordRanking = [];

    for (const dir of topDirs) {
      let score = 0;
      const profile = profiles[dir];

      // Check if keywords match in paths
      for (const term of keywordTerms) {
        if (profile.path_tokens_text.toLowerCase().includes(term)) {
          score += 1;
        }
      }

      keywordRanking.push({ dir, score });
    }
    keywordRanking.sort((a, b) => b.score - a.score);
    rankings.push(keywordRanking);
    signals.keywords = keywordRanking.map(r => r.dir);
  }

  // Step 7: Signal 4 - Git History RFM (evolutionary activity)
  if (useGitRFM) {
    try {
      const gitRanking = computeGitRFM(projectRoot, topDirs);
      if (gitRanking.some(r => r.score > 0)) {
        rankings.push(gitRanking);
        signals.gitRFM = gitRanking.slice(0, 6).map(r =>
          `${r.dir}:R=${r.recency.toFixed(2)},C=${r.commits}`
        );
      }
    } catch { /* git not available */ }
  }

  // Step 8: Signal 5 - File-level Log-Sum aggregation
  if (useFileAgg) {
    const fileAggRanking = [];
    for (const dir of topDirs) {
      const score = fileAggregateScore(queryTerms, profiles[dir], projectRoot);
      fileAggRanking.push({ dir, score });
    }
    fileAggRanking.sort((a, b) => b.score - a.score);
    if (fileAggRanking.some(r => r.score > 0)) {
      rankings.push(fileAggRanking);
      signals.fileAgg = fileAggRanking.slice(0, 6).map(r =>
        `${r.dir}:${r.score.toFixed(2)}`
      );
    }
  }

  // Step 9: RRF Fusion
  const fused = rrfFusion(rankings);

  // Step 10: Ensure minimum return
  while (fused.length < minReturn && fused.length < topDirs.length) {
    const missing = topDirs.find(d => !fused.some(f => f.dir === d));
    if (missing) {
      fused.push({ dir: missing, score: 0.001 });
    } else {
      break;
    }
  }

  // Step 11: Extract path spines from matched files
  const pathSpines = extractPathSpines(profiles, queryTerms, keywords, 30);

  // Step 12: Adaptive topK via score distribution analysis
  //
  // Based on IR literature:
  // - Taguchi et al. (2025) "Adaptive-k": max-gap detection on sorted scores
  // - Xu et al. (2025) "CAR": entropy-based distribution analysis for cutoff
  // - Kratzwald et al. (2018): cumulative score threshold for query-dependent k
  // - CMU Selective Search: shard cutoff via distribution skewness/entropy
  //
  // Hybrid approach: K_base (safety floor) + K_knee (gap detection) + entropy scaling
  // + adaptive tail threshold (replaces fixed 0.6)
  const hotDirs = _adaptiveTopK(fused, topK, topDirs.length);

  return {
    hotDirs,
    pathSpines,
    signals,
    rawRankings: {
      bm25f: bm25fRanking,
      fused,
    },
  };
}

/**
 * Quick scoring for when profiles are already built
 */
export function quickScore(query, topDirs, profiles) {
  const queryTerms = tokenize(query);
  const scored = [];

  for (const dir of topDirs) {
    const profile = profiles[dir] || { path_tokens_text: "", dir_name: dir };
    const dirTerms = [...tokenize(profile.dir_name), ...tokenize(profile.path_tokens_text)];

    let score = 0;
    for (const qt of queryTerms) {
      if (dirTerms.some(dt => dt.includes(qt) || qt.includes(dt))) {
        score += 1;
      }
    }

    scored.push({ dir, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export { tokenize, tokenizePath, stem, computeIDF };
