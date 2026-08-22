const { execSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expandHomePath, isNonEmptyString } = require("../utils");

const RELAY_RUNTIMES = new Set(["yce-relay", "relay"]);

const PROVIDER_TO_API_RUNTIME = {
  claude: "claude-api",
  anthropic: "claude-api",
  "claude-api": "claude-api",
  openai: "openai-chat",
  "openai-chat": "openai-chat",
  "openai-responses": "openai-responses",
  "openai-response": "openai-responses",
};

const PROVIDER_TO_CLI_RUNTIME = {
  gemini: "gemini",
  "claude-code": "claude-code",
  "claude-cli": "claude-code",
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  kiro: "kiro",
  qoder: "qoder",
};

const AUTO_DISCOVER_CLI = [
  { runtime: "claude-code", bins: ["claude"] },
  { runtime: "codex", bins: ["codex"] },
  { runtime: "cursor", bins: ["cursor-agent", "cursor"] },
  { runtime: "kiro", bins: ["kiro-cli", "kiro"] },
  { runtime: "qoder", bins: ["qodercli", "qoder", "qoder-cli"] },
];

const YPLAN_SCRIPT_CANDIDATES = [
  "~/.grok/skills/y-plan/scripts/y-plan.mjs",
  "~/ai/skills/y-plan/scripts/y-plan.mjs",
  "~/.agents/skills/y-plan/scripts/y-plan.mjs",
  "~/.claude/skills/y-plan/scripts/y-plan.mjs",
  "~/.codex/skills/y-plan/scripts/y-plan.mjs",
  "~/.cursor/skills/y-plan/scripts/y-plan.mjs",
];

function resolveBackend(value, fallback = "relay") {
  const raw = String(value == null || value === "" ? fallback : value)
    .trim()
    .toLowerCase();
  if (raw === "local" || raw === "cli") {
    return "local";
  }
  if (raw === "relay" || raw === "yce") {
    return "relay";
  }
  return null;
}

function commandExists(bin) {
  if (!isNonEmptyString(bin)) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      execSync(`where ${bin}`, { stdio: "ignore" });
    } else {
      execSync(`command -v ${JSON.stringify(bin)}`, { stdio: "ignore", shell: true });
    }
    return true;
  } catch {
    return false;
  }
}

function firstExistingBin(bins) {
  for (const bin of bins) {
    if (commandExists(bin)) {
      return bin;
    }
  }
  return "";
}

function resolveYPlanScript({ cliPath, skillRoot } = {}) {
  const candidates = [];
  if (isNonEmptyString(cliPath)) {
    candidates.push(expandHomePath(cliPath));
  }
  if (isNonEmptyString(skillRoot)) {
    const root = expandHomePath(skillRoot);
    candidates.push(path.join(root, "scripts", "y-plan.mjs"));
    candidates.push(path.join(root, "bin", "y-plan"));
  }
  for (const candidate of YPLAN_SCRIPT_CANDIDATES) {
    candidates.push(expandHomePath(candidate));
  }
  for (const candidate of candidates) {
    if (isNonEmptyString(candidate) && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  const pathBin = firstExistingBin(["y-plan"]);
  return pathBin || "";
}

function resolveYPlanConfigPath({ configPath, scriptPath } = {}) {
  if (isNonEmptyString(configPath)) {
    const resolved = expandHomePath(configPath);
    return fs.existsSync(resolved) ? path.resolve(resolved) : "";
  }
  if (isNonEmptyString(scriptPath)) {
    const sibling = path.resolve(path.dirname(scriptPath), "..", "y-plan.config.json");
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  }
  const defaultPath = expandHomePath("~/.grok/skills/y-plan/y-plan.config.json");
  return fs.existsSync(defaultPath) ? defaultPath : "";
}

function readJsonFile(filePath) {
  if (!isNonEmptyString(filePath) || !fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function modelRuntime(entry) {
  if (!entry) {
    return "";
  }
  if (typeof entry === "string") {
    return entry.split("/")[0].trim().toLowerCase();
  }
  return String(entry.runtime || "").trim().toLowerCase();
}

function isRelayRuntime(runtime) {
  return RELAY_RUNTIMES.has(String(runtime || "").trim().toLowerCase());
}

function mapCustomProviderToModel(customProvider, { allowCliWithoutToken = true } = {}) {
  if (!customProvider || typeof customProvider !== "object") {
    return { entry: null };
  }
  const provider = String(customProvider.provider || "").trim().toLowerCase();
  const model = String(customProvider.model || "").trim();
  const token = String(customProvider.token || "").trim();
  const baseUrl = String(
    customProvider.baseUrl || customProvider.base_url || "",
  ).trim();
  const hasAny =
    Boolean(provider) || Boolean(model) || Boolean(token) || Boolean(baseUrl);
  if (!hasAny) {
    return { entry: null };
  }

  if (PROVIDER_TO_API_RUNTIME[provider] && (token || baseUrl)) {
    if (!model) {
      return {
        error:
          "自备模型走本地时必须提供 model。请设置 --plan-model / YCE_YPLAN_MODEL（增强则用 YCE_ENHANCE_MODEL）。",
      };
    }
    const entry = {
      runtime: PROVIDER_TO_API_RUNTIME[provider],
      model,
    };
    if (baseUrl) {
      entry.url = baseUrl;
    }
    if (token) {
      entry.token = token;
    }
    const temperature = Number(customProvider.temperature);
    if (Number.isFinite(temperature)) {
      entry.temperature = temperature;
    }
    return { entry };
  }

  if (allowCliWithoutToken && PROVIDER_TO_CLI_RUNTIME[provider]) {
    if ((token || baseUrl) && provider !== "claude") {
      return {
        error: `本地模式不能把 ${provider} 当成 HTTP 自备模型。它只能走本机 CLI，不要填 token / base-url。`,
      };
    }
    const entry = { runtime: PROVIDER_TO_CLI_RUNTIME[provider] };
    if (model) {
      entry.model = model;
    }
    return { entry };
  }

  if (provider) {
    return {
      error: `本地模式不支持 provider=${provider}。HTTP 自备模型用 claude / openai / openai-responses；本机 CLI 用 gemini / claude-code / codex / cursor / kiro / qoder。`,
    };
  }
  return {
    error:
      "自备模型走本地时必须提供 provider。HTTP：claude / openai / openai-responses；CLI：codex / cursor / claude-code / gemini / kiro / qoder。",
  };
}

function discoverLocalModels() {
  const models = [];
  for (const item of AUTO_DISCOVER_CLI) {
    if (firstExistingBin(item.bins)) {
      models.push({ runtime: item.runtime });
    }
  }
  return models;
}

function resolveLocalModels({ sourceConfig, customProvider } = {}) {
  const mapped = mapCustomProviderToModel(customProvider);
  if (mapped.error) {
    return mapped;
  }
  if (mapped.entry) {
    return { models: [mapped.entry] };
  }
  const raw = Array.isArray(sourceConfig && sourceConfig.models)
    ? sourceConfig.models
    : [];
  const filtered = raw.filter((entry) => !isRelayRuntime(modelRuntime(entry)));
  if (filtered.length > 0) {
    return { models: filtered };
  }
  const discovered = discoverLocalModels();
  if (discovered.length > 0) {
    return { models: discovered };
  }
  return {
    error:
      "本地模式没有可用的规划/增强模型。请安装 codex / cursor / claude / qoder / kiro，或用 --plan-provider / --plan-model 配置自备模型。",
  };
}

function writeTempConfig(config) {
  const filePath = path.join(
    os.tmpdir(),
    `yce-local-yplan-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

function resolveRuntimeBin(runtime) {
  if (runtime === "claude-code") {
    return firstExistingBin(["claude"]) || "claude";
  }
  if (runtime === "gemini") {
    return firstExistingBin(["gemini"]) || "gemini";
  }
  if (runtime === "codex") {
    return firstExistingBin(["codex"]) || "codex";
  }
  if (runtime === "qoder") {
    return (
      process.env.Y_PLAN_QODER_BIN ||
      firstExistingBin(["qodercli", "qoder", "qoder-cli"]) ||
      "qodercli"
    );
  }
  if (runtime === "cursor") {
    return (
      process.env.Y_PLAN_CURSOR_BIN ||
      firstExistingBin(["cursor-agent", "cursor"]) ||
      "cursor-agent"
    );
  }
  if (runtime === "kiro") {
    return (
      process.env.Y_PLAN_KIRO_BIN ||
      firstExistingBin(["kiro-cli", "kiro"]) ||
      "kiro-cli"
    );
  }
  return runtime;
}

function buildCliCommand(modelChoice, prompt) {
  const runtime = modelChoice.runtime;
  const model = modelChoice.model;
  if (runtime === "claude-code") {
    const args = ["-p", "--permission-mode", "plan"];
    if (model) args.push("--model", model);
    args.push(prompt);
    return { bin: resolveRuntimeBin(runtime), args };
  }
  if (runtime === "gemini") {
    const args = ["--approval-mode", "plan"];
    if (model) args.push("-m", model);
    args.push("-p", prompt);
    return { bin: resolveRuntimeBin(runtime), args };
  }
  if (runtime === "codex") {
    const args = ["exec", "--skip-git-repo-check"];
    if (model) args.push("-m", model);
    args.push("--", prompt);
    return { bin: resolveRuntimeBin(runtime), args };
  }
  if (runtime === "qoder") {
    const args = ["-p"];
    if (model) args.push("--model", model);
    args.push(prompt);
    return { bin: resolveRuntimeBin(runtime), args };
  }
  if (runtime === "cursor") {
    const args = ["-p", "--plan", "--force"];
    if (model) args.push("--model", model);
    args.push(prompt);
    return { bin: resolveRuntimeBin(runtime), args };
  }
  if (runtime === "kiro") {
    const args = ["chat", "--no-interactive", "--trust-tools="];
    if (model) args.push("--model", model);
    args.push(prompt);
    return { bin: resolveRuntimeBin(runtime), args };
  }
  return null;
}

function isApiRuntime(runtime) {
  return (
    runtime === "claude-api" ||
    runtime === "openai-chat" ||
    runtime === "openai-responses"
  );
}

function buildProviderUrl(modelChoice, suffix) {
  const raw = String(modelChoice.url || modelChoice.baseUrl || "").trim();
  if (!raw) {
    if (modelChoice.runtime === "claude-api") {
      return `https://api.anthropic.com${suffix}`;
    }
    return `https://api.openai.com${suffix}`;
  }
  const trimmed = raw.replace(/\/+$/, "");
  if (/\/v1\/(messages|chat\/completions|responses)$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}${suffix.replace(/^\/v1/, "")}`;
  }
  return `${trimmed}${suffix}`;
}

function extractApiText(runtime, responseText) {
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return responseText;
  }
  if (runtime === "claude-api") {
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    return blocks
      .map((block) => (block && block.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (runtime === "openai-chat") {
    const choice = payload.choices && payload.choices[0];
    return (choice && choice.message && choice.message.content) || "";
  }
  if (runtime === "openai-responses") {
    if (typeof payload.output_text === "string") {
      return payload.output_text;
    }
    const output = Array.isArray(payload.output) ? payload.output : [];
    return output
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .map((part) => (part && part.text) || "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function runApiModel(modelChoice, prompt, timeoutMs) {
  const runtime = modelChoice.runtime;
  const model = String(modelChoice.model || "").trim();
  const token = String(modelChoice.token || "").trim();
  if (!model) {
    return { code: 1, stdout: "", stderr: "本地自备模型缺少 model。" };
  }
  if (!token) {
    return { code: 1, stdout: "", stderr: "本地自备模型缺少 token。" };
  }
  let url;
  let headers;
  let body;
  if (runtime === "claude-api") {
    url = buildProviderUrl(modelChoice, "/v1/messages");
    headers = {
      "Content-Type": "application/json",
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    };
    body = {
      model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    };
  } else if (runtime === "openai-chat") {
    url = buildProviderUrl(modelChoice, "/v1/chat/completions");
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    body = {
      model,
      messages: [{ role: "user", content: prompt }],
    };
  } else if (runtime === "openai-responses") {
    url = buildProviderUrl(modelChoice, "/v1/responses");
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    body = { model, input: prompt };
  } else {
    return { code: 1, stdout: "", stderr: `不支持的本地 API runtime: ${runtime}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        code: 1,
        stdout: "",
        stderr: `${runtime} API 失败：HTTP ${response.status} ${text.slice(0, 500)}`,
      };
    }
    const output = extractApiText(runtime, text);
    if (!String(output).trim()) {
      return { code: 1, stdout: "", stderr: `${runtime} API 返回空文本。` };
    }
    return { code: 0, stdout: output, stderr: "" };
  } catch (error) {
    if (error && error.name === "AbortError") {
      return { code: 124, stdout: "", stderr: `${runtime} API 在 ${timeoutMs}ms 后超时。` };
    }
    return {
      code: 1,
      stdout: "",
      stderr: `${runtime} API 请求失败：${error && error.message ? error.message : error}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function runProcess(bin, args, { cwd, timeoutMs, onStderr } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }, 2000).unref();
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (typeof onStderr === "function") {
        onStderr(text);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: stderr || error.message,
        timedOut,
        spawnError: error,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code,
        stdout,
        stderr,
        timedOut,
        spawnError: null,
      });
    });
  });
}

async function runLocalModel(modelChoice, prompt, { cwd, timeoutMs, onStderr } = {}) {
  if (isApiRuntime(modelChoice.runtime)) {
    return runApiModel(modelChoice, prompt, timeoutMs);
  }
  const command = buildCliCommand(modelChoice, prompt);
  if (!command) {
    return { code: 1, stdout: "", stderr: `不支持的本地 runtime: ${modelChoice.runtime}` };
  }
  return runProcess(command.bin, command.args, { cwd, timeoutMs, onStderr });
}

function formatModelLabel(entry) {
  if (!entry) return "(none)";
  return entry.model ? `${entry.runtime}/${entry.model}` : `${entry.runtime}`;
}

module.exports = {
  RELAY_RUNTIMES,
  commandExists,
  discoverLocalModels,
  formatModelLabel,
  isApiRuntime,
  isRelayRuntime,
  mapCustomProviderToModel,
  readJsonFile,
  resolveBackend,
  resolveLocalModels,
  resolveYPlanConfigPath,
  resolveYPlanScript,
  runLocalModel,
  runProcess,
  writeTempConfig,
};
