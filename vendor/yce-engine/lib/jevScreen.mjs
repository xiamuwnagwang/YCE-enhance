import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_SKELETON_CHARS = 400;

// Jev's screen input is a compact source skeleton rather than a full file.
// Keep declarations, imports, package/module lines, routes, and comments that
// look like headings; this is intentionally language-agnostic.
const SKELETON_LINE_RE = /^\s*(?:package\b|import\b|from\b|using\b|include\b|(?:export\s+)?(?:async\s+)?function\b|func\b|def\b|class\b|type\b|struct\b|interface\b|trait\b|enum\b|module\b|namespace\b|protocol\b|const\b|var\b|CREATE\s+(?:TABLE|VIEW|FUNCTION|PROCEDURE)\b|ALTER\s+(?:TABLE|VIEW|FUNCTION|PROCEDURE)\b|[@#/]\s*[A-Z][^\n]*)/i;

function safeCandidatePath(projectRoot, candidatePath) {
  const root = resolve(projectRoot);
  const raw = String(candidatePath || "");
  const full = resolve(root, raw);
  const rel = relative(root, full);
  if (rel === ".." || rel.startsWith(`..${sep}`) || full === root) return null;
  return full;
}

export function buildFileSkeleton(content, maxChars = DEFAULT_SKELETON_CHARS) {
  const lines = String(content || "").split(/\r?\n/);
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (!SKELETON_LINE_RE.test(line)) continue;
    const normalized = line.trim().slice(0, 180);
    if (!normalized) continue;
    const next = kept.length > 0 ? `${kept.join("\n")}\n${normalized}` : normalized;
    if (next.length > maxChars) break;
    kept.push(normalized);
    used = next.length;
  }
  if (kept.length === 0) {
    return String(content || "").slice(0, maxChars);
  }
  return kept.join("\n").slice(0, Math.max(0, maxChars));
}

function readCandidateSkeleton(projectRoot, candidate, maxChars) {
  const fullPath = safeCandidatePath(projectRoot, candidate?.path);
  if (!fullPath) return null;
  try {
    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const content = readFileSync(fullPath, "utf8");
    return {
      path: String(candidate.path).replace(/\\/g, "/"),
      skeleton: buildFileSkeleton(content, maxChars),
    };
  } catch {
    return null;
  }
}

function normalizeProbabilities(answer, ids) {
  const probabilities = answer && typeof answer.probabilities === "object"
    ? answer.probabilities
    : {};
  return ids
    .map((id) => ({
      id,
      probability: Number(probabilities[id]),
    }))
    .filter((item) => Number.isFinite(item.probability))
    .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
}

/**
 * Ask Jev one batched choice question over compact file skeletons.
 * Failures are values, never thrown, so local preranking remains the caller's
 * deterministic baseline when the optional semantic screen is unavailable.
 */
export async function screenCandidates({
  query,
  projectRoot,
  candidates = [],
  apiKey = "",
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  skeletonChars = DEFAULT_SKELETON_CHARS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const startedAt = Date.now();
  const key = String(apiKey || "").trim();
  if (!key) {
    return { ok: false, skipped: true, reason: "missing_api_key", elapsedMs: 0, inputTokens: null, candidates: [] };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, skipped: true, reason: "fetch_unavailable", elapsedMs: 0, inputTokens: null, candidates: [] };
  }

  const records = [];
  for (const candidate of candidates.slice(0, Math.max(1, Number(maxCandidates) || DEFAULT_MAX_CANDIDATES))) {
    const record = readCandidateSkeleton(projectRoot, candidate, skeletonChars);
    if (record && record.skeleton) records.push(record);
  }
  if (records.length === 0) {
    return { ok: false, skipped: true, reason: "no_candidates", elapsedMs: Date.now() - startedAt, inputTokens: null, candidates: [] };
  }

  const ids = records.map((record, index) => `file_${index}`);
  const criteria = Object.fromEntries(records.map((record, index) => [
    ids[index], `${record.path}:\n${record.skeleton}`,
  ]));
  const body = {
    model: "jev-latest",
    state: { goal: String(query || "") },
    questions: {
      pick: {
        type: "choice",
        instructions: "Which candidate file truly carries the behavior described in `goal` (defines it, not merely calls or mentions it)? Judge from each candidate skeleton and do not require shared vocabulary.",
        criteria,
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        reason: `http_${response.status}`,
        elapsedMs: Date.now() - startedAt,
        inputTokens: payload?.usage?.input_tokens ?? null,
        candidates: [],
      };
    }
    const answer = payload?.answers?.pick;
    const ranking = normalizeProbabilities(answer, ids);
    if (ranking.length === 0) {
      return {
        ok: false,
        skipped: false,
        reason: "invalid_response",
        elapsedMs: Date.now() - startedAt,
        inputTokens: payload?.usage?.input_tokens ?? null,
        candidates: [],
      };
    }
    return {
      ok: true,
      skipped: false,
      reason: null,
      elapsedMs: Date.now() - startedAt,
      inputTokens: payload?.usage?.input_tokens ?? null,
      outputTokens: payload?.usage?.output_tokens ?? null,
      topProbability: ranking[0]?.probability ?? null,
      candidates: ranking.map((item) => ({
        path: records[Number(item.id.slice(5))]?.path || "",
        probability: item.probability,
        confidence: answer?.confidence ?? null,
      })).filter((item) => item.path),
    };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : "request_failed";
    return {
      ok: false,
      skipped: false,
      reason,
      elapsedMs: Date.now() - startedAt,
      inputTokens: null,
      candidates: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

