const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildError, isNonEmptyString } = require("../utils");

// Relay 侧 y-plan 的 search_context 上限（yPlanMaxSearchContext = 30000 字符）。
const MAX_SEARCH_CONTEXT_CHARS = 30000;

/**
 * 按对接契约拼落盘文件名：y-plan-<任务摘要>-<yyyyMMdd-HHmmss>.md。
 * 服务端不提供文件名和标题，客户端自己负责。
 */
function buildPlanFilename(task, now = new Date()) {
  const summary = String(task || "plan")
    .trim()
    .slice(0, 24)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "plan";
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `y-plan-${summary}-${stamp}.md`;
}

/**
 * 把计划正文写到本地：savePath 为目录时自动按契约命名；
 * 以 .md 结尾时按完整文件路径使用。返回写入后的绝对路径。
 */
function savePlanToFile({ plan, task, savePath, cwd }) {
  const baseDir = isNonEmptyString(cwd) ? cwd : process.cwd();
  let resolved = path.isAbsolute(savePath) ? savePath : path.resolve(baseDir, savePath);
  const looksLikeFile = /\.md$/i.test(resolved);
  if (!looksLikeFile) {
    resolved = path.join(resolved, buildPlanFilename(task));
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const frontMatter = [
    "---",
    `task: ${JSON.stringify(String(task || ""))}`,
    `generated_at: ${new Date().toISOString()}`,
    "source: yce y-plan",
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(resolved, frontMatter + String(plan), "utf8");
  return resolved;
}

function mapPlanHttpError(status, payload) {
  const code = String(payload?.code || "").trim();
  const message = String(payload?.error || payload?.message || "Y-Plan 规划请求失败").trim();
  if (status === 404) {
    return buildError(
      "y-plan",
      "NOT_DEPLOYED",
      "线上 YCE 服务尚未部署 Y-Plan 端点（HTTP 404）。请等待服务端发布该能力后重试。",
    );
  }
  if (status === 401 || status === 403) {
    return buildError("y-plan", "AUTH_ERROR", message);
  }
  if (status === 429 || /QUOTA/.test(code)) {
    return buildError("y-plan", "QUOTA_EXCEEDED", message);
  }
  if (code === "Y_PLAN_DISABLED") {
    return buildError("y-plan", "DISABLED", message);
  }
  if (code === "Y_PLAN_TIMEOUT") {
    return buildError("y-plan", "TIMEOUT", message);
  }
  return buildError("y-plan", code || "EXEC_ERROR", message);
}

function truncateSearchContext(text) {
  const value = String(text || "");
  if (value.length <= MAX_SEARCH_CONTEXT_CHARS) {
    return value;
  }
  return value.slice(0, MAX_SEARCH_CONTEXT_CHARS);
}

function normalizeCustomProvider(customProvider) {
  if (!customProvider || typeof customProvider !== "object") {
    return null;
  }
  const provider = String(customProvider.provider || "").trim();
  const baseUrl = String(customProvider.baseUrl || "").trim();
  const token = String(customProvider.token || "").trim();
  const model = String(customProvider.model || "").trim();
  if (!provider && !baseUrl && !token && !model) {
    return null;
  }
  const config = { provider, baseUrl, token, model };
  const temperature = Number(customProvider.temperature);
  if (Number.isFinite(temperature)) {
    config.temperature = temperature;
  }
  if (customProvider.forceStream === true || customProvider.forceStream === "true") {
    config.forceStream = true;
  }
  return config;
}

async function consumePlanSSE(response, plan) {
  const state = {
    accumulated: "",
    finalPlan: null,
    status: null,
    errorMessage: null,
    sawTerminal: false,
  };

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  const handleEvent = (event, data) => {
    switch (event) {
      case "search_complete":
        plan.search_used = true;
        break;
      case "chunk":
        if (data && typeof data.chunk === "string") {
          state.accumulated += data.chunk;
        }
        break;
      case "complete":
        state.finalPlan = data && typeof data.plan === "string" ? data.plan : null;
        state.status = "succeeded";
        state.sawTerminal = true;
        break;
      case "cancelled":
        state.status = "cancelled";
        state.sawTerminal = true;
        break;
      case "error":
      case "unauthorized":
      case "forbidden":
        state.status = "failed";
        state.errorMessage =
          (data && (data.error || data.message)) || "Y-Plan 规划失败。";
        state.sawTerminal = true;
        break;
      default:
        break;
    }
  };

  const handleLine = (line) => {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "keep-alive") {
        return;
      }
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        data = { raw: dataStr };
      }
      handleEvent(currentEvent, data);
      currentEvent = "message";
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) {
    handleLine(buffer.replace(/\r$/, ""));
  }

  return state;
}

async function runYPlan({
  task,
  history,
  searchContext,
  enableWebSearch,
  language,
  relayUrl,
  relayToken,
  timeoutMs,
  customProvider,
}) {
  const requestId = randomUUID();
  const plan = {
    executed: true,
    success: false,
    result_present: false,
    request_id: requestId,
    task,
    plan: null,
    search_used: false,
    status: null,
    custom_model: false,
  };

  if (!relayToken || !String(relayToken).trim()) {
    return {
      plan,
      error: buildError(
        "y-plan",
        "AUTH_ERROR",
        "缺少 YCE Key：请设置 YCE_RELAY_TOKEN。代码检索、联网检索、提示词增强和 Y-Plan 共用该密钥。",
      ),
      durationMs: 0,
    };
  }

  const body = {
    request_id: requestId,
    task,
  };
  if (isNonEmptyString(history)) {
    body.conversation_history = history;
  }
  if (isNonEmptyString(searchContext)) {
    body.search_context = truncateSearchContext(searchContext);
  }
  if (typeof enableWebSearch === "boolean") {
    body.enable_web_search = enableWebSearch;
  }
  if (isNonEmptyString(language)) {
    body.language = language;
  }
  const normalizedProvider = normalizeCustomProvider(customProvider);
  if (normalizedProvider) {
    body.config = normalizedProvider;
    plan.custom_model = true;
  }

  const endpoint = `${String(relayUrl || "").replace(/\/+$/, "")}/yce/y-plan`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(relayToken).trim()}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      return {
        plan,
        error: mapPlanHttpError(response.status, payload),
        durationMs: Date.now() - startedAt,
      };
    }

    const state = await consumePlanSSE(response, plan);
    const durationMs = Date.now() - startedAt;
    plan.status = state.status || null;

    if (state.status === "succeeded") {
      const finalPlan = isNonEmptyString(state.finalPlan)
        ? state.finalPlan
        : state.accumulated;
      if (!isNonEmptyString(finalPlan)) {
        plan.status = "failed";
        return {
          plan,
          error: buildError("y-plan", "EMPTY_RESULT", "Y-Plan 规划完成，但没有返回计划内容。"),
          durationMs,
        };
      }
      plan.success = true;
      plan.result_present = true;
      plan.plan = finalPlan;
      return { plan, error: null, durationMs };
    }

    // 失败 / 取消时保留已流出的部分内容，方便排障，但不算可用结果。
    if (isNonEmptyString(state.accumulated)) {
      plan.plan = state.accumulated;
    }
    if (state.status === "cancelled") {
      return {
        plan,
        error: buildError("y-plan", "CANCELLED", "Y-Plan 规划被取消。"),
        durationMs,
      };
    }
    const message = state.errorMessage || "Y-Plan SSE 流意外结束，未收到终止事件。";
    return {
      plan,
      error: buildError(
        "y-plan",
        /配额|额度|quota/i.test(message) ? "QUOTA_EXCEEDED" : "EXEC_ERROR",
        message,
      ),
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const timedOut = error && error.name === "AbortError";
    plan.status = timedOut ? "timeout" : "failed";
    return {
      plan,
      error: buildError(
        "y-plan",
        timedOut ? "TIMEOUT" : "EXEC_ERROR",
        timedOut
          ? `Y-Plan 规划在 ${timeoutMs}ms 后超时。`
          : error?.message || "Y-Plan 规划请求失败。",
      ),
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runYPlan, savePlanToFile, buildPlanFilename, MAX_SEARCH_CONTEXT_CHARS };
