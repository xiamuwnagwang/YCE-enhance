#!/usr/bin/env node

const {
  ensureAbsolutePath,
  isDirectory,
  loadRuntimeConfig,
  normalizeQuery,
  normalizeExcludePaths,
  parseArgs,
  serializeForStdout,
  toBoolean,
  toBoundedInt,
  toPositiveInt,
} = require("./lib/utils");
const { orchestrate } = require("./lib/orchestrator");
const { checkForUpdate, formatUpdateBanner } = require("./lib/versionCheck");
const { buildSummary, exitCodeFor } = require("./lib/resultGate");
const { buildReceipt, resolveResultPath, writeResultFile } = require("./lib/resultSink");

/**
 * Results go to a file and stdout gets a small receipt, because a host can
 * truncate long stdout before the agent sees it and the truncated text gives
 * the reader no way to notice. --stdout-xml restores the old piping behaviour.
 */
function emitResult(result, { pretty, stdoutXml, outArg, mode }) {
  const xml = serializeForStdout(result, stdoutXml ? pretty : true);
  const summary = buildSummary(xml);
  const exitCode = exitCodeFor(summary);

  if (stdoutXml) {
    console.log(xml);
    return exitCode;
  }

  let written;
  try {
    written = writeResultFile(xml, resolveResultPath({ outArg, mode }));
  } catch (error) {
    console.error(
      `⚠ 无法写入结果文件（${error && error.message ? error.message : error}），回退到 stdout；请注意主机可能截断。`,
    );
    console.log(xml);
    return exitCode;
  }

  console.log(buildReceipt(summary, written, exitCode));
  return exitCode;
}

function buildInvalidArgsResponse(message, config, cwd) {
  return {
    success: false,
    mode: null,
    resolved_action: null,
    original_query: null,
    cwd,
    enhance: null,
    search: null,
    network_search: null,
    plan: null,
    errors: [
      {
        source: "cli",
        code: "INVALID_ARGS",
        message,
      },
    ],
    meta: {
      durations_ms: {
        enhance: 0,
        search: 0,
        network: 0,
        plan: 0,
        total: 0,
      },
      dependency_paths: {
        prompt_enhance_script: config.promptEnhanceScript,
        yce_engine_script: config.yceEngineScript,
      },
      timestamp: new Date().toISOString(),
    },
  };
}

function parseBootstrapEnabled(args, fallback) {
  if (args["no-bootstrap"] === true) return false;
  if (args["bootstrap-enabled"] === undefined) return fallback;
  const value = args["bootstrap-enabled"];
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (!["1", "true", "yes", "on", "0", "false", "no", "off"].includes(normalized)) {
    throw new RangeError("bootstrap-enabled must be true or false.");
  }
  return toBoolean(value, fallback);
}

function buildSearchOptions(args, config) {
  const repoMapMode = String(args["repo-map-mode"] || config.yceEngineRepoMapMode).trim();
  if (!["classic", "bootstrap_hotspot"].includes(repoMapMode)) {
    throw new RangeError("repo-map-mode must be classic or bootstrap_hotspot.");
  }
  return {
    maxTurns: toBoundedInt(args["max-turns"], { name: "max-turns", min: 1, max: 5, fallback: config.yceEngineMaxTurns }),
    maxCommands: toBoundedInt(args["max-commands"], { name: "max-commands", min: 1, max: 20, fallback: config.yceEngineMaxCommands }),
    maxResults: toBoundedInt(args["max-results"], { name: "max-results", min: 1, max: 30, fallback: config.yceEngineMaxResults }),
    treeDepth: toBoundedInt(args["tree-depth"], { name: "tree-depth", min: 0, max: 6, fallback: config.yceEngineTreeDepth }),
    excludePaths: args.exclude === undefined ? config.yceEngineExcludePaths : normalizeExcludePaths(args.exclude),
    repoMapMode,
    bootstrapEnabled: parseBootstrapEnabled(args, config.yceEngineBootstrapEnabled),
    bootstrapTreeDepth: toBoundedInt(args["bootstrap-tree-depth"], { name: "bootstrap-tree-depth", min: 1, max: 3, fallback: config.yceEngineBootstrapTreeDepth }),
    hotspotTopK: toBoundedInt(args["hotspot-top-k"], { name: "hotspot-top-k", min: 0, max: 8, fallback: config.yceEngineHotspotTopK }),
    hotspotTreeDepth: toBoundedInt(args["hotspot-tree-depth"], { name: "hotspot-tree-depth", min: 1, max: 4, fallback: config.yceEngineHotspotTreeDepth }),
    hotspotMaxBytes: toBoundedInt(args["hotspot-max-bytes"], { name: "hotspot-max-bytes", min: 16 * 1024, max: 250 * 1024, fallback: config.yceEngineHotspotMaxBytes }),
    bootstrapMaxTurns: toBoundedInt(args["bootstrap-max-turns"], { name: "bootstrap-max-turns", min: 1, max: 5, fallback: config.yceEngineBootstrapMaxTurns }),
    bootstrapMaxCommands: toBoundedInt(args["bootstrap-max-commands"], { name: "bootstrap-max-commands", min: 1, max: 20, fallback: config.yceEngineBootstrapMaxCommands }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadRuntimeConfig();
  const cwd = args.cwd ? ensureAbsolutePath(args.cwd) : process.cwd();

  // 任务卡子命令：node scripts/yce.js task <show|list|check|done|new> ...
  if (args._[0] === "task") {
    const { runTaskCommand } = require("./lib/taskCli");
    const outcome = runTaskCommand(args, cwd);
    console.log(outcome.output);
    process.exit(outcome.exitCode);
  }

  const query = normalizeQuery(args);
  const mode = String(args.mode || config.defaultMode || "auto").toLowerCase();
  const pretty = args["xml-pretty"] === true || args["json-pretty"] === true;

  if (args.help === true || args.h === true) {
    const payload = buildInvalidArgsResponse(
      "Usage: node scripts/yce.js \"<query>\" [--mode auto|enhance|search|network|plan] [--task <id>|--no-task] [--with-network] [--network-profile quick|balanced|exhaustive] [--library <name>] [--repo <owner/name>] [--history <text>] [--cwd <path>] [--out <file|dir>] [--stdout-xml] [--xml-pretty] [--timeout-enhance-ms <n>] [--timeout-search-ms <n>] [--timeout-network-ms <n>] [--timeout-plan-ms <n>] [--with-search (plan)] [--search-context <text> (plan)] [--save <dir|file.md> (plan)] [--enable-web-search|--no-web-search (plan)] [--language zh-CN|en-US (plan)] [--plan-provider claude|openai|openai-responses|gemini] [--plan-base-url <url>] [--plan-token <token>] [--plan-model <model>] [--plan-temperature <n>] [--max-turns 1-5] [--max-commands 1-20] [--max-results 1-30] [--tree-depth 0-6] [--exclude <glob[,glob]>] [--repo-map-mode classic|bootstrap_hotspot] [--bootstrap-enabled true|false|--no-bootstrap] [--bootstrap-tree-depth 1-3] [--hotspot-top-k 0-8] [--hotspot-tree-depth 1-4] [--hotspot-max-bytes 16384-256000] [--bootstrap-max-turns 1-5] [--bootstrap-max-commands 1-20] [--no-search] [--raw-events] [--json-pretty (legacy alias)] | node scripts/yce.js task <show [id]|list|check <n> --evidence <text>|done [--force]|new --goal <text> [--accept <text>]...> [--task <id>] [--cwd <path>]",
      config,
      cwd
    );
    console.log(serializeForStdout(payload, true));
    process.exit(0);
  }

  if (!["auto", "enhance", "search", "network", "plan"].includes(mode)) {
    const payload = buildInvalidArgsResponse(`Unsupported mode: ${mode}`, config, cwd);
    console.log(serializeForStdout(payload, pretty));
    process.exit(1);
  }

  if (!query) {
    const payload = buildInvalidArgsResponse("Missing required query argument.", config, cwd);
    console.log(serializeForStdout(payload, pretty));
    process.exit(1);
  }

  if (!isDirectory(cwd)) {
    const payload = buildInvalidArgsResponse(`cwd does not exist or is not a directory: ${cwd}`, config, cwd);
    console.log(serializeForStdout(payload, pretty));
    process.exit(1);
  }

  const timeoutEnhanceMs = toPositiveInt(
    args["timeout-enhance-ms"],
    mode === "enhance" ? config.timeoutEnhanceMs : config.timeoutAutoEnhanceMs,
  );
  const timeoutSearchMs = toPositiveInt(args["timeout-search-ms"], config.timeoutSearchMs);
  const timeoutNetworkMs = toPositiveInt(
    args["timeout-network-ms"],
    config.timeoutNetworkMs,
  );
  const networkProfile = String(args["network-profile"] || "balanced").toLowerCase();
  if (!["quick", "balanced", "exhaustive"].includes(networkProfile)) {
    const payload = buildInvalidArgsResponse(
      "network-profile must be quick, balanced, or exhaustive.",
      config,
      cwd,
    );
    console.log(serializeForStdout(payload, pretty));
    process.exit(1);
  }

  const timeoutPlanMs = toPositiveInt(args["timeout-plan-ms"], config.timeoutPlanMs);
  const planLanguage = typeof args.language === "string" ? args.language.trim() : "";
  if (planLanguage && !["zh-CN", "en-US"].includes(planLanguage)) {
    const payload = buildInvalidArgsResponse(
      "language must be zh-CN or en-US.",
      config,
      cwd,
    );
    console.log(serializeForStdout(payload, pretty));
    process.exit(1);
  }
  let planEnableWebSearch;
  if (args["enable-web-search"] === true) {
    planEnableWebSearch = true;
  }
  if (args["no-web-search"] === true) {
    planEnableWebSearch = false;
  }
  const planCustomProviderFlags = {
    provider: typeof args["plan-provider"] === "string" ? args["plan-provider"].trim() : "",
    baseUrl: typeof args["plan-base-url"] === "string" ? args["plan-base-url"].trim() : "",
    token: typeof args["plan-token"] === "string" ? args["plan-token"].trim() : "",
    model: typeof args["plan-model"] === "string" ? args["plan-model"].trim() : "",
    temperature: args["plan-temperature"],
  };
  const hasPlanProviderFlags = Boolean(
    planCustomProviderFlags.provider ||
      planCustomProviderFlags.baseUrl ||
      planCustomProviderFlags.token ||
      planCustomProviderFlags.model,
  );
  let searchOptions;
  try {
    searchOptions = buildSearchOptions(args, config);
  } catch (error) {
    const payload = buildInvalidArgsResponse(error.message, config, cwd);
    console.log(serializeForStdout(payload, pretty));
    process.exit(1);
  }

  const skillRootDir = require("path").resolve(__dirname, "..");

  try {
    // 每次调用先做版本检测：服务端版本升高则立刻提示升级。
    const updateCheckPromise = checkForUpdate({ rootDir: skillRootDir }).catch(() => null);
    let updateBannerPrinted = false;
    try {
      const earlyInfo = await Promise.race([
        updateCheckPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 800)),
      ]);
      const earlyBanner = formatUpdateBanner(earlyInfo);
      if (earlyBanner) {
        console.error(earlyBanner);
        updateBannerPrinted = true;
      }
    } catch {}

    const result = await orchestrate({
      mode,
      query,
      cwd,
      history: args.history,
      noSearch: args["no-search"] === true,
      rawEvents: args["raw-events"] === true,
      timeoutEnhanceMs,
      timeoutSearchMs,
      timeoutNetworkMs,
      timeoutPlanMs,
      withNetwork: args["with-network"] === true,
      networkOptions: {
        profile: networkProfile,
        library:
          typeof args.library === "string" ? args.library.trim() : "",
        repo: typeof args.repo === "string" ? args.repo.trim() : "",
      },
      planOptions: {
        withSearch: args["with-search"] === true,
        searchContext:
          typeof args["search-context"] === "string" ? args["search-context"] : "",
        enableWebSearch: planEnableWebSearch,
        language: planLanguage,
        customProvider: hasPlanProviderFlags ? planCustomProviderFlags : null,
        savePath: typeof args.save === "string" ? args.save.trim() : "",
      },
      taskOptions: {
        taskId: typeof args.task === "string" ? args.task.trim() : "",
        noTask: args["no-task"] === true,
      },
      searchOptions,
      config,
    });

    const degradation = result && result.meta ? result.meta.degradation : null;
    if (degradation && degradation.active === true) {
      console.error(`⚠ ${degradation.summary}`);
      if (degradation.error && degradation.error.message) {
        const errorCode = degradation.error.code ? `[${degradation.error.code}] ` : "";
        console.error(`⚠ 上游增强错误: ${errorCode}${degradation.error.message}`);
      }
    }

    const quotaError = Array.isArray(result && result.errors)
      ? result.errors.find((e) => e && e.code === "QUOTA_EXCEEDED")
      : null;
    if (quotaError) {
      console.error("");
      console.error("==================================================");
      console.error("❌ yce 额度已用尽（QUOTA_EXCEEDED）");
      console.error(`   来源: ${quotaError.source}`);
      console.error(`   详情: ${quotaError.message}`);
      console.error("   请充值或更换账号后重试。");
      console.error("==================================================");
    }

    // 开头未拿到结果时，结束前再补一次提示
    if (!updateBannerPrinted) {
      try {
        const updateInfo = await Promise.race([
          updateCheckPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 300)),
        ]);
        const banner = formatUpdateBanner(updateInfo);
        if (banner) console.error(banner);
      } catch {}
    }

    process.exit(
      emitResult(result, {
        pretty,
        stdoutXml: args["stdout-xml"] === true,
        outArg: typeof args.out === "string" ? args.out : "",
        mode,
      }),
    );
  } catch (error) {
    const payload = {
      success: false,
      mode,
      resolved_action: null,
      original_query: query,
      cwd,
      enhance: null,
      search: null,
      network_search: null,
      plan: null,
      errors: [
        {
          source: "cli",
          code: "EXEC_ERROR",
          message: error && error.message ? error.message : "Unexpected YCE failure.",
        },
      ],
      meta: {
        durations_ms: {
          enhance: 0,
          search: 0,
          network: 0,
          plan: 0,
          total: 0,
        },
        dependency_paths: {
          prompt_enhance_script: config.promptEnhanceScript,
          yce_engine_script: config.yceEngineScript,
        },
        timestamp: new Date().toISOString(),
      },
    };
    console.log(serializeForStdout(payload, pretty));
    process.exit(1);
  }
}

main();
