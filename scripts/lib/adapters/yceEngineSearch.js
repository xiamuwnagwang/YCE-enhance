const {
  buildError,
  detectQuotaError,
  fileExists,
  isDirectory,
  runLocalSearch,
  runCommand,
  summarizeText,
} = require("../utils");
const {
  buildCodeContext,
  DEFAULT_CODE_CONTEXT_MAX_TOKENS,
} = require("../codeContext");
const {
  buildCacheKey,
  computeFingerprint,
  readCacheEntry,
  resolveCacheConfig,
  writeCacheEntry,
} = require("../searchCache");

function isLocalFallbackEnabled(env) {
  return String(env?.YCE_LOCAL_FALLBACK || "").trim().toLowerCase() === "true";
}

const DEFER_DISABLED_VALUES = new Set(["0", "false", "off", "no"]);
function isDeferUsageFlushEnabled(env) {
  return !DEFER_DISABLED_VALUES.has(String(env?.YCE_DEFER_USAGE_FLUSH ?? "").trim().toLowerCase());
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

/**
 * A cache hit runs no jev screen and asks the relay nothing, so every
 * `jev_*` diagnostic in the cached blob describes the *earlier* run:
 * attempted/success/elapsed/tokens/top-probability/skip-reason are that run's
 * behavior, and key-source/key-id/lease-error/entitled are observations only
 * that run's relay round trip could make. Replaying any of them would let a
 * hit claim work this process never did.
 *
 * Stripped by `jev_` prefix rather than a fixed list so fields added later
 * can't silently start leaking, and the replay marker is set afterwards so it
 * can't sweep itself. Done on read, not on write: the cached blob stays a
 * faithful record of the run that produced it.
 */
function stripReplayedJevDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return {};
  const kept = {};
  let replayed = false;
  for (const [key, value] of Object.entries(diagnostics)) {
    if (key.startsWith("jev_")) {
      replayed = true;
      continue;
    }
    kept[key] = value;
  }
  if (replayed) kept.jev_screen_replayed = true;
  return kept;
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
  bootstrapMode = "local",
  bootstrapTreeDepth,
  hotspotTopK,
  hotspotTreeDepth,
  hotspotMaxBytes,
  bootstrapMaxTurns,
  bootstrapMaxCommands,
  noJevScreen = false,
  codeContextEnabled = true,
  codeContextMaxTokens = DEFAULT_CODE_CONTEXT_MAX_TOKENS,
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
    code_context: null,
    grep_patterns: [],
    diagnostics: null,
    exit_code: null,
    stderr_summary: [],
  };

  const runLocalFallback = () => runLocalSearch({
    query,
    cwd,
    maxResults,
    codeContextEnabled,
    codeContextMaxTokens,
  });

  if (!fileExists(scriptPath)) {
    if (isLocalFallbackEnabled(env)) {
      const fallback = runLocalFallback();
      if (fallback.search.result_present || fallback.search.empty_result) {
        return {
          search: fallback.search,
          error: buildError("yce-engine", "DEPENDENCY_NOT_FOUND", `yce-engine script not found: ${scriptPath}`),
          durationMs: 0,
        };
      }
    }
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

  const cacheConfig = resolveCacheConfig(env || {});
  const prerankCjkEnabled = String(
    env?.YCE_PRERANK_CJK ?? process.env.YCE_PRERANK_CJK ?? "",
  ).trim() !== "0";
  let cacheKey = null;
  let cacheFingerprint = null;
  let cacheFingerprintMs = 0;
  const cacheLookupStartedAt = Date.now();
  if (cacheConfig.enabled) {
    const fp = computeFingerprint(cwd);
    cacheFingerprint = fp.fingerprint;
    cacheFingerprintMs = fp.elapsedMs;
    cacheKey = buildCacheKey({
      fingerprint: cacheFingerprint,
      cwd,
      query,
      // Everything below reaches the engine as argv, so everything below has
      // to reach the key too — see buildCacheKey's coarse-vs-fine note.
      // timeoutMs is the one argv exception: it is an execution budget, not a
      // result-shape parameter, so it stays out of the key.
      // codeContextEnabled/codeContextMaxTokens are deliberately absent: they
      // never touch the engine payload, and <code-context> is rebuilt from
      // disk on every hit anyway.
      maxResults,
      maxTurns,
      maxCommands,
      treeDepth,
      excludePaths,
      repoMapMode,
      bootstrapEnabled,
      bootstrapMode,
      bootstrapTreeDepth,
      hotspotTopK,
      hotspotTreeDepth,
      hotspotMaxBytes,
      bootstrapMaxTurns,
      bootstrapMaxCommands,
      noJevScreen,
      prerankCjkEnabled,
      scriptPath,
    });
    const cached = readCacheEntry(cacheConfig.dir, cacheKey, cacheConfig.ttlMs);
    if (cached) {
      const hitResult = {
        executed: true,
        success: cached.success === true,
        query,
        raw_stdout: cached.raw_stdout ?? null,
        result_present: cached.result_present === true,
        empty_result: cached.empty_result === true,
        files: Array.isArray(cached.files) ? cached.files : [],
        code_context: null,
        grep_patterns: Array.isArray(cached.grep_patterns) ? cached.grep_patterns : [],
        diagnostics: cached.diagnostics && typeof cached.diagnostics === "object" ? { ...cached.diagnostics } : null,
        exit_code: cached.exit_code ?? null,
        stderr_summary: Array.isArray(cached.stderr_summary) ? cached.stderr_summary : [],
      };
      if (codeContextEnabled && hitResult.result_present && hitResult.files.length > 0) {
        hitResult.code_context = buildCodeContext(
          { files: hitResult.files },
          { budgetTokens: codeContextMaxTokens, projectRoot: cwd },
        );
      }
      hitResult.diagnostics = {
        ...stripReplayedJevDiagnostics(hitResult.diagnostics),
        cache_hit: true,
        cache_age_ms: Date.now() - cached.storedAt,
        cache_fingerprint: cacheFingerprint,
        cache_fingerprint_ms: cacheFingerprintMs,
      };
      return { search: hitResult, error: null, durationMs: Date.now() - cacheLookupStartedAt };
    }
  }

  const args = [scriptPath, "--project", cwd, "--query", query, "--json"];
  if (Number.isInteger(maxResults) && maxResults > 0) args.push("--max-results", String(maxResults));
  if (Number.isInteger(maxTurns) && maxTurns > 0) args.push("--max-turns", String(maxTurns));
  if (Number.isInteger(maxCommands)) args.push("--max-commands", String(maxCommands));
  if (Number.isInteger(treeDepth)) args.push("--tree-depth", String(treeDepth));
  for (const excludePath of excludePaths) args.push("--exclude", String(excludePath));
  if (repoMapMode) args.push("--repo-map-mode", String(repoMapMode));
  if (bootstrapMode) args.push("--bootstrap-mode", String(bootstrapMode));
  if (Number.isInteger(bootstrapTreeDepth)) args.push("--bootstrap-tree-depth", String(bootstrapTreeDepth));
  if (Number.isInteger(hotspotTopK)) args.push("--hotspot-top-k", String(hotspotTopK));
  if (Number.isInteger(hotspotTreeDepth)) args.push("--hotspot-tree-depth", String(hotspotTreeDepth));
  if (Number.isInteger(hotspotMaxBytes)) args.push("--hotspot-max-bytes", String(hotspotMaxBytes));
  if (Number.isInteger(bootstrapMaxTurns)) args.push("--bootstrap-max-turns", String(bootstrapMaxTurns));
  if (Number.isInteger(bootstrapMaxCommands)) args.push("--bootstrap-max-commands", String(bootstrapMaxCommands));
  if (noJevScreen === true) args.push("--no-jev-screen");
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

  const detachOnJsonLine = isDeferUsageFlushEnabled(env);
  const startedAt = Date.now();
  const commandResult = await runCommand("node", args, {
    cwd,
    timeoutMs,
    env,
    resolveOnJsonLine: detachOnJsonLine,
  });
  const durationMs = Date.now() - startedAt;

  result.exit_code = commandResult.detached === true ? 0 : commandResult.exitCode;
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

  if (codeContextEnabled && result.result_present && result.files.length > 0) {
    result.code_context = buildCodeContext(
      { files: result.files },
      { budgetTokens: codeContextMaxTokens, projectRoot: cwd },
    );
  }

  const failWithLocalFallback = (code, message) => {
    const error = buildError("yce-engine", code, message);
    if (isLocalFallbackEnabled(env)) {
      const fallback = runLocalFallback();
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

  if (commandResult.exitCode === 0 || commandResult.detached === true) {
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
      const markDetached = () => {
        if (commandResult.detached !== true) return;
        result.diagnostics = { ...(result.diagnostics || {}), usage_flush_detached: true };
      };
      if (result.result_present) {
        if (cacheConfig.enabled && cacheKey) {
          writeCacheEntry(
            cacheConfig.dir,
            cacheKey,
            {
              query,
              files: result.files,
              grep_patterns: result.grep_patterns,
              raw_stdout: result.raw_stdout,
              diagnostics: result.diagnostics,
              exit_code: result.exit_code,
              stderr_summary: result.stderr_summary,
              success: result.success,
              result_present: result.result_present,
              empty_result: result.empty_result,
            },
            cacheConfig.ttlMs,
          );
          result.diagnostics = {
            ...(result.diagnostics || {}),
            cache_hit: false,
            cache_age_ms: 0,
            cache_fingerprint: cacheFingerprint,
            cache_fingerprint_ms: cacheFingerprintMs,
          };
        }
        markDetached();
        return { search: result, error: null, durationMs };
      }
      markDetached();
      if (result.empty_result) {
        if (isLocalFallbackEnabled(env)) {
          const fallback = runLocalFallback();
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
        const fallback = runLocalFallback();
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
        const fallback = runLocalFallback();
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
    const fallback = runLocalFallback();
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
