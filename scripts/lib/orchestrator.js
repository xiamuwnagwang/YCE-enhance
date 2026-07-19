const { runYwEnhance } = require("./adapters/ywEnhance");
const { runYceEngineSearch } = require("./adapters/yceEngineSearch");
const { runNetworkSearch } = require("./adapters/networkSearch");
const { buildError, normalizeSearchQuery, nowIso } = require("./utils");

const SEARCH_KEYWORDS = [
  "搜索代码", "找文件", "定位实现", "在哪", "哪里", "函数", "类", "接口", "api", "组件", "模块",
  "provider", "route", "handler", "实现", "逻辑", "代码", "文件", "settings", "模型列表",
];

const ENHANCE_KEYWORDS = [
  "优化提示词", "提示词增强", "增强", "改写", "整理需求", "润色", "补全上下文", "更好理解", "优化这个任务", "prompt",
];

const AMBIGUOUS_MARKERS = ["这个", "这里", "那块", "相关逻辑", "对应地方", "这块", "那个", "它", "帮我看看"];

// External-fact / live-web intent. Used by auto to optionally attach network search.
// Keep this list specific: do not add bare "文档" / "docs" (often means in-repo docs).
const NETWORK_KEYWORDS = [
  "联网", "联网搜索", "联网检索", "网上搜", "网上查", "搜一下最新", "查最新", "查一下最新",
  "最新", "实时", "热点", "官网", "官方文档", "外部资料", "外部事实", "竞品", "最佳实践",
  "发布说明", "版本说明", "有没有新版本", "上游版本", "联网调研",
  "latest", "up to date", "up-to-date", "current version", "official docs", "official documentation",
  "web search", "internet", "online", "news", "changelog", "release notes", "best practices",
  "compare with", "external source", "external fact",
];

const MISSING_YOUWEN_TOKEN_MESSAGE =
  "缺少 Youwen 增强密钥：请在 vendor/yce/.env 设置 YCE_YOUWEN_TOKEN（或环境变量 YOUWEN_TOKEN）。未配置时不会调用 enhance。";

function containsAny(text, keywords) {
  const lowerText = String(text || "").toLowerCase();
  return keywords.some((keyword) => lowerText.includes(String(keyword).toLowerCase()));
}

function hasSearchIntent(query) {
  return containsAny(query, SEARCH_KEYWORDS);
}

function hasNetworkIntent(query) {
  return containsAny(query, NETWORK_KEYWORDS);
}

function resolveAction(mode, query) {
  if (mode === "enhance") {
    return "enhance";
  }
  if (mode === "search") {
    return "search";
  }
  if (mode === "network") {
    return "network_search";
  }

  const searchIntent = hasSearchIntent(query);
  const hasEnhanceIntent = containsAny(query, ENHANCE_KEYWORDS);
  const hasAmbiguity = containsAny(query, AMBIGUOUS_MARKERS);
  const networkIntent = hasNetworkIntent(query);

  // Pure external-fact auto: do not force a local code search path.
  if (networkIntent && !searchIntent) {
    return "network_search";
  }

  if (searchIntent && hasAmbiguity) {
    return "enhance_then_search";
  }

  if (searchIntent && hasEnhanceIntent) {
    return "enhance_then_search";
  }

  if (searchIntent) {
    return "search";
  }

  return "enhance";
}

function hasYouwenToken(config) {
  if (config && config.hasYouwenToken === true) {
    return true;
  }
  const env = config && config.ywEnhanceEnv ? config.ywEnhanceEnv : {};
  return Boolean(
    (env.YOUWEN_TOKEN && String(env.YOUWEN_TOKEN).trim()) ||
      (process.env.YCE_YOUWEN_TOKEN && String(process.env.YCE_YOUWEN_TOKEN).trim()) ||
      (process.env.YOUWEN_TOKEN && String(process.env.YOUWEN_TOKEN).trim())
  );
}

function buildDegradationMeta({ resolvedAction, query, enhance, search, errors }) {
  const enhanceAttempted = Boolean(enhance && enhance.executed);
  const enhanceFailed = Boolean(enhanceAttempted && enhance.success !== true);
  const searchUsable = Boolean(search && search.success === true && search.result_present);

  if (resolvedAction !== "enhance_then_search" || !enhanceFailed || !searchUsable) {
    return { active: false };
  }

  const enhanceError = Array.isArray(errors)
    ? errors.find((error) => error && error.source === "yw-enhance")
    : null;

  return {
    active: true,
    failed_stage: "enhance",
    search_query_source: "original-query",
    fallback_query: query,
    summary: "增强阶段失败，已自动降级为原始 query 检索。",
    error: enhanceError
      ? {
          source: enhanceError.source || "yw-enhance",
          code: enhanceError.code || "EXEC_ERROR",
          message: enhanceError.message || "yw-enhance failed.",
        }
      : null,
  };
}

async function orchestrate(input) {
  const {
    mode,
    query,
    cwd,
    history,
    noSearch,
    rawEvents,
    withNetwork,
    noNetwork,
    networkOptions,
    config,
  } = input;

  const startedAt = Date.now();
  let resolvedAction = resolveAction(mode, query);
  const errors = [];
  let enhance = null;
  let search = null;
  let networkSearch = null;
  const durations = {
    enhance: 0,
    search: 0,
    network: 0,
    total: 0,
  };

  const networkIntent = hasNetworkIntent(query);
  const searchIntent = hasSearchIntent(query);
  // Explicit --with-network always on; auto attaches network when external-fact intent is present.
  // --no-network disables auto attachment (does not block explicit mode=network).
  const shouldRunNetwork =
    mode === "network" ||
    withNetwork === true ||
    (mode === "auto" && networkIntent && noNetwork !== true);

  const canEnhance = hasYouwenToken(config);
  if (!canEnhance && (resolvedAction === "enhance" || resolvedAction === "enhance_then_search")) {
    if (mode === "enhance") {
      // Explicit enhance without token: fail fast, do not call youwen.
      enhance = {
        executed: false,
        success: false,
        prompt: null,
        recommended_skills: [],
        raw_stdout: null,
        stderr_summary: ["skipped: missing YCE_YOUWEN_TOKEN / YOUWEN_TOKEN"],
        used_history: Boolean(history && String(history).trim()),
      };
      errors.push(buildError("yw-enhance", "AUTH_ERROR", MISSING_YOUWEN_TOKEN_MESSAGE));
      if (withNetwork !== true && !(mode === "auto" && shouldRunNetwork)) {
        durations.total = Date.now() - startedAt;
        return {
          success: false,
          mode,
          resolved_action: "enhance",
          original_query: query,
          cwd,
          enhance,
          search: null,
          network_search: null,
          errors,
          meta: {
            durations_ms: durations,
            dependency_paths: {
              yw_enhance_script: config.youwenScript,
              yce_engine_script: config.yceEngineScript,
            },
            degradation: { active: false },
            timestamp: nowIso(),
          },
        };
      }
    } else if (resolvedAction === "enhance_then_search") {
      // auto without token + code-search path: skip enhance and search with original query.
      resolvedAction = "search";
    } else if (resolvedAction === "enhance") {
      // auto without token + pure enhance (no code intent): keep enhance failed state unless network can save.
      if (shouldRunNetwork) {
        resolvedAction = "network_search";
      } else {
        resolvedAction = "search";
      }
    }
  }

  if (canEnhance && (resolvedAction === "enhance" || resolvedAction === "enhance_then_search")) {
    const enhanceResult = await runYwEnhance({
      prompt: query,
      history,
      scriptPath: config.youwenScript,
      timeoutMs: input.timeoutEnhanceMs,
      noSearch,
      rawEvents,
      env: config.ywEnhanceEnv,
    });
    enhance = enhanceResult.enhance;
    durations.enhance = enhanceResult.durationMs;
    if (enhanceResult.error) {
      errors.push(enhanceResult.error);
    }

    // auto must always finish with a grounded code search after it attempted enhancement,
    // except pure external-fact auto (network-only, no local code intent).
    if (mode === "auto" && enhance && enhance.executed) {
      if (searchIntent || !networkIntent) {
        resolvedAction = "enhance_then_search";
      } else if (shouldRunNetwork) {
        resolvedAction = "enhance_with_network";
      }
    }
  }

  const shouldRunCodeSearch =
    resolvedAction === "search" ||
    resolvedAction === "enhance_then_search" ||
    resolvedAction === "search_with_network" ||
    resolvedAction === "enhance_then_search_with_network";

  if (shouldRunCodeSearch) {
    const rawSearchQuery = enhance && enhance.success && enhance.prompt ? enhance.prompt : query;
    const searchQuery = normalizeSearchQuery(rawSearchQuery);
    const searchResult = await runYceEngineSearch({
      query: searchQuery,
      cwd,
      scriptPath: config.yceEngineScript,
      timeoutMs: input.timeoutSearchMs,
      ...(input.searchOptions || {
        maxResults: config.yceEngineMaxResults,
        maxTurns: config.yceEngineMaxTurns,
      }),
      env: config.yceEngineEnv,
    });
    search = searchResult.search;
    durations.search = searchResult.durationMs;
    if (searchResult.error) {
      errors.push(searchResult.error);
    }
  }

  if (shouldRunNetwork) {
    const networkQuery =
      enhance && enhance.success && enhance.prompt ? enhance.prompt : query;
    const networkResult = await runNetworkSearch({
      query: networkQuery,
      relayUrl: config.yceRelayUrl,
      relayToken: config.yceRelayToken,
      timeoutMs: input.timeoutNetworkMs,
      ...(networkOptions || {}),
    });
    networkSearch = networkResult.networkSearch;
    durations.network = networkResult.durationMs;
    if (networkResult.error) {
      errors.push(networkResult.error);
    }
    if (mode === "network" || resolvedAction === "network_search") {
      resolvedAction = "network_search";
    } else if (resolvedAction === "enhance_then_search") {
      resolvedAction = "enhance_then_search_with_network";
    } else if (resolvedAction === "search") {
      resolvedAction = "search_with_network";
    } else if (
      resolvedAction === "enhance" ||
      resolvedAction === "enhance_with_network"
    ) {
      resolvedAction = "enhance_with_network";
    }
  }

  durations.total = Date.now() - startedAt;

  const hasUsableEnhance = Boolean(enhance && enhance.success && enhance.prompt);
  const hasUsableSearch = Boolean(search && search.success === true && search.result_present);
  const hasUsableNetwork = Boolean(
    networkSearch &&
      networkSearch.success === true &&
      networkSearch.result_present === true,
  );
  const success = hasUsableEnhance || hasUsableSearch || hasUsableNetwork;
  const degradation = buildDegradationMeta({
    resolvedAction,
    query,
    enhance,
    search,
    network_search: networkSearch,
    errors,
  });

  if (!success && errors.length === 0) {
    errors.push(buildError("orchestrator", "EXEC_ERROR", "No usable output was produced by YCE."));
  }

  return {
    success,
    mode,
    resolved_action: resolvedAction,
    original_query: query,
    cwd,
    enhance,
    search,
    network_search: networkSearch,
    errors,
    meta: {
      durations_ms: durations,
      dependency_paths: {
        yw_enhance_script: config.youwenScript,
        yce_engine_script: config.yceEngineScript,
      },
      degradation,
      timestamp: nowIso(),
    },
  };
}

module.exports = {
  orchestrate,
  resolveAction,
  hasYouwenToken,
  hasNetworkIntent,
  hasSearchIntent,
};
