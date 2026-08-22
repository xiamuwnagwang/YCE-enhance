const { runPromptEnhance } = require("./adapters/promptEnhance");
const { runPromptEnhanceLocal } = require("./adapters/promptEnhanceLocal");
const { runYceEngineSearch } = require("./adapters/yceEngineSearch");
const { runNetworkSearch } = require("./adapters/networkSearch");
const { runYPlan, savePlanToFile, MAX_SEARCH_CONTEXT_CHARS } = require("./adapters/yPlan");
const { formatNetworkContext, runYPlanLocal } = require("./adapters/yPlanLocal");
const { resolveBackend } = require("./adapters/localModel");
const { createCardFromTaskPlan, resolveCard } = require("./taskCard");
const { buildError, isNonEmptyString, normalizeSearchQuery, nowIso, PLAN_DISABLED_MESSAGE } = require("./utils");

const SEARCH_KEYWORDS = [
  "搜索代码", "找文件", "定位实现", "在哪", "哪里", "函数", "类", "接口", "api", "组件", "模块",
  "provider", "route", "handler", "实现", "逻辑", "代码", "文件", "settings", "模型列表",
];

const ENHANCE_KEYWORDS = [
  "优化提示词", "提示词增强", "增强", "改写", "整理需求", "润色", "补全上下文", "更好理解", "优化这个任务", "prompt",
];

const AMBIGUOUS_MARKERS = ["这个", "这里", "那块", "相关逻辑", "对应地方", "这块", "那个", "它", "帮我看看"];

const MISSING_PROMPT_ENHANCE_TOKEN_MESSAGE =
  "缺少 YCE Key：请在 YCE 根目录 .env 设置 YCE_RELAY_TOKEN。代码检索、联网检索和提示词增强共用该密钥。";

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
  if (mode === "network") {
    return "network_search";
  }
  if (mode === "plan") {
    return "plan";
  }

  // auto: only enhance when the prompt is genuinely vague (ambiguity markers)
  // or the user explicitly used enhance-related keywords.
  // Otherwise default to search — do not auto-enhance clear/specific prompts.
  const hasAmbiguity = containsAny(query, AMBIGUOUS_MARKERS);
  const hasEnhanceIntent = containsAny(query, ENHANCE_KEYWORDS);

  if (hasAmbiguity || hasEnhanceIntent) {
    return "enhance_then_search";
  }

  return "search";
}

function hasPromptEnhanceToken(config) {
  // loadRuntimeConfig always resolves this from .env + process.env, so an
  // explicit boolean is authoritative — including an explicit false. Falling
  // back to process.env here would let an ambient token override the caller.
  if (config && typeof config.hasPromptEnhanceToken === "boolean") {
    return config.hasPromptEnhanceToken;
  }
  const env = config && config.promptEnhanceEnv ? config.promptEnhanceEnv : {};
  return Boolean(
    (env.YCE_RELAY_TOKEN && String(env.YCE_RELAY_TOKEN).trim()) ||
      (process.env.YCE_RELAY_TOKEN && String(process.env.YCE_RELAY_TOKEN).trim())
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
    ? errors.find((error) => error && error.source === "prompt-enhance")
    : null;

  return {
    active: true,
    failed_stage: "enhance",
    search_query_source: "original-query",
    fallback_query: query,
    summary: "增强阶段失败，已自动降级为原始 query 检索。",
    error: enhanceError
      ? {
          source: enhanceError.source || "prompt-enhance",
          code: enhanceError.code || "EXEC_ERROR",
          message: enhanceError.message || "prompt enhancement failed.",
        }
      : null,
  };
}

async function orchestrate(input) {
  const {
    mode,
    query,
    cwd,
    noSearch,
    rawEvents,
    withNetwork,
    networkOptions,
    config,
  } = input;
  let { history } = input;

  const startedAt = Date.now();
  let resolvedAction = resolveAction(mode, query);
  const errors = [];
  let enhance = null;
  let search = null;
  let networkSearch = null;
  let plan = null;
  const durations = {
    enhance: 0,
    search: 0,
    network: 0,
    plan: 0,
    total: 0,
  };

  // 任务锚点：--task 显式绑定 / --no-task 关闭本次簿记。
  const taskOptions = input.taskOptions || {};
  const noTask = taskOptions.noTask === true;
  const boundTaskId = isNonEmptyString(taskOptions.taskId) ? taskOptions.taskId.trim() : "";
  let boundCard = null;
  if (!noTask && boundTaskId) {
    boundCard = resolveCard(cwd, boundTaskId);
    if (!boundCard) {
      errors.push(
        buildError("task", "NOT_FOUND", `--task 指定的任务卡不存在：${boundTaskId}`),
      );
    } else if (isNonEmptyString(history)) {
      // history 注入仅限显式 --task（协议红线：无参兜底只用于压缩恢复，避免并行会话串卡）
      history = `${history}\n[任务锚点 ${boundCard.id}] 目标：${boundCard.goal}`;
    } else {
      history = `[任务锚点 ${boundCard.id}] 目标：${boundCard.goal}`;
    }
  }

  // Network is never keyword-auto in auto. Only AI/caller explicit:
  // --mode network  or  --with-network
  const shouldRunNetwork = mode === "network" || withNetwork === true;

  const enhanceBackend = resolveBackend(
    (input.enhanceOptions && input.enhanceOptions.backend) || config.enhanceBackend,
    "relay",
  );
  if ((resolvedAction === "enhance" || resolvedAction === "enhance_then_search") && !enhanceBackend) {
    errors.push(
      buildError(
        "prompt-enhance",
        "INVALID_ARGS",
        "enhance-backend 只能是 relay / yce 或 local / cli。",
      ),
    );
  }

  const canEnhance =
    enhanceBackend === "local" || hasPromptEnhanceToken(config);
  if (!canEnhance && (resolvedAction === "enhance" || resolvedAction === "enhance_then_search")) {
    if (mode === "enhance") {
      // Explicit enhance without a YCE Key: fail fast.
      enhance = {
        executed: false,
        success: false,
        prompt: null,
        recommended_skills: [],
        raw_stdout: null,
        stderr_summary: ["skipped: missing YCE_RELAY_TOKEN"],
        used_history: Boolean(history && String(history).trim()),
      };
      errors.push(buildError("prompt-enhance", "AUTH_ERROR", MISSING_PROMPT_ENHANCE_TOKEN_MESSAGE));
      if (withNetwork !== true) {
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
          plan: null,
          task_context: null,
          errors,
          meta: {
            durations_ms: durations,
            dependency_paths: {
              prompt_enhance_script: config.promptEnhanceScript,
              yce_engine_script: config.yceEngineScript,
            },
            degradation: { active: false },
            timestamp: nowIso(),
          },
        };
      }
    } else {
      // auto / enhance_then_search without token: skip enhance and search with original query.
      resolvedAction = "search";
    }
  }

  if (canEnhance && enhanceBackend && (resolvedAction === "enhance" || resolvedAction === "enhance_then_search")) {
    const enhanceResult = enhanceBackend === "local"
      ? await runPromptEnhanceLocal({
          prompt: query,
          history,
          timeoutMs: input.timeoutEnhanceMs,
          noSearch,
          language: input.enhanceOptions && input.enhanceOptions.language,
          cwd,
          customProvider: config.enhanceCustomProvider || null,
          cliPath: config.yPlanCli,
          skillRoot: config.yPlanSkillRoot,
          configPath: config.yPlanConfig,
        })
      : await runPromptEnhance({
          prompt: query,
          history,
          scriptPath: config.promptEnhanceScript,
          timeoutMs: input.timeoutEnhanceMs,
          noSearch,
          rawEvents,
          env: config.promptEnhanceEnv,
        });
    enhance = enhanceResult.enhance;
    durations.enhance = enhanceResult.durationMs;
    if (enhanceResult.error) {
      errors.push(enhanceResult.error);
    }

    // auto must always finish with a grounded code search after it attempted enhancement.
    // A failed enhancement falls back to the original query in the shared search logic below.
    if (mode === "auto" && enhance && enhance.executed) {
      resolvedAction = "enhance_then_search";
    }
  }

  if (resolvedAction === "search" || resolvedAction === "enhance_then_search") {
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

  let prePlanNetwork = null;
  if (resolvedAction === "plan" && config.enablePlan === false) {
    plan = {
      executed: false,
      success: false,
      result_present: false,
      plan: null,
      stderr_summary: ["skipped: YCE_ENABLE_PLAN=false"],
    };
    errors.push(buildError("y-plan", "DISABLED", PLAN_DISABLED_MESSAGE));
  } else if (resolvedAction === "plan") {
    const planOptions = input.planOptions || {};
    const planBackend = resolveBackend(planOptions.backend || config.yPlanBackend, "relay");
    if (!planBackend) {
      errors.push(
        buildError("y-plan", "INVALID_ARGS", "plan-backend 只能是 relay / yce 或 local / cli。"),
      );
    }
    let searchContext = isNonEmptyString(planOptions.searchContext)
      ? String(planOptions.searchContext)
      : "";

    // --with-search：先在目标项目做一次代码检索，再把定位结果作为
    // search_context 喂给 Y-Plan，产出代码贴地的计划。
    if (planOptions.withSearch === true) {
      const searchResult = await runYceEngineSearch({
        query: normalizeSearchQuery(query),
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
      if (search && search.success === true && search.result_present && search.raw_stdout) {
        searchContext = [searchContext, String(search.raw_stdout)]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, MAX_SEARCH_CONTEXT_CHARS);
      }
      resolvedAction = "search_then_plan";
    }

    // 本地规划没有服务端 web search：需要时先走 YCE 联网，再把结果喂给本机模型。
    if (planBackend === "local" && planOptions.enableWebSearch === true) {
      const networkQuery = query;
      const networkResult = await runNetworkSearch({
        query: networkQuery,
        relayUrl: config.yceRelayUrl,
        relayToken: config.yceRelayToken,
        timeoutMs: input.timeoutNetworkMs,
        ...(networkOptions || {}),
      });
      prePlanNetwork = networkResult;
      if (networkResult.error) {
        errors.push(networkResult.error);
      }
    }

    const customProvider = planOptions.customProvider || config.yPlanCustomProvider || null;
    if (planBackend === "local") {
      const planResult = await runYPlanLocal({
        task: query,
        cwd,
        history,
        searchContext,
        networkContext: formatNetworkContext(prePlanNetwork && prePlanNetwork.networkSearch),
        language: planOptions.language,
        timeoutMs: input.timeoutPlanMs || config.timeoutPlanMs,
        customProvider,
        cliPath: config.yPlanCli,
        skillRoot: config.yPlanSkillRoot,
        configPath: config.yPlanConfig,
      });
      plan = planResult.plan;
      durations.plan = planResult.durationMs;
      if (planResult.error) {
        errors.push(planResult.error);
      }
    } else if (planBackend === "relay") {
      const planResult = await runYPlan({
        task: query,
        history,
        searchContext,
        enableWebSearch: planOptions.enableWebSearch,
        language: planOptions.language,
        relayUrl: config.yceRelayUrl,
        relayToken: config.yceRelayToken,
        timeoutMs: input.timeoutPlanMs || config.timeoutPlanMs,
        customProvider,
      });
      plan = planResult.plan;
      if (plan && !plan.backend) {
        plan.backend = "relay";
      }
      durations.plan = planResult.durationMs;
      if (planResult.error) {
        errors.push(planResult.error);
      }
    }

    // --save：规划成功后按契约文件名落盘；写失败不取消已成功的计划结果。
    if (
      plan &&
      plan.success === true &&
      plan.result_present === true &&
      isNonEmptyString(planOptions.savePath)
    ) {
      try {
        plan.saved_path = savePlanToFile({
          plan: plan.plan,
          task: query,
          savePath: planOptions.savePath,
          cwd,
        });
      } catch (saveError) {
        errors.push(
          buildError(
            "y-plan",
            "SAVE_FAILED",
            `计划落盘失败：${saveError && saveError.message ? saveError.message : saveError}`,
          ),
        );
      }
    }
  }

  if (shouldRunNetwork) {
    if (prePlanNetwork) {
      networkSearch = prePlanNetwork.networkSearch;
      durations.network = prePlanNetwork.durationMs;
    } else {
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
    }
    if (mode === "network") {
      resolvedAction = "network_search";
    } else if (resolvedAction === "enhance_then_search") {
      resolvedAction = "enhance_then_search_with_network";
    } else if (resolvedAction === "search") {
      resolvedAction = "search_with_network";
    } else if (resolvedAction === "plan") {
      resolvedAction = "plan_with_network";
    } else if (resolvedAction === "search_then_plan") {
      resolvedAction = "search_then_plan_with_network";
    } else {
      resolvedAction = "enhance_with_network";
    }
  }

  // 零配合兜底：agent 不做任何簿记时，增强产出任务锚点即自动建卡，
  // 并在每次调用的 XML 里复述当前活跃卡（task-context）。
  let createdCard = null;
  if (!noTask && enhance && enhance.success && enhance.task_plan && !boundCard) {
    try {
      createdCard = createCardFromTaskPlan({
        cwd,
        taskPlan: enhance.task_plan,
        task: query,
      });
    } catch (cardError) {
      errors.push(
        buildError(
          "task",
          "CARD_CREATE_FAILED",
          `自动建卡失败：${cardError && cardError.message ? cardError.message : cardError}`,
        ),
      );
    }
  }
  let taskContext = null;
  if (!noTask) {
    const activeCard = createdCard || boundCard || resolveCard(cwd, "");
    if (activeCard) {
      taskContext = { card: activeCard, created_now: Boolean(createdCard) };
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
  const hasUsablePlan = Boolean(plan && plan.success === true && plan.result_present === true);
  const success = hasUsableEnhance || hasUsableSearch || hasUsableNetwork || hasUsablePlan;
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
    plan,
    task_context: taskContext,
    errors,
    meta: {
      durations_ms: durations,
      dependency_paths: {
        prompt_enhance_script: config.promptEnhanceScript,
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
  hasPromptEnhanceToken,
};
