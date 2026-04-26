#!/usr/bin/env node

const {
  ensureAbsolutePath,
  isDirectory,
  loadRuntimeConfig,
  normalizeQuery,
  parseArgs,
  serializeForStdout,
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
        total: 0,
      },
      dependency_paths: {
        yw_enhance_script: config.youwenScript,
        yce_search_script: config.yceSearchScript,
        yce_binary: config.yceBinary || null,
        yce_config: config.yceConfig || null,
      },
      timestamp: new Date().toISOString(),
    },
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
      "Usage: node scripts/yce.js \"<query>\" [--mode auto|enhance|search] [--history <text>] [--cwd <path>] [--xml-pretty] [--timeout-enhance-ms <n>] [--timeout-search-ms <n>] [--no-search] [--raw-events] [--json-pretty (legacy alias)]",
      config,
      cwd
    );
    console.log(serializeForStdout(payload, true));
    process.exit(0);
  }

  if (!["auto", "enhance", "search"].includes(mode)) {
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

  try {
    const updateCheckPromise = checkForUpdate({
      rootDir: require("path").resolve(__dirname, ".."),
    }).catch(() => null);

    const result = await orchestrate({
      mode,
      query,
      cwd,
      history: args.history,
      noSearch: args["no-search"] === true,
      rawEvents: args["raw-events"] === true,
      timeoutEnhanceMs,
      timeoutSearchMs,
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

    try {
      const updateInfo = await Promise.race([
        updateCheckPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      const banner = formatUpdateBanner(updateInfo);
      if (banner) {
        console.error(banner);
      }
    } catch {}

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
          total: 0,
        },
        dependency_paths: {
          yw_enhance_script: config.youwenScript,
          yce_search_script: config.yceSearchScript,
          yce_binary: config.yceBinary || null,
          yce_config: config.yceConfig || null,
        },
        timestamp: new Date().toISOString(),
      },
    };
    console.log(serializeForStdout(payload, pretty));
    process.exit(1);
  }
}

main();
