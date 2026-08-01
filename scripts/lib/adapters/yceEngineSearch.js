const {
  buildError,
  detectQuotaError,
  fileExists,
  isDirectory,
  runLocalSearch,
  runCommand,
  summarizeText,
} = require("../utils");

function isLocalFallbackEnabled(env) {
  return String(env?.YCE_LOCAL_FALLBACK || "").trim().toLowerCase() === "true";
}

function mapYceEngineFailure(text) {
  const t = text || "";
  if (/relay key lease failed/i.test(t)) {
    if (/HTTP 401|HTTP 403|AUTH_ERROR|UNAUTHORIZED|FORBIDDEN/i.test(t)) {
      return { code: "AUTH_ERROR", message: t.trim() || "YCE engine authentication failed. Configure YCE_RELAY_URL/YCE_RELAY_TOKEN or set YCE_API_KEY, then run YCE setup again." };
    }
    return { code: "UPSTREAM_ERROR", message: t.trim() || "YCE relay key lease failed." };
  }
  if (/key discovery failed|API Key not found|HTTP 401|HTTP 403/i.test(t)) {
    return { code: "AUTH_ERROR", message: t.trim() || "YCE engine authentication failed. Configure YCE_RELAY_URL/YCE_RELAY_TOKEN or set YCE_API_KEY, then run YCE setup again." };
  }
  if (/vendored core is missing|Cannot find|MODULE_NOT_FOUND/i.test(t)) {
    return { code: "DEPENDENCY_NOT_FOUND", message: t.trim() || "yce-engine core or dependencies are missing." };
  }
  if (/resource_exhausted|internal error occurred|trace ID/i.test(t)) {
    return { code: "UPSTREAM_ERROR", message: t.trim() || "yce-engine upstream search failed." };
  }
  if (detectQuotaError(t)) {
    return { code: "QUOTA_EXCEEDED", message: t.trim() || "yce-engine quota was exhausted." };
  }
  return { code: "EXEC_ERROR", message: t.trim() || "yce-engine search execution failed." };
}

function detectYceEngineSemanticFailure(stdout, stderr) {
  const text = `${stderr || ""}\n${stdout || ""}`.trim();
  if (!text) return null;

  const hasSearchResultHeader = /Found\s+\d+\s+relevant\s+files\./i.test(stdout || "");
  if (hasSearchResultHeader) return null;

  const isFailureText =
    /^\s*(Error|\[Error\]|SyntaxError|TypeError|ReferenceError|RangeError):/im.test(text) ||
    /resource_exhausted|internal error occurred|trace ID/i.test(text) ||
    detectQuotaError(text);

  if (!isFailureText) return null;
  return mapYceEngineFailure(text);
}

function parseStructuredPayload(stdout) {
  const text = String(stdout || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

async function runYceEngineSearch({
  query,
  cwd,
  scriptPath,
  timeoutMs,
  maxResults,
  maxTurns,
  maxCommands,
  treeDepth,
  excludePaths = [],
  repoMapMode,
  bootstrapEnabled = true,
  bootstrapTreeDepth,
  hotspotTopK,
  hotspotTreeDepth,
  hotspotMaxBytes,
  bootstrapMaxTurns,
  bootstrapMaxCommands,
  env,
}) {
  const result = {
    executed: true,
    success: false,
    query,
    raw_stdout: null,
    result_present: false,
    empty_result: false,
    files: [],
    grep_patterns: [],
    diagnostics: null,
    exit_code: null,
    stderr_summary: [],
  };

  if (!fileExists(scriptPath)) {
    return {
      search: result,
      error: buildError("yce-engine", "DEPENDENCY_NOT_FOUND", `yce-engine script not found: ${scriptPath}`),
      durationMs: 0,
    };
  }

  if (!isDirectory(cwd)) {
    return {
      search: result,
      error: buildError("yce-engine", "INVALID_ARGS", `Search cwd does not exist or is not a directory: ${cwd}`),
      durationMs: 0,
    };
  }

  const args = [scriptPath, "--project", cwd, "--query", query, "--json"];
  if (Number.isInteger(maxResults) && maxResults > 0) args.push("--max-results", String(maxResults));
  if (Number.isInteger(maxTurns) && maxTurns > 0) args.push("--max-turns", String(maxTurns));
  if (Number.isInteger(maxCommands)) args.push("--max-commands", String(maxCommands));
  if (Number.isInteger(treeDepth)) args.push("--tree-depth", String(treeDepth));
  for (const excludePath of excludePaths) args.push("--exclude", String(excludePath));
  if (repoMapMode) args.push("--repo-map-mode", String(repoMapMode));
  if (Number.isInteger(bootstrapTreeDepth)) args.push("--bootstrap-tree-depth", String(bootstrapTreeDepth));
  if (Number.isInteger(hotspotTopK)) args.push("--hotspot-top-k", String(hotspotTopK));
  if (Number.isInteger(hotspotTreeDepth)) args.push("--hotspot-tree-depth", String(hotspotTreeDepth));
  if (Number.isInteger(hotspotMaxBytes)) args.push("--hotspot-max-bytes", String(hotspotMaxBytes));
  if (Number.isInteger(bootstrapMaxTurns)) args.push("--bootstrap-max-turns", String(bootstrapMaxTurns));
  if (Number.isInteger(bootstrapMaxCommands)) args.push("--bootstrap-max-commands", String(bootstrapMaxCommands));
  // The engine gets a smaller internal budget than the subprocess kill timer,
  // so on timeout it can still flush its structured JSON (partial results,
  // quota codes, diagnostics) before SIGTERM. Equal budgets made SIGTERM win
  // every race and every timeout surfaced as a bare TIMEOUT with no output.
  const ENGINE_BUDGET_HEADROOM_MS = 10000;
  const MIN_ENGINE_BUDGET_MS = 30000;
  if (Number.isInteger(timeoutMs)) {
    const engineTimeoutMs = timeoutMs > MIN_ENGINE_BUDGET_MS + ENGINE_BUDGET_HEADROOM_MS
      ? timeoutMs - ENGINE_BUDGET_HEADROOM_MS
      : timeoutMs;
    args.push("--timeout-ms", String(engineTimeoutMs));
  }
  args.push(bootstrapEnabled === false ? "--no-bootstrap" : "--bootstrap-enabled");

  const startedAt = Date.now();
  const commandResult = await runCommand("node", args, { cwd, timeoutMs, env });
  const durationMs = Date.now() - startedAt;

  result.exit_code = commandResult.exitCode;
  result.stderr_summary = summarizeText(commandResult.stderr);
  const payload = parseStructuredPayload(commandResult.stdout);
  result.raw_stdout = payload ? payload.output || null : commandResult.stdout || null;
  if (payload) {
    result.result_present = payload.result_present === true;
    result.empty_result = payload.empty_result === true;
    result.files = Array.isArray(payload.files) ? payload.files : [];
    result.grep_patterns = Array.isArray(payload.grep_patterns) ? payload.grep_patterns : [];
    result.diagnostics = payload.diagnostics && typeof payload.diagnostics === "object" ? payload.diagnostics : null;
  }

  const failWithLocalFallback = (code, message) => {
    const error = buildError("yce-engine", code, message);
    if (isLocalFallbackEnabled(env)) {
      const fallback = runLocalSearch({ query, cwd, maxResults });
      if (fallback.search.result_present) {
        fallback.search.raw_stdout = [
          fallback.search.raw_stdout,
          "",
          "Remote yce-engine failed; local fallback was used.",
          `Remote error: ${message}`,
        ].join("\n");
        return { search: fallback.search, error, durationMs };
      }
    }
    return { search: result, error, durationMs };
  };

  if (commandResult.timedOut) {
    return failWithLocalFallback("TIMEOUT", `yce-engine search timed out after ${timeoutMs}ms.`);
  }

  if (commandResult.spawnError) {
    return failWithLocalFallback("EXEC_ERROR", commandResult.spawnError.message);
  }

  if (commandResult.exitCode === 0) {
    if (payload) {
      if (payload.success !== true) {
        const mapped = mapYceEngineFailure(payload.error || payload.output || commandResult.stderr);
        return {
          search: result,
          error: buildError("yce-engine", mapped.code, mapped.message),
          durationMs,
        };
      }
      result.success = true;
      if (result.result_present) return { search: result, error: null, durationMs };
      if (result.empty_result) {
        if (isLocalFallbackEnabled(env)) {
          const fallback = runLocalSearch({ query, cwd, maxResults });
          fallback.search.diagnostics = { source: "local_fallback" };
          if (fallback.search.result_present) return { search: fallback.search, error: null, durationMs };
        }
        return {
          search: result,
          error: buildError("yce-engine", "EMPTY_RESULT", "yce-engine search completed but returned no results."),
          durationMs,
        };
      }
      return {
        search: result,
        error: buildError("yce-engine", "EXEC_ERROR", "yce-engine returned structured output without a usable result."),
        durationMs,
      };
    }
    const stdout = (commandResult.stdout || "").trim();
    const semanticFailure = detectYceEngineSemanticFailure(commandResult.stdout, commandResult.stderr);
    if (semanticFailure) {
      if (isLocalFallbackEnabled(env)) {
        const fallback = runLocalSearch({ query, cwd, maxResults });
        if (fallback.search.result_present) {
          fallback.search.raw_stdout = [
            fallback.search.raw_stdout,
            "",
            "Remote yce-engine failed; local fallback was used.",
            `Remote error: ${semanticFailure.message}`,
          ].join("\n");
          return {
            search: fallback.search,
            error: buildError("yce-engine", semanticFailure.code, semanticFailure.message),
            durationMs,
          };
        }
        if (fallback.search.empty_result) {
          fallback.search.raw_stdout = [
            fallback.search.raw_stdout,
            "",
            "Remote yce-engine failed; local fallback also returned no results.",
            `Remote error: ${semanticFailure.message}`,
          ].join("\n");
          return {
            search: fallback.search,
            error: buildError("yce-engine", semanticFailure.code, semanticFailure.message),
            durationMs,
          };
        }
      }
      return {
        search: result,
        error: buildError("yce-engine", semanticFailure.code, semanticFailure.message),
        durationMs,
      };
    }

    if (/Found 0 relevant files|No relevant files found/i.test(stdout) || !stdout) {
      if (isLocalFallbackEnabled(env)) {
        const fallback = runLocalSearch({ query, cwd, maxResults });
        if (fallback.search.result_present) {
          fallback.search.raw_stdout = [
            fallback.search.raw_stdout,
            "",
            "Remote yce-engine returned no results; local fallback was used.",
          ].join("\n");
          return {
            search: fallback.search,
            error: null,
            durationMs,
          };
        }
      }
      result.success = true;
      result.empty_result = true;
      return {
        search: result,
        error: buildError("yce-engine", "EMPTY_RESULT", "yce-engine search completed but returned no results."),
        durationMs,
      };
    }
    result.success = true;
    result.result_present = true;
    return { search: result, error: null, durationMs };
  }

  const mapped = mapYceEngineFailure(payload?.error || commandResult.stderr || commandResult.stdout);
  if (isLocalFallbackEnabled(env)) {
    const fallback = runLocalSearch({ query, cwd, maxResults });
    if (fallback.search.result_present) {
      fallback.search.raw_stdout = [
        fallback.search.raw_stdout,
        "",
        "Remote yce-engine failed; local fallback was used.",
        `Remote error: ${mapped.message}`,
      ].join("\n");
      return {
        search: fallback.search,
        error: buildError("yce-engine", mapped.code, mapped.message),
        durationMs,
      };
    }
    if (fallback.search.empty_result) {
      fallback.search.raw_stdout = [
        fallback.search.raw_stdout,
        "",
        "Remote yce-engine failed; local fallback also returned no results.",
        `Remote error: ${mapped.message}`,
      ].join("\n");
      return {
        search: fallback.search,
        error: buildError("yce-engine", mapped.code, mapped.message),
        durationMs,
      };
    }
  }
  return {
    search: result,
    error: buildError("yce-engine", mapped.code, mapped.message),
    durationMs,
  };
}

module.exports = {
  runYceEngineSearch,
};
