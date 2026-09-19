import { relative, resolve, sep } from "node:path";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_SKELETON_CHARS = 400;
// A second trim on top of the preranker's own limit. The list arriving here is
// already ranked by overlap with the query, so this keeps the strongest names
// and only drops the tail — raising it past the preranker's limit buys nothing.
const MAX_RECORD_DECLARATIONS = 12;
const MAX_RECORD_SNIPPET_LINES = 3;

function safeCandidatePath(projectRoot, candidatePath) {
  const root = resolve(projectRoot);
  const raw = String(candidatePath || "");
  const full = resolve(root, raw);
  const rel = relative(root, full);
  if (rel === ".." || rel.startsWith(`..${sep}`) || full === root) return null;
  return full;
}

// The screen is asked which file *defines* the behavior in `goal`. A skeleton
// of source lines cannot answer that: for JS/TS files it is usually nothing
// but the import list, so the only real signal left is the path. What does
// answer it is already computed by the preranker — the declaration names it
// picked against the query and the first lines the probe actually matched —
// so the record is assembled from the candidate itself and the file is never
// re-read here.
function buildCandidateRecord(projectRoot, candidate, maxChars) {
  if (!safeCandidatePath(projectRoot, candidate?.path)) return null;
  const path = String(candidate.path).replace(/\\/g, "/");
  const declarations = (Array.isArray(candidate.declarationNames) ? candidate.declarationNames : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .slice(0, MAX_RECORD_DECLARATIONS);
  const matched = (Array.isArray(candidate.snippet) ? candidate.snippet : [])
    .filter((entry) => entry && Number.isFinite(Number(entry.line)) && String(entry.text || "").trim())
    .slice(0, MAX_RECORD_SNIPPET_LINES)
    .map((entry) => `  L${Number(entry.line)}: ${String(entry.text).trim()}`);
  const sections = [];
  if (declarations.length > 0) sections.push(`declares: ${declarations.join(", ")}`);
  if (matched.length > 0) sections.push(`matched lines:\n${matched.join("\n")}`);
  return {
    path,
    skeleton: sections.join("\n").slice(0, Math.max(0, Number(maxChars) || DEFAULT_SKELETON_CHARS)),
  };
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
    const record = buildCandidateRecord(projectRoot, candidate, skeletonChars);
    if (record) records.push(record);
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

