const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildError,
  detectQuotaError,
  ensureYceToolConfigFile,
  fileExists,
  isDirectory,
  runCommand,
  summarizeText,
} = require("../utils");

function mapYceFailure(stderrText) {
  const text = stderrText || "";
  // 1. 优先匹配上游结构化 code（relay 在额度耗尽时返回 {"code":"QUOTA_EXCEEDED", ...}）
  if (/"code"\s*:\s*"QUOTA_EXCEEDED"/i.test(text)) {
    let upstreamMsg = "";
    const m = text.match(/"error"\s*:\s*"([^"]+)"/i);
    if (m) upstreamMsg = m[1];
    return {
      code: "QUOTA_EXCEEDED",
      message: `yce 额度已用尽：${upstreamMsg || text.trim() || "上游返回 QUOTA_EXCEEDED"}`,
    };
  }
  // 2. 回退到关键词启发式匹配
  if (detectQuotaError(text)) {
    return { code: "QUOTA_EXCEEDED", message: `yce 额度已用尽：${text.trim() || "上游返回额度/配额耗尽"}` };
  }
  if (
    /Failed to fetch from config server/i.test(text) ||
    /CONFIG_ENCRYPTION_KEY/i.test(text) ||
    /Attempting to use config file values as direct backend/i.test(text)
  ) {
    return { code: "CONFIG_ERROR", message: text.trim() || "YCE remote configuration is invalid." };
  }
  if (/Configuration file not found/i.test(text)) {
    return { code: "CONFIG_ERROR", message: text.trim() || "YCE configuration file not found." };
  }
  if (/Binary not found/i.test(text) || /not executable/i.test(text)) {
    return { code: "DEPENDENCY_NOT_FOUND", message: text.trim() || "YCE binary dependency is missing." };
  }
  return { code: "EXEC_ERROR", message: text.trim() || "YCE search execution failed." };
}

function buildYceBinaryArgs(query, configPath, cliOptions = {}) {
  const args = ["--config", configPath];

  if (Number.isInteger(cliOptions.maxLinesPerBlob) && cliOptions.maxLinesPerBlob > 0) {
    args.push("--max-lines-per-blob", String(cliOptions.maxLinesPerBlob));
  }

  if (Number.isInteger(cliOptions.uploadTimeout) && cliOptions.uploadTimeout > 0) {
    args.push("--upload-timeout", String(cliOptions.uploadTimeout));
  }

  if (Number.isInteger(cliOptions.uploadConcurrency) && cliOptions.uploadConcurrency > 0) {
    args.push("--upload-concurrency", String(cliOptions.uploadConcurrency));
  }

  if (Number.isInteger(cliOptions.retrievalTimeout) && cliOptions.retrievalTimeout > 0) {
    args.push("--retrieval-timeout", String(cliOptions.retrievalTimeout));
  }

  if (cliOptions.noAdaptive === true) {
    args.push("--no-adaptive");
  }

  if (cliOptions.noWebbrowserEnhancePrompt === true) {
    args.push("--no-webbrowser-enhance-prompt");
  }

  args.push("--search-context", query);
  return args;
}

function normalizeYceBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string") {
    return null;
  }

  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    return null;
  }

  const pathname = parsed.pathname || "";
  const isOriginOnly = pathname === "" || pathname === "/";
  const isRelayPath = pathname === "/relay" || /^\/relay\/+$/.test(pathname);
  const isLegacyWorkaround = /^\/api\/v1\/\.\.\/\.\.\/?$/.test(pathname);

  if (!isOriginOnly && !isRelayPath && !isLegacyWorkaround) {
    return null;
  }

  parsed.pathname = "/relay/";
  return parsed.toString();
}

function materializeYceConfig(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    return {
      configPath,
      tempConfigPath: null,
      error: buildError("yce", "CONFIG_ERROR", `Failed to parse YCE config JSON: ${error.message}`),
    };
  }

  const normalizedBaseUrl = normalizeYceBaseUrl(parsed.base_url);
  if (!normalizedBaseUrl || normalizedBaseUrl === parsed.base_url) {
    return { configPath, tempConfigPath: null, error: null };
  }

  const tempConfigPath = path.join(os.tmpdir(), `yce-tool-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const patched = { ...parsed, base_url: normalizedBaseUrl };

  try {
    fs.writeFileSync(tempConfigPath, `${JSON.stringify(patched, null, 2)}\n`, "utf8");
  } catch (error) {
    return {
      configPath,
      tempConfigPath: null,
      error: buildError("yce", "CONFIG_ERROR", `Failed to write temporary YCE config: ${error.message}`),
    };
  }

  return { configPath: tempConfigPath, tempConfigPath, error: null };
}

async function runYceSearch({ query, cwd, scriptPath, timeoutMs }) {
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
      error: buildError("yce", "DEPENDENCY_NOT_FOUND", `YCE search script not found: ${scriptPath}`),
      durationMs: 0,
    };
  }

  if (!isDirectory(cwd)) {
    return {
      search: result,
      error: buildError("yce", "INVALID_ARGS", `Search cwd does not exist or is not a directory: ${cwd}`),
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const wrapperEnv = timeoutMs
    ? { YCE_TIMEOUT: String(Math.max(1, Math.ceil(timeoutMs / 1000))) }
    : undefined;
  const commandResult = await runCommand("bash", [scriptPath, query], { cwd, timeoutMs, env: wrapperEnv });
  const durationMs = Date.now() - startedAt;

  result.raw_stdout = commandResult.stdout || null;
  result.exit_code = commandResult.exitCode;
  result.stderr_summary = summarizeText(commandResult.stderr);

  if (commandResult.timedOut) {
    return {
      search: result,
      error: buildError("yce", "TIMEOUT", `YCE search timed out after ${timeoutMs}ms.`),
      durationMs,
    };
  }

  if (commandResult.spawnError) {
    return {
      search: result,
      error: buildError("yce", "EXEC_ERROR", commandResult.spawnError.message),
      durationMs,
    };
  }

  if (commandResult.exitCode === 0) {
    result.success = true;
    result.result_present = Boolean((commandResult.stdout || "").trim());
    return { search: result, error: null, durationMs };
  }

  if (commandResult.exitCode === 3) {
    result.success = true;
    result.empty_result = true;
    return {
      search: result,
      error: buildError("yce", "EMPTY_RESULT", "YCE search completed but returned no results."),
      durationMs,
    };
  }

  const mapped = mapYceFailure(commandResult.stderr || commandResult.stdout);
  return {
    search: result,
    error: buildError("yce", mapped.code, mapped.message),
    durationMs,
  };
}

async function runYceBinarySearch({ query, cwd, binaryPath, configPath, timeoutMs, cliOptions }) {
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

  if (!fileExists(binaryPath)) {
    return {
      search: result,
      error: buildError("yce", "DEPENDENCY_NOT_FOUND", `YCE binary not found: ${binaryPath}`),
      durationMs: 0,
    };
  }

  const resolvedConfigPath = ensureYceToolConfigFile(configPath);
  if (!fileExists(resolvedConfigPath)) {
    return {
      search: result,
      error: buildError("yce", "CONFIG_ERROR", `YCE config not found: ${resolvedConfigPath}`),
      durationMs: 0,
    };
  }

  if (!isDirectory(cwd)) {
    return {
      search: result,
      error: buildError("yce", "INVALID_ARGS", `Search cwd does not exist or is not a directory: ${cwd}`),
      durationMs: 0,
    };
  }

  const materialized = materializeYceConfig(resolvedConfigPath);
  if (materialized.error) {
    return {
      search: result,
      error: materialized.error,
      durationMs: 0,
    };
  }

  const runtimeConfigPath = materialized.configPath;
  const startedAt = Date.now();
  let commandResult;
  try {
    commandResult = await runCommand(binaryPath, buildYceBinaryArgs(query, runtimeConfigPath, cliOptions), {
      cwd,
      timeoutMs,
    });
  } finally {
    if (materialized.tempConfigPath) {
      try {
        fs.unlinkSync(materialized.tempConfigPath);
      } catch {
        // ignore temp cleanup failures
      }
    }
  }
  const durationMs = Date.now() - startedAt;

  result.raw_stdout = commandResult.stdout || null;
  result.exit_code = commandResult.exitCode;
  result.stderr_summary = summarizeText(commandResult.stderr);

  if (commandResult.timedOut) {
    return {
      search: result,
      error: buildError("yce", "TIMEOUT", `YCE search timed out after ${timeoutMs}ms.`),
      durationMs,
    };
  }

  if (commandResult.spawnError) {
    return {
      search: result,
      error: buildError("yce", "EXEC_ERROR", commandResult.spawnError.message),
      durationMs,
    };
  }

  if (commandResult.exitCode === 0) {
    result.success = true;
    result.result_present = Boolean((commandResult.stdout || "").trim());
    return { search: result, error: null, durationMs };
  }

  if (!result.result_present && !result.raw_stdout && /no results|empty output/i.test(commandResult.stderr || "")) {
    result.success = true;
    result.empty_result = true;
    return {
      search: result,
      error: buildError("yce", "EMPTY_RESULT", "YCE search completed but returned no results."),
      durationMs,
    };
  }

  const mapped = mapYceFailure(commandResult.stderr || commandResult.stdout);
  return {
    search: result,
    error: buildError("yce", mapped.code, mapped.message),
    durationMs,
  };
}

module.exports = {
  runYceBinarySearch,
  runYceSearch,
};
