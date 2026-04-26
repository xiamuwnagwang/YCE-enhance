const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const YCE_TOOL_DEFAULT_CONFIG = {
  base_url: "https://yce.aigy.de/",
  token: "",
};

function detectPlatformDir() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "darwin") {
    if (arch === "arm64") return "darwin-arm64";
    if (arch === "x64") return "darwin-amd64";
  }
  if (platform === "linux") {
    if (arch === "x64") return "linux-amd64";
    if (arch === "arm64") return "linux-arm64";
  }
  if (platform === "win32") {
    if (arch === "x64") return "windows-x64";
  }
  return null;
}

function detectBinaryFilename(platformDir) {
  if (platformDir === "windows-x64") {
    return "yce-tool-rs.exe";
  }
  return "yce-tool-rs";
}

function detectSearchScript(platformDir) {
  if (platformDir === "windows-x64") {
    return "./scripts/yce-search.ps1";
  }
  return "./scripts/yce-search.sh";
}

function expandHomePath(inputPath) {
  if (typeof inputPath !== "string") {
    return inputPath;
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function resolveConfigPath(inputPath) {
  const expanded = expandHomePath(inputPath);
  if (typeof expanded !== "string" || expanded.trim().length === 0) {
    return expanded;
  }
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(ROOT_DIR, expanded);
}

function ensureYceToolConfigFile(configPath) {
  const resolvedPath = resolveConfigPath(configPath);
  if (typeof resolvedPath !== "string" || resolvedPath.trim().length === 0) {
    return resolvedPath;
  }

  if (fs.existsSync(resolvedPath)) {
    return resolvedPath;
  }

  const fallbackPath = path.join(ROOT_DIR, "vendor", "yce-tool.default.json");
  const shouldBootstrapDefault = path.normalize(resolvedPath) === path.normalize(path.join(ROOT_DIR, "vendor", "yce-tool.json"));

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  if (fs.existsSync(fallbackPath)) {
    fs.copyFileSync(fallbackPath, resolvedPath);
    return resolvedPath;
  }

  if (shouldBootstrapDefault) {
    fs.writeFileSync(resolvedPath, `${JSON.stringify(YCE_TOOL_DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    return resolvedPath;
  }

  return resolvedPath;
}

function resolveYouwenScript(configuredValue) {
  const configuredPath = resolveConfigPath(configuredValue || DEFAULTS.youwenScript);
  return configuredPath;
}

const DEFAULTS = {
  youwenScript: "./scripts/youwen.js",
  youwenApiUrl: "https://a.aigy.de",
  youwenEnhanceMode: "agent",
  youwenEnableSearch: true,
  yceSearchScript: detectSearchScript(detectPlatformDir()),
  yceBinary: (() => {
    const platformDir = detectPlatformDir();
    return platformDir ? `./vendor/${platformDir}/${detectBinaryFilename(platformDir)}` : "";
  })(),
  yceConfig: "./vendor/yce-tool.json",
  yceMaxLinesPerBlob: 800,
  yceRetrievalTimeout: 60,
  yceNoAdaptive: false,
  yceNoWebbrowserEnhancePrompt: false,
  defaultMode: "auto",
  timeoutEnhanceMs: 300000,
  timeoutSearchMs: 180000,
};

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    result[key] = rawValue.replace(/^['"]|['"]$/g, "").trim();
  }
  return result;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function toOptionalPositiveInt(value, fallback = null) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return fallback;
  }
  return toPositiveInt(value, fallback);
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function buildYwEnhanceEnv(merged) {
  const childEnv = {};

  if (hasOwn(merged, "YCE_YOUWEN_API_URL") && isNonEmptyString(merged.YCE_YOUWEN_API_URL)) {
    const apiUrl = String(merged.YCE_YOUWEN_API_URL).trim();
    if (apiUrl) {
      childEnv.YOUWEN_API_URL = apiUrl;
    }
  }

  if (hasOwn(merged, "YCE_YOUWEN_ENHANCE_MODE") && isNonEmptyString(merged.YCE_YOUWEN_ENHANCE_MODE)) {
    const enhanceMode = String(merged.YCE_YOUWEN_ENHANCE_MODE).trim();
    if (enhanceMode) {
      childEnv.YOUWEN_ENHANCE_MODE = enhanceMode;
    }
  }

  if (hasOwn(merged, "YCE_YOUWEN_ENABLE_SEARCH") && isNonEmptyString(merged.YCE_YOUWEN_ENABLE_SEARCH)) {
    childEnv.YOUWEN_ENABLE_SEARCH = toBoolean(
      merged.YCE_YOUWEN_ENABLE_SEARCH,
      DEFAULTS.youwenEnableSearch
    )
      ? "true"
      : "false";
  }

  if (hasOwn(merged, "YCE_YOUWEN_TOKEN") && isNonEmptyString(merged.YCE_YOUWEN_TOKEN)) {
    childEnv.YOUWEN_TOKEN = String(merged.YCE_YOUWEN_TOKEN).trim();
  }

  if (hasOwn(merged, "YCE_YOUWEN_MGREP_API_KEY") && isNonEmptyString(merged.YCE_YOUWEN_MGREP_API_KEY)) {
    childEnv.YOUWEN_MGREP_API_KEY = String(merged.YCE_YOUWEN_MGREP_API_KEY).trim();
  }

  return childEnv;
}

function buildYceCliOptions(merged) {
  return {
    maxLinesPerBlob: hasOwn(merged, "YCE_MAX_LINES_PER_BLOB") && isNonEmptyString(merged.YCE_MAX_LINES_PER_BLOB)
      ? toOptionalPositiveInt(merged.YCE_MAX_LINES_PER_BLOB, DEFAULTS.yceMaxLinesPerBlob)
      : null,
    uploadTimeout: hasOwn(merged, "YCE_UPLOAD_TIMEOUT") && isNonEmptyString(merged.YCE_UPLOAD_TIMEOUT)
      ? toOptionalPositiveInt(merged.YCE_UPLOAD_TIMEOUT, null)
      : null,
    uploadConcurrency: hasOwn(merged, "YCE_UPLOAD_CONCURRENCY") && isNonEmptyString(merged.YCE_UPLOAD_CONCURRENCY)
      ? toOptionalPositiveInt(merged.YCE_UPLOAD_CONCURRENCY, null)
      : null,
    retrievalTimeout: hasOwn(merged, "YCE_RETRIEVAL_TIMEOUT") && isNonEmptyString(merged.YCE_RETRIEVAL_TIMEOUT)
      ? toOptionalPositiveInt(merged.YCE_RETRIEVAL_TIMEOUT, DEFAULTS.yceRetrievalTimeout)
      : null,
    noAdaptive: hasOwn(merged, "YCE_NO_ADAPTIVE") && isNonEmptyString(merged.YCE_NO_ADAPTIVE)
      ? toBoolean(merged.YCE_NO_ADAPTIVE, DEFAULTS.yceNoAdaptive)
      : false,
    noWebbrowserEnhancePrompt: hasOwn(merged, "YCE_NO_WEBBROWSER_ENHANCE_PROMPT") && isNonEmptyString(merged.YCE_NO_WEBBROWSER_ENHANCE_PROMPT)
      ? toBoolean(
          merged.YCE_NO_WEBBROWSER_ENHANCE_PROMPT,
          DEFAULTS.yceNoWebbrowserEnhancePrompt
        )
      : false,
  };
}

function loadRuntimeConfig() {
  const envFile = parseEnvFile(path.join(ROOT_DIR, ".env"));
  const merged = { ...envFile, ...process.env };
  const yceConfig = ensureYceToolConfigFile(merged.YCE_CONFIG || DEFAULTS.yceConfig);
  return {
    rootDir: ROOT_DIR,
    youwenScript: resolveYouwenScript(merged.YCE_YOUWEN_SCRIPT),
    yceSearchScript: resolveConfigPath(merged.YCE_SEARCH_SCRIPT || DEFAULTS.yceSearchScript),
    yceBinary: resolveConfigPath(merged.YCE_BINARY || DEFAULTS.yceBinary),
    yceConfig,
    ywEnhanceEnv: buildYwEnhanceEnv(merged),
    yceCliOptions: buildYceCliOptions(merged),
    defaultMode: merged.YCE_DEFAULT_MODE || DEFAULTS.defaultMode,
    timeoutEnhanceMs: toPositiveInt(merged.YCE_TIMEOUT_ENHANCE_MS, DEFAULTS.timeoutEnhanceMs),
    timeoutSearchMs: toPositiveInt(merged.YCE_TIMEOUT_SEARCH_MS, DEFAULTS.timeoutSearchMs),
  };
}

function parseArgs(argv) {
  const result = { _: [] };
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      result._.push(arg);
      index += 1;
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 2;
    } else {
      result[key] = true;
      index += 1;
    }
  }

  return result;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeQuery(args) {
  return args._.join(" ").trim();
}

function ensureAbsolutePath(inputPath) {
  if (!isNonEmptyString(inputPath)) {
    return inputPath;
  }
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }
  return path.resolve(process.cwd(), inputPath);
}

function fileExists(targetPath) {
  return isNonEmptyString(targetPath) && fs.existsSync(targetPath);
}

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function summarizeText(text, limit = 20) {
  if (!isNonEmptyString(text)) {
    return [];
  }
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function extractEnhancedBlock(rawStdout) {
  if (!isNonEmptyString(rawStdout)) {
    return null;
  }
  const match = rawStdout.match(/<enhanced>\s*([\s\S]*?)\s*<\/enhanced>/i);
  return match ? match[1].trim() : null;
}

function parseEnhancedContent(content) {
  const text = isNonEmptyString(content) ? content.trim() : "";
  if (!text) {
    return { recommendedSkills: [], prompt: null };
  }

  const recommendedSkills = [];
  let prompt = text;

  const promptMarker = /增强提示词正文[：:]/;
  const promptMatch = text.match(promptMarker);
  if (promptMatch) {
    const markerIndex = promptMatch.index;
    const before = text.slice(0, markerIndex).trim();
    const after = text.slice(markerIndex + promptMatch[0].length).trim();
    prompt = after || null;

    for (const line of before.split(/\r?\n/)) {
      const skillMatch = line.trim().match(/^\-\s*([^：:]+)[：:]/);
      if (skillMatch) {
        recommendedSkills.push(skillMatch[1].trim());
      }
    }
  } else {
    const lines = text.split(/\r?\n/);
    const promptLines = [];
    let inRecommendation = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (!inRecommendation) {
          promptLines.push(rawLine);
        }
        continue;
      }
      if (/^推荐技能[：:]?/.test(line)) {
        inRecommendation = true;
        continue;
      }
      if (inRecommendation) {
        const skillMatch = line.match(/^\-\s*([^：:]+)[：:]/);
        if (skillMatch) {
          recommendedSkills.push(skillMatch[1].trim());
          continue;
        }
        inRecommendation = false;
      }
      promptLines.push(rawLine);
    }
    prompt = promptLines.join("\n").trim() || null;
  }

  return {
    recommendedSkills: [...new Set(recommendedSkills)],
    prompt,
  };
}

const SEARCH_QUERY_STOP_PATTERNS = [
  /^#{1,6}\s+/,
  /^(期望输出规范|格式要求|结构约束|负向约束|必选字段|可选字段)\s*[：:]?$/i,
  /^(输出格式|语言|长度约束)\s*[：:].*$/i,
];

function normalizeSearchQuery(query, options = {}) {
  const text = isNonEmptyString(query) ? String(query).replace(/\r\n?/g, "\n").trim() : "";
  if (!text) {
    return "";
  }

  const {
    maxLength = 360,
    preserveSimpleQuery = true,
  } = options;

  if (preserveSimpleQuery && text.length <= maxLength && !text.includes("\n") && !/^\s*-/.test(text)) {
    return text;
  }

  const collected = [];
  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (/^```/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed)) {
      continue;
    }
    if (SEARCH_QUERY_STOP_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }

    let normalized = trimmed
      .replace(/^\d+[.)、]\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();

    if (!normalized) {
      continue;
    }

    collected.push(normalized);
    if (collected.join(" ").length >= maxLength) {
      break;
    }
  }

  const candidate = (collected.length > 0 ? collected.join(" ") : text)
    .replace(/\s+/g, " ")
    .replace(/^[-–—_\s]+/, "")
    .trim();

  if (!candidate) {
    return text;
  }

  if (candidate.length <= maxLength) {
    return candidate;
  }

  return candidate.slice(0, maxLength).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function buildError(source, code, message, extra = {}) {
  return { source, code, message, ...extra };
}

const QUOTA_PATTERNS = [
  /quota\s*(exceed|exhaust|used\s*up|reach|over|run\s*out)/i,
  /(insufficient|out\s*of)\s*(credit|balance|quota|fund|token)/i,
  /no\s*(remaining\s*)?(credit|balance|quota|fund)/i,
  /rate\s*limit\s*exceed/i,
  /payment\s*required/i,
  /billing/i,
  /subscription\s*(expired|required)/i,
  /(余额|额度|配额|计费)\s*(不足|耗尽|用尽|用完|超(出|限)|已满)/,
  /(无|没有)(剩余)?(余额|额度|配额)/,
  /欠费/,
  /(请)?充值/,
  /\b40[23]\b.*(quota|credit|balance|payment|billing)/i,
  /\b429\b.*(quota|credit|rate)/i,
];

function detectQuotaError(text) {
  if (!text) return false;
  const s = String(text);
  return QUOTA_PATTERNS.some((re) => re.test(s));
}

function xmlEscapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlEscapeAttr(value) {
  return xmlEscapeText(value).replace(/"/g, "&quot;");
}

function xmlCdata(value) {
  return `<![CDATA[${String(value).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function serializeForStdout(payload, pretty = false) {
  const lines = [];
  const indent = (level) => (pretty ? "  ".repeat(level) : "");

  const pushLine = (level, text) => {
    lines.push(`${indent(level)}${text}`);
  };

  const pushTextTag = (level, tagName, value, options = {}) => {
    const { cdata = false, always = false } = options;
    if (value === null || value === undefined || value === "") {
      if (always) {
        pushLine(level, `<${tagName}/>`);
      }
      return;
    }
    const serialized = cdata ? xmlCdata(value) : xmlEscapeText(value);
    pushLine(level, `<${tagName}>${serialized}</${tagName}>`);
  };

  const pushStringList = (level, wrapperTag, itemTag, items) => {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }
    pushLine(level, `<${wrapperTag}>`);
    for (const item of items) {
      pushTextTag(level + 1, itemTag, item, { cdata: true });
    }
    pushLine(level, `</${wrapperTag}>`);
  };

  pushLine(0, `<?xml version="1.0" encoding="UTF-8"?>`);
  pushLine(0, `<yce>`);
  pushTextTag(1, "success", payload.success === true ? "true" : "false");
  pushTextTag(1, "mode", payload.mode, { always: true });
  pushTextTag(1, "resolved-action", payload.resolved_action, { always: true });
  pushTextTag(1, "original-query", payload.original_query, { cdata: true, always: true });
  pushTextTag(1, "cwd", payload.cwd, { cdata: true, always: true });

  const degradation = payload.meta && payload.meta.degradation ? payload.meta.degradation : null;
  if (degradation && degradation.active === true) {
    pushLine(1, `<degraded active="true">`);
    pushTextTag(2, "summary", degradation.summary, { cdata: true, always: true });
    pushTextTag(2, "failed-stage", degradation.failed_stage, { always: true });
    pushTextTag(2, "search-query-source", degradation.search_query_source, { always: true });
    pushTextTag(2, "fallback-query", degradation.fallback_query, { cdata: true, always: true });
    if (degradation.error) {
      const attrs = [];
      if (degradation.error.source) {
        attrs.push(`source="${xmlEscapeAttr(degradation.error.source)}"`);
      }
      if (degradation.error.code) {
        attrs.push(`code="${xmlEscapeAttr(degradation.error.code)}"`);
      }
      pushLine(
        2,
        `<error${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>${xmlCdata(degradation.error.message || "")}</error>`
      );
    }
    pushLine(1, `</degraded>`);
  } else {
    pushLine(1, `<degraded active="false"/>`);
  }

  if (payload.enhance) {
    const attrs = [
      `executed="${xmlEscapeAttr(payload.enhance.executed === true ? "true" : "false")}"`,
      `success="${xmlEscapeAttr(payload.enhance.success === true ? "true" : "false")}"`,
      `used-history="${xmlEscapeAttr(payload.enhance.used_history === true ? "true" : "false")}"`,
    ].join(" ");
    pushLine(1, `<enhanced ${attrs}>`);
    pushTextTag(2, "prompt", payload.enhance.prompt, { cdata: true, always: true });
    pushStringList(2, "recommended-skills", "skill", payload.enhance.recommended_skills);
    pushTextTag(2, "raw-stdout", payload.enhance.raw_stdout, { cdata: true });
    pushStringList(2, "stderr-summary", "line", payload.enhance.stderr_summary);

    if (payload.enhance.raw_events_summary) {
      const rawEvents = payload.enhance.raw_events_summary;
      const rawAttrs = [
        `captured="${xmlEscapeAttr(rawEvents.captured === true ? "true" : "false")}"`,
      ];
      if (rawEvents.event_count !== undefined) {
        rawAttrs.push(`event-count="${xmlEscapeAttr(String(rawEvents.event_count))}"`);
      }
      pushLine(2, `<raw-events ${rawAttrs.join(" ")}>`); 
      pushTextTag(3, "error", rawEvents.error, { cdata: true });
      pushStringList(3, "event-types", "event-type", rawEvents.event_types);
      if (Array.isArray(rawEvents.preview) && rawEvents.preview.length > 0) {
        pushLine(3, `<preview>`);
        for (const previewItem of rawEvents.preview) {
          const previewAttrs = previewItem && previewItem.event
            ? ` event="${xmlEscapeAttr(previewItem.event)}"`
            : "";
          pushLine(4, `<event${previewAttrs}>`);
          pushStringList(5, "keys", "key", previewItem && Array.isArray(previewItem.keys) ? previewItem.keys : []);
          pushLine(4, `</event>`);
        }
        pushLine(3, `</preview>`);
      }
      pushLine(2, `</raw-events>`);
    }

    pushLine(1, `</enhanced>`);
  } else {
    pushLine(1, `<enhanced/>`);
  }

  if (payload.search) {
    const attrs = [
      `executed="${xmlEscapeAttr(payload.search.executed === true ? "true" : "false")}"`,
      `success="${xmlEscapeAttr(payload.search.success === true ? "true" : "false")}"`,
      `result-present="${xmlEscapeAttr(payload.search.result_present === true ? "true" : "false")}"`,
      `empty-result="${xmlEscapeAttr(payload.search.empty_result === true ? "true" : "false")}"`,
    ];
    if (payload.search.exit_code !== null && payload.search.exit_code !== undefined) {
      attrs.push(`exit-code="${xmlEscapeAttr(String(payload.search.exit_code))}"`);
    }
    pushLine(1, `<search ${attrs.join(" ")}>`);
    pushTextTag(2, "query", payload.search.query, { cdata: true, always: true });
    pushTextTag(2, "result", payload.search.raw_stdout, { cdata: true, always: true });
    pushStringList(2, "stderr-summary", "line", payload.search.stderr_summary);
    pushLine(1, `</search>`);
  } else {
    pushLine(1, `<search/>`);
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    pushLine(1, `<errors>`);
    for (const error of payload.errors) {
      const attrs = [];
      if (error.source) {
        attrs.push(`source="${xmlEscapeAttr(error.source)}"`);
      }
      if (error.code) {
        attrs.push(`code="${xmlEscapeAttr(error.code)}"`);
      }
      pushLine(2, `<error${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>${xmlCdata(error.message || "")}</error>`);
    }
    pushLine(1, `</errors>`);
  } else {
    pushLine(1, `<errors/>`);
  }

  if (payload.meta) {
    pushLine(1, `<meta>`);
    if (payload.meta.durations_ms) {
      pushLine(2, `<durations-ms>`);
      pushTextTag(3, "enhance", payload.meta.durations_ms.enhance ?? 0);
      pushTextTag(3, "search", payload.meta.durations_ms.search ?? 0);
      pushTextTag(3, "total", payload.meta.durations_ms.total ?? 0);
      pushLine(2, `</durations-ms>`);
    }

    if (payload.meta.dependency_paths) {
      pushLine(2, `<dependency-paths>`);
      pushTextTag(3, "yw-enhance-script", payload.meta.dependency_paths.yw_enhance_script, { cdata: true, always: true });
      pushTextTag(3, "yce-search-script", payload.meta.dependency_paths.yce_search_script, { cdata: true, always: true });
      pushTextTag(3, "yce-binary", payload.meta.dependency_paths.yce_binary, { cdata: true, always: true });
      pushTextTag(3, "yce-config", payload.meta.dependency_paths.yce_config, { cdata: true, always: true });
      pushLine(2, `</dependency-paths>`);
    }

    pushTextTag(2, "timestamp", payload.meta.timestamp, { always: true });
    pushLine(1, `</meta>`);
  } else {
    pushLine(1, `<meta/>`);
  }

  pushLine(0, `</yce>`);
  return pretty ? lines.join("\n") : lines.join("");
}

function runCommand(command, args, options = {}) {
  const { cwd, timeoutMs, env } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
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
          setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr: stderr || error.message,
        exitCode: null,
        timedOut,
        signal: null,
        spawnError: error,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        signal,
        spawnError: null,
      });
    });
  });
}

module.exports = {
  ROOT_DIR,
  buildError,
  detectQuotaError,
  detectBinaryFilename,
  detectPlatformDir,
  detectSearchScript,
  ensureYceToolConfigFile,
  ensureAbsolutePath,
  expandHomePath,
  extractEnhancedBlock,
  fileExists,
  isDirectory,
  isNonEmptyString,
  loadRuntimeConfig,
  normalizeSearchQuery,
  normalizeQuery,
  nowIso,
  parseArgs,
  parseEnhancedContent,
  resolveConfigPath,
  resolveYouwenScript,
  runCommand,
  serializeForStdout,
  summarizeText,
  toPositiveInt,
};
