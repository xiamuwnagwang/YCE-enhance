const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildError, isNonEmptyString } = require("../utils");
const {
  formatModelLabel,
  readJsonFile,
  resolveLocalModels,
  resolveYPlanConfigPath,
  resolveYPlanScript,
  runProcess,
  writeTempConfig,
} = require("./localModel");

function parseRunDir(stderr) {
  const match = String(stderr || "").match(/\[y-plan\] run dir:\s+(\S+)/);
  return match ? match[1] : "";
}

function parseRuntime(stdout) {
  const match = String(stdout || "").match(/^- Runtime:\s+(\S+)/m);
  return match ? match[1] : "";
}

function extractPlanText(stdout, runDir) {
  if (isNonEmptyString(runDir)) {
    const planFile = path.join(runDir, "plan.md");
    if (fs.existsSync(planFile)) {
      const text = fs.readFileSync(planFile, "utf8").trim();
      if (text) {
        return text;
      }
    }
  }
  const output = String(stdout || "");
  const yplan = output.match(/<y-plan\b[\s\S]*<\/y-plan>/i);
  if (yplan) {
    return yplan[0].trim();
  }
  const section = output.match(/## Plan\s*\n+([\s\S]*?)(?=\n## |\s*$)/);
  if (section && section[1].trim()) {
    return section[1].trim();
  }
  return output.trim();
}

function languagePrefix(language) {
  if (language === "zh-CN") {
    return "请用中文撰写计划。";
  }
  if (language === "en-US") {
    return "Write the plan in English.";
  }
  return "";
}

function buildLocalTask({ task, language }) {
  const prefix = languagePrefix(language);
  return prefix ? `${prefix}\n\n${task}` : task;
}

function buildLocalHistory({ history, searchContext, networkContext }) {
  const parts = [];
  if (isNonEmptyString(history)) {
    parts.push(String(history).trim());
  }
  if (isNonEmptyString(searchContext)) {
    parts.push(`[YCE search_context]\n${String(searchContext).trim()}`);
  }
  if (isNonEmptyString(networkContext)) {
    parts.push(`[YCE network_search]\n${String(networkContext).trim()}`);
  }
  return parts.join("\n\n");
}

function formatNetworkContext(networkSearch) {
  if (!networkSearch || networkSearch.result_present !== true) {
    return "";
  }
  const parts = [];
  if (Array.isArray(networkSearch.summaries)) {
    for (const item of networkSearch.summaries) {
      parts.push(typeof item === "string" ? item : JSON.stringify(item));
    }
  }
  if (Array.isArray(networkSearch.evidence)) {
    for (const item of networkSearch.evidence) {
      parts.push(typeof item === "string" ? item : JSON.stringify(item));
    }
  }
  return parts.join("\n");
}

async function runYPlanLocal({
  task,
  cwd,
  history,
  searchContext,
  networkContext,
  language,
  timeoutMs,
  customProvider,
  cliPath,
  skillRoot,
  configPath,
}) {
  const requestId = randomUUID();
  const plan = {
    executed: true,
    success: false,
    result_present: false,
    request_id: requestId,
    task,
    plan: null,
    search_used: isNonEmptyString(searchContext),
    status: null,
    custom_model: Boolean(customProvider),
    backend: "local",
    runtime: null,
    run_dir: null,
  };

  const scriptPath = resolveYPlanScript({ cliPath, skillRoot });
  if (!scriptPath) {
    return {
      plan,
      error: buildError(
        "y-plan",
        "DEPENDENCY_NOT_FOUND",
        "未找到本地 y-plan CLI。请安装 y-plan skill，或在 .env 设置 YCE_YPLAN_CLI 指向 scripts/y-plan.mjs。",
      ),
      durationMs: 0,
    };
  }

  const resolvedConfigPath = resolveYPlanConfigPath({
    configPath,
    scriptPath,
  });
  const sourceConfig = readJsonFile(resolvedConfigPath);
  const resolved = resolveLocalModels({
    sourceConfig,
    customProvider,
  });
  if (resolved.error) {
    return {
      plan,
      error: buildError("y-plan", "DEPENDENCY_NOT_FOUND", resolved.error),
      durationMs: 0,
    };
  }

  const budgetMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 480000;
  const localConfig = {
    ...sourceConfig,
    models: resolved.models,
    budgetMs,
    yce: {
      ...(sourceConfig.yce || {}),
      enabled: false,
    },
  };
  const tempConfigPath = writeTempConfig(localConfig);
  const startedAt = Date.now();
  try {
    const localTask = buildLocalTask({ task, language });
    const localHistory = buildLocalHistory({
      history,
      searchContext,
      networkContext,
    });
    const argsPrefix = scriptPath.endsWith(".mjs") || scriptPath.endsWith(".js")
      ? [scriptPath]
      : [];
    const bin = argsPrefix.length > 0 ? process.execPath : scriptPath;
    const args = [
      ...argsPrefix,
      "--cwd",
      cwd || process.cwd(),
      "--no-yce",
      "--budget-ms",
      String(budgetMs),
      "--config",
      tempConfigPath,
    ];
    if (localHistory) {
      args.push("--history", localHistory);
    }
    args.push(localTask);

    const result = await runProcess(bin, args, {
      cwd: cwd || process.cwd(),
      timeoutMs: budgetMs + 10000,
      onStderr: (text) => {
        process.stderr.write(text);
      },
    });
    const durationMs = Date.now() - startedAt;
    const runDir = parseRunDir(result.stderr);
    const runtime = parseRuntime(result.stdout) || formatModelLabel(resolved.models[0]);
    plan.run_dir = runDir || null;
    plan.runtime = runtime || null;
    plan.status = result.timedOut ? "timeout" : result.code === 0 ? "succeeded" : "failed";

    if (result.timedOut) {
      return {
        plan,
        error: buildError("y-plan", "TIMEOUT", `本地 Y-Plan 在 ${budgetMs}ms 后超时。`),
        durationMs,
      };
    }
    if (result.spawnError) {
      return {
        plan,
        error: buildError(
          "y-plan",
          "EXEC_ERROR",
          `无法启动本地 y-plan CLI：${result.spawnError.message}`,
        ),
        durationMs,
      };
    }

    const planText = extractPlanText(result.stdout, runDir);
    if (result.code !== 0 || !isNonEmptyString(planText)) {
      const detail = String(result.stderr || result.stdout || "")
        .trim()
        .slice(0, 800);
      return {
        plan,
        error: buildError(
          "y-plan",
          result.code === 0 ? "EMPTY_RESULT" : "EXEC_ERROR",
          detail || "本地 Y-Plan 没有返回计划内容。",
        ),
        durationMs,
      };
    }

    plan.success = true;
    plan.result_present = true;
    plan.plan = planText;
    plan.status = "succeeded";
    return { plan, error: null, durationMs };
  } finally {
    try {
      fs.unlinkSync(tempConfigPath);
    } catch {
      // ignore
    }
  }
}

async function runStdio() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const result = await runYPlanLocal(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module && process.argv.includes("--stdio")) {
  runStdio().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({
        plan: {
          executed: true,
          success: false,
          result_present: false,
          backend: "local",
        },
        error: {
          source: "y-plan",
          code: "EXEC_ERROR",
          message: error && error.message ? error.message : String(error),
        },
        durationMs: 0,
      })}\n`,
    );
    process.exit(1);
  });
}

module.exports = {
  buildLocalHistory,
  formatNetworkContext,
  runYPlanLocal,
};
