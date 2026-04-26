const { runYwEnhance } = require("./adapters/ywEnhance");
const { runYceBinarySearch, runYceSearch } = require("./adapters/yceSearch");
const { buildError, normalizeSearchQuery, nowIso } = require("./utils");

const SEARCH_KEYWORDS = [
  "搜索代码", "找文件", "定位实现", "在哪", "哪里", "函数", "类", "接口", "api", "组件", "模块",
  "provider", "route", "handler", "实现", "逻辑", "代码", "文件", "settings", "模型列表",
];

const ENHANCE_KEYWORDS = [
  "优化提示词", "提示词增强", "增强", "改写", "整理需求", "润色", "补全上下文", "更好理解", "优化这个任务", "prompt",
];

const AMBIGUOUS_MARKERS = ["这个", "这里", "那块", "相关逻辑", "对应地方", "这块", "那个", "它", "帮我看看"];

function containsAny(text, keywords) {
  const lowerText = String(text || "").toLowerCase();
  return keywords.some((keyword) => lowerText.includes(String(keyword).toLowerCase()));
}

function resolveAction(mode, query) {
  if (mode === "enhance") {
    return "enhance";
  }
  if (mode === "search") {
    return "search";
  }

  const hasSearchIntent = containsAny(query, SEARCH_KEYWORDS);
  const hasEnhanceIntent = containsAny(query, ENHANCE_KEYWORDS);
  const hasAmbiguity = containsAny(query, AMBIGUOUS_MARKERS);

  if (hasSearchIntent && hasAmbiguity) {
    return "enhance_then_search";
  }

  if (hasSearchIntent && hasEnhanceIntent) {
    return "enhance_then_search";
  }

  if (hasSearchIntent) {
    return "search";
  }

  return "enhance";
}

function buildDegradationMeta({ resolvedAction, query, enhance, search, errors }) {
  const enhanceAttempted = Boolean(enhance && enhance.executed);
  const enhanceFailed = Boolean(enhanceAttempted && enhance.success !== true);
  const searchUsable = Boolean(search && search.result_present);

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
    config,
  } = input;

  const startedAt = Date.now();
  const resolvedAction = resolveAction(mode, query);
  const errors = [];
  let enhance = null;
  let search = null;
  const durations = {
    enhance: 0,
    search: 0,
    total: 0,
  };

  if (resolvedAction === "enhance" || resolvedAction === "enhance_then_search") {
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
  }

  if (resolvedAction === "search" || resolvedAction === "enhance_then_search") {
    const rawSearchQuery = enhance && enhance.success && enhance.prompt ? enhance.prompt : query;
    const searchQuery = normalizeSearchQuery(rawSearchQuery);
    const searchResult =
      config.yceBinary && config.yceConfig
        ? await runYceBinarySearch({
            query: searchQuery,
            cwd,
            binaryPath: config.yceBinary,
            configPath: config.yceConfig,
            timeoutMs: input.timeoutSearchMs,
            cliOptions: config.yceCliOptions,
          })
        : await runYceSearch({
            query: searchQuery,
            cwd,
            scriptPath: config.yceSearchScript,
            timeoutMs: input.timeoutSearchMs,
          });
    search = searchResult.search;
    durations.search = searchResult.durationMs;
    if (searchResult.error) {
      errors.push(searchResult.error);
    }
  }

  durations.total = Date.now() - startedAt;

  const hasUsableEnhance = Boolean(enhance && enhance.success && enhance.prompt);
  const hasUsableSearch = Boolean(search && search.result_present);
  const success = hasUsableEnhance || hasUsableSearch;
  const degradation = buildDegradationMeta({
    resolvedAction,
    query,
    enhance,
    search,
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
    errors,
    meta: {
      durations_ms: durations,
      dependency_paths: {
        yw_enhance_script: config.youwenScript,
        yce_search_script: config.yceSearchScript,
        yce_binary: config.yceBinary || null,
        yce_config: config.yceConfig || null,
      },
      degradation,
      timestamp: nowIso(),
    },
  };
}

module.exports = {
  orchestrate,
  resolveAction,
};
