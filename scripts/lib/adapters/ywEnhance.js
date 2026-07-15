const {
  buildError,
  detectQuotaError,
  extractEnhancedBlock,
  fileExists,
  isNonEmptyString,
  parseEnhancedContent,
  runCommand,
  summarizeText,
} = require("../utils");

function buildBaseArgs(scriptPath, prompt, options = {}) {
  const args = [scriptPath, "enhance", prompt, "--auto-confirm", "--auto-skills"];
  if (options.history) {
    args.push("--history", options.history);
  }
  if (options.noSearch) {
    args.push("--no-search");
  }
  return args;
}

function summarizeEvents(stdoutText) {
  try {
    const events = JSON.parse(stdoutText);
    if (!Array.isArray(events)) {
      throw new Error("raw events is not an array");
    }
    const eventTypes = [];
    for (const item of events) {
      if (item && typeof item.event === "string" && !eventTypes.includes(item.event)) {
        eventTypes.push(item.event);
      }
    }
    return {
      captured: true,
      event_count: events.length,
      event_types: eventTypes,
      preview: events.slice(0, 10).map((item) => ({
        event: item.event || null,
        keys: item && item.data && typeof item.data === "object" ? Object.keys(item.data).slice(0, 6) : [],
      })),
    };
  } catch (error) {
    return {
      captured: false,
      error: error.message,
    };
  }
}

async function captureRawEvents(scriptPath, prompt, options, timeoutMs, env) {
  const args = buildBaseArgs(scriptPath, prompt, options);
  args.push("--json");
  const commandResult = await runCommand("node", args, { timeoutMs, env });
  if (commandResult.timedOut) {
    return { captured: false, error: `Timed out after ${timeoutMs}ms.` };
  }
  if (commandResult.spawnError) {
    return { captured: false, error: commandResult.spawnError.message };
  }
  if (commandResult.exitCode !== 0) {
    return {
      captured: false,
      error: summarizeText(commandResult.stderr || commandResult.stdout).join(" | ") || `Exit ${commandResult.exitCode}`,
    };
  }
  return summarizeEvents(commandResult.stdout);
}

async function runYwEnhance({ prompt, history, scriptPath, timeoutMs, noSearch, rawEvents, env }) {
  const enhance = {
    executed: true,
    success: false,
    prompt: null,
    recommended_skills: [],
    raw_stdout: null,
    stderr_summary: [],
    used_history: isNonEmptyString(history),
  };

  if (!fileExists(scriptPath)) {
    return {
      enhance,
      error: buildError("yw-enhance", "DEPENDENCY_NOT_FOUND", `yw-enhance script not found: ${scriptPath}`),
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const args = buildBaseArgs(scriptPath, prompt, { history, noSearch });
  const commandResult = await runCommand("node", args, { timeoutMs, env });
  const durationMs = Date.now() - startedAt;

  enhance.raw_stdout = commandResult.stdout || null;
  enhance.stderr_summary = summarizeText(commandResult.stderr);

  if (commandResult.timedOut) {
    if (rawEvents) {
      enhance.raw_events_summary = { captured: false, error: `Timed out after ${timeoutMs}ms.` };
    }
    return {
      enhance,
      error: buildError("yw-enhance", "TIMEOUT", `yw-enhance timed out after ${timeoutMs}ms.`),
      durationMs,
    };
  }

  if (commandResult.spawnError) {
    if (rawEvents) {
      enhance.raw_events_summary = { captured: false, error: commandResult.spawnError.message };
    }
    return {
      enhance,
      error: buildError("yw-enhance", "EXEC_ERROR", commandResult.spawnError.message),
      durationMs,
    };
  }

  if (commandResult.exitCode !== 0) {
    if (rawEvents) {
      enhance.raw_events_summary = await captureRawEvents(scriptPath, prompt, { history, noSearch }, timeoutMs, env);
    }
    const errText = summarizeText(commandResult.stderr || commandResult.stdout).join(" | ") || `yw-enhance exited with code ${commandResult.exitCode}`;
    const combined = `${commandResult.stderr || ""}\n${commandResult.stdout || ""}`;
    const isQuota = /"code"\s*:\s*"QUOTA_EXCEEDED"/i.test(combined) || detectQuotaError(combined);
    return {
      enhance,
      error: buildError(
        "yw-enhance",
        isQuota ? "QUOTA_EXCEEDED" : "EXEC_ERROR",
        isQuota ? `yce 额度已用尽：${errText}` : errText
      ),
      durationMs,
    };
  }

  const enhancedContent = extractEnhancedBlock(commandResult.stdout);
  if (!enhancedContent) {
    if (rawEvents) {
      enhance.raw_events_summary = await captureRawEvents(scriptPath, prompt, { history, noSearch }, timeoutMs, env);
    }
    return {
      enhance,
      error: buildError("yw-enhance", "PARSE_ERROR", "Failed to parse <enhanced> block from yw-enhance output."),
      durationMs,
    };
  }

  const parsed = parseEnhancedContent(enhancedContent);
  enhance.success = true;
  enhance.prompt = parsed.prompt;
  enhance.recommended_skills = parsed.recommendedSkills;

  if (rawEvents) {
    enhance.raw_events_summary = await captureRawEvents(scriptPath, prompt, { history, noSearch }, timeoutMs, env);
  }

  return {
    enhance,
    error: null,
    durationMs,
  };
}

module.exports = {
  runYwEnhance,
};
