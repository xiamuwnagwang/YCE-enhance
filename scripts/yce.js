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
        total: 0,
      },
      dependency_paths: {
        yw_enhance_script: config.youwenScript,
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
  const query = normalizeQuery(args);
  const mode = String(args.mode || config.defaultMode || "auto").toLowerCase();
  const cwd = args.cwd ? ensureAbsolutePath(args.cwd) : process.cwd();
  const pretty = args["xml-pretty"] === true || args["json-pretty"] === true;

  if (args.help === true || args.h === true) {
    const payload = buildInvalidArgsResponse(
      "Usage: node scripts/yce.js \"<query>\" [--mode auto|enhance|search|network] [--with-network] [--network-profile quick|balanced|exhaustive] [--library <name>] [--repo <owner/name>] [--history <text>] [--cwd <path>] [--xml-pretty] [--timeout-enhance-ms <n>] [--timeout-search-ms <n>] [--timeout-network-ms <n>] [--max-turns 1-5] [--max-commands 1-20] [--max-results 1-30] [--tree-depth 0-6] [--exclude <glob[,glob]>] [--repo-map-mode classic|bootstrap_hotspot] [--bootstrap-enabled true|false|--no-bootstrap] [--bootstrap-tree-depth 1-3] [--hotspot-top-k 0-8] [--hotspot-tree-depth 1-4] [--hotspot-max-bytes 16384-256000] [--bootstrap-max-turns 1-5] [--bootstrap-max-commands 1-20] [--no-search] [--raw-events] [--json-pretty (legacy alias)]",
      config,
      cwd
    );
    console.log(serializeForStdout(payload, true));
    process.exit(0);
  }

  if (!["auto", "enhance", "search", "network"].includes(mode)) {
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

  const timeoutEnhanceMs = toPositiveInt(args["timeout-enhance-ms"], config.timeoutEnhanceMs);
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
      withNetwork: args["with-network"] === true,
      networkOptions: {
        profile: networkProfile,
        library:
          typeof args.library === "string" ? args.library.trim() : "",
        repo: typeof args.repo === "string" ? args.repo.trim() : "",
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

    console.log(serializeForStdout(result, pretty));
    process.exit(result.success ? 0 : 1);
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
          total: 0,
        },
        dependency_paths: {
          yw_enhance_script: config.youwenScript,
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
