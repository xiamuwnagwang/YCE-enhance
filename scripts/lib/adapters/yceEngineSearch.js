const {
  buildError,
  detectQuotaError,
  fileExists,
  isDirectory,
  runLocalSearch,
  runCommand,
  summarizeText,
} = require("../utils");

function mapYceEngineFailure(text) {
  const t = text || "";
  if (/key discovery failed|windsurfAuthStatus|apiKey field is empty|database not found|API Key not found/i.test(t)) {
    return { code: "AUTH_ERROR", message: t.trim() || "YCE engine key discovery failed. Set YCE_API_KEY or ensure Windsurf is logged in." };
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

async function runYceEngineSearch({ query, cwd, scriptPath, timeoutMs, maxResults, maxTurns, env }) {
  const result = {
    executed: true,
    success: false,
    query,
    raw_stdout: null,
    result_present: false,
    empty_result: false,
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

  const args = [scriptPath, "--project", cwd, "--query", query];
  if (Number.isInteger(maxResults) && maxResults > 0) args.push("--max-results", String(maxResults));
  if (Number.isInteger(maxTurns) && maxTurns > 0) args.push("--max-turns", String(maxTurns));

  const startedAt = Date.now();
  const commandResult = await runCommand("node", args, { cwd, timeoutMs, env });
  const durationMs = Date.now() - startedAt;

  result.raw_stdout = commandResult.stdout || null;
  result.exit_code = commandResult.exitCode;
  result.stderr_summary = summarizeText(commandResult.stderr);

  if (commandResult.timedOut) {
    return {
      search: result,
      error: buildError("yce-engine", "TIMEOUT", `yce-engine search timed out after ${timeoutMs}ms.`),
      durationMs,
    };
  }

  if (commandResult.spawnError) {
    return {
      search: result,
      error: buildError("yce-engine", "EXEC_ERROR", commandResult.spawnError.message),
      durationMs,
    };
  }

  if (commandResult.exitCode === 0) {
    const stdout = (commandResult.stdout || "").trim();
    const semanticFailure = detectYceEngineSemanticFailure(commandResult.stdout, commandResult.stderr);
    if (semanticFailure) {
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
      return {
        search: result,
        error: buildError("yce-engine", semanticFailure.code, semanticFailure.message),
        durationMs,
      };
    }

    if (/Found 0 relevant files|No relevant files found/i.test(stdout) || !stdout) {
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

  const mapped = mapYceEngineFailure(commandResult.stderr || commandResult.stdout);
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
  return {
    search: result,
    error: buildError("yce-engine", mapped.code, mapped.message),
    durationMs,
  };
}

module.exports = {
  runYceEngineSearch,
};
