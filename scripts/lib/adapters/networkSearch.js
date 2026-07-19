const { randomUUID } = require("crypto");
const { buildError } = require("../utils");

function mapNetworkError(status, payload) {
  const code = String(payload?.code || "").trim();
  const message = String(payload?.error || payload?.message || "联网检索失败").trim();
  if (status === 401 || status === 403) {
    return buildError("network-search", "AUTH_ERROR", message);
  }
  if (status === 429 || /QUOTA|EXTRA_QUOTA_EXHAUSTED/.test(code)) {
    return buildError("network-search", "QUOTA_EXCEEDED", message);
  }
  if (code === "NETWORK_SEARCH_DISABLED") {
    return buildError("network-search", "DISABLED", message);
  }
  if (code === "NETWORK_SEARCH_TIMEOUT") {
    return buildError("network-search", "TIMEOUT", message);
  }
  return buildError("network-search", code || "EXEC_ERROR", message);
}

async function runNetworkSearch({
  query,
  relayUrl,
  relayToken,
  timeoutMs,
  profile = "balanced",
  library,
  repo,
}) {
  const requestId = randomUUID();
  const networkSearch = {
    executed: true,
    success: false,
    result_present: false,
    request_id: requestId,
    query,
    profile,
    status: null,
    classification: null,
    evidence: [],
    summaries: [],
    provider_runs: [],
    failures: [],
    usage: null,
  };

  if (!relayToken || !String(relayToken).trim()) {
    return {
      networkSearch,
      error: buildError(
        "network-search",
        "AUTH_ERROR",
        "缺少 Relay 用户令牌：请设置 YCE_RELAY_TOKEN。",
      ),
      durationMs: 0,
    };
  }

  const endpoint = `${String(relayUrl || "").replace(/\/+$/, "")}/yce/network-search`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(relayToken).trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: requestId,
        query,
        profile,
        ...(library ? { library } : {}),
        ...(repo ? { repo } : {}),
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        networkSearch,
        error: mapNetworkError(response.status, payload),
        durationMs,
      };
    }

    networkSearch.success = true;
    networkSearch.status = payload.status || "succeeded";
    networkSearch.classification = payload.classification ?? null;
    networkSearch.evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
    networkSearch.summaries = Array.isArray(payload.summaries) ? payload.summaries : [];
    networkSearch.provider_runs = Array.isArray(payload.providerRuns)
      ? payload.providerRuns
      : [];
    networkSearch.failures = Array.isArray(payload.failures) ? payload.failures : [];
    networkSearch.usage =
      payload.usage && typeof payload.usage === "object" ? payload.usage : null;
    networkSearch.result_present =
      networkSearch.evidence.length > 0 || networkSearch.summaries.length > 0;
    if (!networkSearch.result_present) {
      return {
        networkSearch,
        error: buildError(
          "network-search",
          "EMPTY_RESULT",
          "联网检索完成，但没有返回可用事实依据。",
        ),
        durationMs,
      };
    }
    return { networkSearch, error: null, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const timedOut = error && error.name === "AbortError";
    return {
      networkSearch,
      error: buildError(
        "network-search",
        timedOut ? "TIMEOUT" : "EXEC_ERROR",
        timedOut
          ? `联网检索请求在 ${timeoutMs}ms 后超时。`
          : error?.message || "联网检索请求失败。",
      ),
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runNetworkSearch };
