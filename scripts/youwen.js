#!/usr/bin/env node

/**
 * 优问多 Agent 智能增强 CLI
 *
 * 连接优问后端 API，提供完整的 4-Agent 流水线增强能力。
 *
 * 流水线: Agent1(摘要) → Agent2(意图) → Agent3(搜索) → Agent4(综合)
 * 搜索引擎: Grok / Perplexity / Exa / Context7 / DeepWiki
 * 语义检索增强: Mixedbread（流水线内部自动使用）
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ==================== 配置 ====================

const DEFAULT_API_URL = "https://b.aigy.de";

function loadConfig() {
  let apiUrl = process.env.YOUWEN_API_URL || DEFAULT_API_URL;
  let mgrepApiKey = process.env.YOUWEN_MGREP_API_KEY || "";
  let token = process.env.YOUWEN_TOKEN || "";
  let enhanceMode = process.env.YOUWEN_ENHANCE_MODE || "agent";
  let enableSearch = process.env.YOUWEN_ENABLE_SEARCH !== "false";

  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, key, rawVal] = m;
      const val = rawVal.replace(/^["']|["']$/g, "").trim();
      if (key === "YOUWEN_API_URL" && val) apiUrl = val;
      if (key === "YOUWEN_MGREP_API_KEY" && val) mgrepApiKey = val;
      if (key === "YOUWEN_TOKEN" && val) token = val;
      if (key === "YOUWEN_ENHANCE_MODE" && val) enhanceMode = val;
      if (key === "YOUWEN_ENABLE_SEARCH") enableSearch = val !== "false";
    }
  }

  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    mgrepApiKey,
    token,
    enhanceMode,
    enableSearch,
  };
}

const config = loadConfig();

// ==================== HTTP / SSE ====================

/**
 * Send POST request and consume SSE stream, calling onEvent for each parsed event.
 * Returns a promise that resolves when the stream ends.
 * @param {string} endpoint - API endpoint path
 * @param {object} body - Request body
 * @param {function} onEvent - Event callback (event, data)
 * @param {number} timeout - Timeout in ms
 * @param {object} options - Additional options: { customHeaders, bearerToken }
 */
function postSSE(endpoint, body, onEvent, timeout = 300000, options = {}) {
  return new Promise(async (resolve, reject) => {
    const requestBody = JSON.stringify(body);
    const url = new URL(`${config.apiUrl}${endpoint}`);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(requestBody),
      Accept: "text/event-stream",
      ...options.customHeaders,
    };
    if (options.bearerToken) {
      headers["Authorization"] = `Bearer ${options.bearerToken}`;
    }

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers,
      timeout,
    };

    const req = httpModule.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`)));
        return;
      }

      let buffer = "";
      let currentEvent = "message";

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            if (dataStr === "keep-alive") continue;
            try {
              const data = JSON.parse(dataStr);
              onEvent(currentEvent, data);
            } catch {
              onEvent(currentEvent, { raw: dataStr });
            }
            currentEvent = "message";
          }
        }
      });

      res.on("end", () => resolve());
      res.on("error", reject);
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`请求超时 (${timeout / 1000}s)`)); });
    req.write(requestBody);
    req.end();
  });
}

// ==================== 命令实现 ====================

/**
 * enhance - 多 Agent 流水线增强
 * 使用 /api/skill/enhance (Bearer auth with token)
 */
async function enhance(prompt, opts = {}) {
  // Respect .env defaults: YOUWEN_ENHANCE_MODE=disabled skips the pipeline
  if (config.enhanceMode === "disabled" && !opts.force) {
    console.log(prompt);
    return;
  }

  const enableSearch = opts.noSearch === true ? false : config.enableSearch;
  const token = opts.token || config.token;

  const body = {
    prompt,
    conversation_history: opts.history || "",
    context_files: [],
    agent_config: {
      enable_summary: true,
      enable_intent_analysis: true,
      enable_search: enableSearch,
      search_engines: ["grok", "perplexity", "exa", "context7", "deepwiki"],
      auto_confirm_intent: true,  // 默认自动确认意图，跳过交互
    },
  };

  // Optional fields
  if (opts.confirmedIntent) {
    body.confirmed_intent = opts.confirmedIntent;
  }
  if (opts.mgrepKey || config.mgrepApiKey) {
    body.mgrep_api_key = opts.mgrepKey || config.mgrepApiKey;
  }

  // Skill 上下文注入：把全量已安装 skill 传给后端，让 AI 全权决策推荐
  if (opts.skillsDir || opts.autoSkills) {
    const extraDirs = opts.skillsDir ? [opts.skillsDir] : [];
    const skills = scanAllSkills(extraDirs);
    if (skills.length) {
      body.installed_skills = skills.map(s => ({
        name: s.name,
        description: (s.description || "").slice(0, 300),
        triggers: s.triggers,
        quickStart: s.quickStart || null,
      }));

      if (!opts.json) {
        console.error(`🔍 已安装 ${skills.length} 个 Skill，交由 AI 决策推荐`);
      }
    }
  }

  const endpoint = "/api/skill/enhance";
  const sseOptions = token ? { bearerToken: token } : {};

  if (opts.json) {
    // Non-stream: collect all events and output JSON
    const events = [];
    await postSSE(endpoint, body, (event, data) => {
      events.push({ event, data });
    }, 300000, sseOptions);
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  // Collect result, show agent status on stderr, output final answer to stdout
  let finalAnswer = "";
  let tokenUsage = null;
  let error = null;
  const agentStatus = {
    agent1: { name: "上下文处理", status: "pending" },
    agent2: { name: "意图分析", status: "pending" },
    agent3: { name: "联合搜索", status: "pending" },
    agent4: { name: "增强提示", status: "pending" },
  };

  const fmtDuration = (ms) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  console.error("⚡ Multi-Agent 处理中…");

  await postSSE(endpoint, body, (event, data) => {
    // Agent 1
    if (event === "agent1_start") {
      agentStatus.agent1.status = "running";
    } else if (event === "agent1_complete") {
      agentStatus.agent1.status = "done";
      agentStatus.agent1.duration = data.duration_ms;
    } else if (event === "agent1_error") {
      agentStatus.agent1.status = "failed";

    // Agent 2
    } else if (event === "agent2_start") {
      agentStatus.agent2.status = "running";
    } else if (event === "agent2_complete") {
      agentStatus.agent2.status = data.result?.skipped ? "skipped" : "done";
      agentStatus.agent2.duration = data.duration_ms;
    } else if (event === "agent2_needs_confirmation") {
      agentStatus.agent2.status = "needs_confirm";
      error = `意图歧义，需确认:\n  问题: ${data.clarified_question}\n  备选: ${(data.alternatives || []).join(", ")}\n\n请使用 --confirmed-intent "你的选择" 重新提交`;
    } else if (event === "agent2_error") {
      agentStatus.agent2.status = "failed";

    // Agent 3
    } else if (event === "agent3_start") {
      agentStatus.agent3.status = "running";
    } else if (event === "agent3_complete") {
      agentStatus.agent3.status = data.result?.skipped ? "skipped" : "done";
      agentStatus.agent3.duration = data.duration_ms;
    } else if (event === "agent3_error") {
      agentStatus.agent3.status = "failed";

    // Agent 4
    } else if (event === "agent4_start") {
      agentStatus.agent4.status = "running";
    } else if (event === "agent4_reset") {
      finalAnswer = "";
    } else if (event === "agent4_chunk" && data.chunk) {
      finalAnswer += data.chunk;
    } else if (event === "agent4_complete") {
      agentStatus.agent4.status = "done";
      agentStatus.agent4.duration = data.duration_ms;

    // Pipeline
    } else if (event === "pipeline_complete") {
      tokenUsage = data.token_usage;
    } else if (event === "error" || event === "forbidden") {
      error = data.error || "Pipeline failed";
    }
  }, 300000, sseOptions);

  // Print agent status summary
  for (const [, info] of Object.entries(agentStatus)) {
    const dur = info.duration ? ` ${fmtDuration(info.duration)}` : "";
    if (info.status === "done") {
      console.error(`  ✔ ${info.name}${dur}`);
    } else if (info.status === "skipped") {
      console.error(`  - ${info.name} 跳过`);
    } else if (info.status === "failed") {
      console.error(`  ✘ ${info.name} 失败`);
    } else if (info.status === "needs_confirm") {
      console.error(`  ⚠ ${info.name} 需确认`);
    } else {
      console.error(`  · ${info.name} 未执行`);
    }
  }

  if (error) {
    console.error(`\n错误: ${error}`);
    process.exit(1);
  }

  // Output final enhanced result to stdout using XML tags (best LLM parsing accuracy)
  if (finalAnswer) {
    console.error("");
    console.log("<enhanced>");
    console.log(finalAnswer);
    console.log("</enhanced>");
  } else {
    console.error("\n⚠ 未获得增强结果");
    process.exit(1);
  }

  if (tokenUsage) {
    console.error(`\n--- Token 统计 ---`);
    console.error(`输入: ${tokenUsage.input_tokens} | 输出: ${tokenUsage.output_tokens} | 总计: ${tokenUsage.total_tokens}`);
  }
}

// ==================== Skill 扫描与路由 ====================

// Skill 扫描缓存（内存缓存，避免重复扫描文件系统）
let skillScanCache = null;
let skillScanCacheTime = 0;
const SKILL_CACHE_TTL = 60000; // 60秒缓存

/**
 * 解析 SKILL.md 的 YAML frontmatter
 */
function parseSkillFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};

  // 简易 YAML 解析（支持 name, version, description, user-invocable）
  let currentKey = null;
  let multilineValue = "";
  let inMultiline = false;

  for (const line of yaml.split("\n")) {
    if (inMultiline) {
      if (/^\S/.test(line) && !line.startsWith("  ")) {
        // New key, end multiline
        result[currentKey] = multilineValue.trim();
        inMultiline = false;
      } else {
        multilineValue += line.replace(/^  /, "") + "\n";
        continue;
      }
    }

    const kvMatch = line.match(/^(\S[\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === "|" || val === ">") {
        inMultiline = true;
        multilineValue = "";
      } else {
        result[currentKey] = val.replace(/^["']|["']$/g, "");
      }
    }
  }

  if (inMultiline && currentKey) {
    result[currentKey] = multilineValue.trim();
  }

  return result;
}

/**
 * 从 description 中提取触发词
 */
function extractTriggers(description) {
  if (!description) return [];

  const triggers = [];

  // 匹配多种中文触发词标签：触发词、smart 模式额外触发、额外触发、自动触发 等
  const cnPatterns = [
    /触发词[：:]\s*([^\n【]+)/g,
    /(?:smart\s*模式)?额外触发[：:]\s*([^\n【]+)/g,
    /自动触发[：:]\s*([^\n【]+)/g,
  ];

  for (const pattern of cnPatterns) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      const raw = match[1];
      triggers.push(...raw.split(/[、,，\/]/).map(t => t.trim()).filter(Boolean));
    }
  }

  // 英文 Triggers / Smart triggers
  const enPatterns = [
    /Triggers?[：:]\s*([^\n.]+)/gi,
    /Smart\s+triggers?[：:]\s*([^\n.]+)/gi,
  ];

  for (const pattern of enPatterns) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      const raw = match[1];
      triggers.push(...raw.split(/[,，]/).map(t => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    }
  }

  // 关键词/Keywords 标签
  const kwPatterns = [
    /关键词[：:]\s*([^\n【]+)/g,
    /Keywords?[：:]\s*([^\n.]+)/gi,
    /触发关键词[：:]\s*([^\n【]+)/g,
    /激活词[：:]\s*([^\n【]+)/g,
    /Activation\s+(?:words?|keywords?)[：:]\s*([^\n.]+)/gi,
  ];

  for (const pattern of kwPatterns) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      const raw = match[1];
      triggers.push(...raw.split(/[、,，\/]/).map(t => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    }
  }

  return [...new Set(triggers)];
}

/**
 * 扫描目录下所有 skill，解析 SKILL.md
 */
function scanSkillsDir(skillsDir) {
  const skills = [];

  if (!fs.existsSync(skillsDir)) {
    return skills;
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;

    const skillPath = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillPath, "SKILL.md");

    // 如果是符号链接，解析真实路径
    let realPath = skillPath;
    try {
      realPath = fs.realpathSync(skillPath);
    } catch { /* ignore */ }

    if (!fs.existsSync(skillMdPath)) {
      // 尝试解析后的路径
      const realSkillMd = path.join(realPath, "SKILL.md");
      if (!fs.existsSync(realSkillMd)) continue;
    }

    try {
      const mdPath = fs.existsSync(skillMdPath) ? skillMdPath : path.join(realPath, "SKILL.md");
      const content = fs.readFileSync(mdPath, "utf8");
      const meta = parseSkillFrontmatter(content);
      if (!meta) continue;

      const triggers = extractTriggers(meta.description || "");

      // 提取快速开始命令
      const quickStartMatch = content.match(/```(?:bash|sh)\n(node\s+[^\n]+|bun\s+[^\n]+)/);
      const quickStart = quickStartMatch ? quickStartMatch[1] : null;

      // 提取正文摘要（frontmatter 之后的前 500 字符）
      const bodyStart = content.indexOf("---", 4);
      const body = bodyStart > 0 ? content.slice(bodyStart + 3).trim() : "";
      const summary = body.slice(0, 500);

      skills.push({
        id: entry.name,
        name: meta.name || entry.name,
        version: meta.version || null,
        description: meta.description || "",
        triggers,
        quickStart,
        summary,
        path: realPath,
        userInvocable: meta["user-invocable"] === "true" || meta["user-invocable"] === true,
      });
    } catch (e) {
      // Skip unreadable skills
    }
  }

  return skills;
}

/**
 * 获取默认 skill 目录列表
 */
function getDefaultSkillDirs() {
  const dirs = [];
  const home = process.env.HOME || process.env.USERPROFILE || "";

  const candidates = [
    path.join(home, ".claude", "skills"),
    path.join(home, ".config", "opencode", "skill"),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      dirs.push(dir);
    }
  }

  return dirs;
}

/**
 * 扫描所有默认目录 + 自定义目录（带缓存）
 */
function scanAllSkills(extraDirs = []) {
  const now = Date.now();
  const cacheKey = JSON.stringify(extraDirs);

  // 检查缓存是否有效
  if (skillScanCache && skillScanCacheTime > 0 && (now - skillScanCacheTime) < SKILL_CACHE_TTL) {
    if (skillScanCache.cacheKey === cacheKey) {
      return skillScanCache.skills;
    }
  }

  const allDirs = [...getDefaultSkillDirs(), ...extraDirs];
  const seen = new Set();
  const skills = [];

  for (const dir of allDirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const found = scanSkillsDir(resolved);
    for (const skill of found) {
      // 去重（同名 skill 只保留第一个）
      if (!seen.has(`skill:${skill.name}`)) {
        seen.add(`skill:${skill.name}`);
        skills.push({ ...skill, sourceDir: resolved });
      }
    }
  }

  // 更新缓存
  skillScanCache = { cacheKey, skills };
  skillScanCacheTime = now;

  return skills;
}

// ==================== 版本检测 ====================

const SKILL_NAME = "yw-enhance";

/**
 * 读取本地 SKILL.md 中的版本号
 */
function getLocalVersion() {
  try {
    const skillMd = path.join(__dirname, "..", "SKILL.md");
    const content = fs.readFileSync(skillMd, "utf8");
    const meta = parseSkillFrontmatter(content);
    return meta?.version || null;
  } catch {
    return null;
  }
}

/**
 * 简易 semver 比较: a < b 返回 -1, a == b 返回 0, a > b 返回 1
 */
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

/**
 * 获取版本缓存路径
 */
function getVersionCachePath() {
  return path.join(__dirname, "..", ".version-cache.json");
}

/**
 * 向后端查询最新版本（非阻塞，静默失败）
 */
function checkRemoteVersion(token) {
  return new Promise((resolve) => {
    const url = new URL(`${config.apiUrl}/api/skill/version?name=${SKILL_NAME}`);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const headers = { Accept: "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = httpModule.get({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: 5000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({
            version: json.version || json.latest_version || null,
            downloadUrl: json.downloadUrl || null,
          });
        } catch {
          resolve({ version: null, downloadUrl: null });
        }
      });
    });

    req.on("error", () => resolve({ version: null, downloadUrl: null }));
    req.on("timeout", () => { req.destroy(); resolve({ version: null, downloadUrl: null }); });
  });
}

/**
 * 执行版本检测（非阻塞，后台异步）
 * 不阻塞主流程，仅在有新版本时输出提示到 stderr
 */
async function checkForUpdateNonBlocking(token) {
  const localVersion = getLocalVersion();
  if (!localVersion) return;

  // 异步执行，不阻塞主流程
  checkRemoteVersion(token).then(remote => {
    // 写入缓存
    try {
      const cache = { lastCheck: new Date().toISOString(), localVersion, remoteVersion: remote.version, downloadUrl: remote.downloadUrl };
      fs.writeFileSync(getVersionCachePath(), JSON.stringify(cache, null, 2));
    } catch { /* ignore */ }

    if (remote.version && compareSemver(localVersion, remote.version) < 0) {
      console.error(``);
      console.error(`🔔 ${SKILL_NAME} 有新版本可用: ${localVersion} → ${remote.version}`);
      if (remote.downloadUrl) {
        console.error(`   下载地址: ${remote.downloadUrl}`);
      }
      console.error(`   更新命令: bash <skill-dir>/install.sh`);
      console.error(``);
    }
  }).catch(() => { /* 静默失败 */ });
}

// ==================== CLI ====================

function printUsage() {
  console.log(`
优问多 Agent 智能增强 CLI

用法:
  node youwen.js <command> [options]

命令:
  enhance <prompt>    多 Agent 流水线增强（4-Agent: 摘要→意图→搜索→综合）

enhance 选项:
  --history <text>          对话历史上下文
  --auto-confirm            自动确认意图（跳过歧义确认）
  --no-search               禁用 Agent 3 搜索
  --confirmed-intent <text> 确认的意图（歧义确认后重新提交）
  --json                    输出原始 JSON（所有 SSE 事件）
  --token <code>            兑换码（使用 Bearer auth，也可通过 YOUWEN_TOKEN 配置）
  --mgrep-key <key>         Mixedbread API Key（增强语义检索，也可通过 YOUWEN_MGREP_API_KEY 配置）
  --skills-dir <path>       Skill 目录（自动扫描并注入匹配的 Skill 上下文）
  --auto-skills             自动扫描默认 Skill 目录并注入上下文
  --force                   强制执行（忽略 YOUWEN_ENHANCE_MODE=disabled）

示例:
  # 基础增强
  node youwen.js enhance "帮我写一个 React 登录组件"

  # 使用兑换码（Bearer auth）
  node youwen.js enhance "优化这段代码" --token "CODE-XXXX"

  # 增强 + 自动注入 Skill 上下文
  node youwen.js enhance "React useEffect 异步请求" --auto-skills

  # 增强 + 指定 Skill 目录
  node youwen.js enhance "搜索最新 AI 新闻" --skills-dir ~/.claude/skills

  # 带对话历史
  node youwen.js enhance "优化这段代码" --history "之前讨论了性能问题..."

环境变量:
  YOUWEN_API_URL          优问后端地址 (默认 ${DEFAULT_API_URL})
  YOUWEN_TOKEN            兑换码（默认 Bearer auth token）
  YOUWEN_ENHANCE_MODE     增强模式: agent（默认）/ disabled（关闭）
  YOUWEN_ENABLE_SEARCH    联合搜索: true（默认）/ false（关闭）
  YOUWEN_MGREP_API_KEY    Mixedbread API Key
`);
}

function parseArgs(args) {
  const result = { _: [], files: [] };
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--file") {
      if (args[i + 1] && !args[i + 1].startsWith("--")) {
        result.files.push(args[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        result[key] = nextArg;
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      result._.push(arg);
      i += 1;
    }
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const input = args._.slice(1).join(" ");

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  try {
    switch (command) {
      case "enhance": {
        if (!input && !args.history) {
          console.error("错误: 请提供提示词或对话历史");
          console.error("用法: node youwen.js enhance <prompt> [options]");
          process.exit(1);
        }

        // 后台异步检查版本更新，不阻塞主流程
        checkForUpdateNonBlocking(args.token || config.token);

        await enhance(input, {
          history: args.history,
          autoConfirm: args["auto-confirm"] === true,
          noSearch: args["no-search"] === true,
          confirmedIntent: args["confirmed-intent"],
          json: args.json === true,
          token: args.token,
          mgrepKey: args["mgrep-key"],
          skillsDir: args["skills-dir"],
          autoSkills: args["auto-skills"] === true,
          force: args.force === true,
        });
        break;
      }

      default:
        console.error(`错误: 未知命令 '${command}'`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error(JSON.stringify({
      status: "error",
      error_type: error.constructor.name,
      message: error.message,
    }, null, 2));
    process.exit(1);
  }
}

main();
