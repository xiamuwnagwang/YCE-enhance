/**
 * YCE Engine — core protocol implementation (Node.js).
 *
 * YCE semantic code search engine.
 *
 * Flow:
 *   query + tree → YCE semantic search API
 *   → YCE returns tool_calls (rg/readfile/tree/ls/glob, plus a strict Windows process query)
 *   → execute locally → send results back → repeat for N rounds
 *   → ANSWER: file paths + line ranges + suggested rg patterns
 */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, relative, sep, isAbsolute, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { platform, arch, release, version as osVersion, hostname, cpus, totalmem, homedir } from "node:os";

import {
  ProtobufEncoder,
  extractStrings,
  connectFrameEncode,
  connectFrameDecode,
} from "./protobuf.mjs";
import { ToolExecutor } from "./executor.mjs";
import { scoreDirectories, tokenize as tokenizeBM25 } from "./directory-scorer.mjs";
import { buildDirectoryTree } from "./tree-builder.mjs";

// ─── Error Classification ──────────────────────────────────

/**
 * Classified error for fetch failures with structured error codes.
 */
class YceEngineError extends Error {
  /**
   * @param {string} message
   * @param {string} code - TIMEOUT | PAYLOAD_TOO_LARGE | TRANSIENT_CAPACITY | RATE_LIMITED | AUTH_ERROR | SERVER_ERROR | NETWORK_ERROR
   * @param {Object} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "YceEngineError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Undici wraps socket-level failures as TypeError("fetch failed", { cause }).
 * Walk the cause chain for the first concrete error code (ECONNRESET,
 * UND_ERR_CONNECT_TIMEOUT, ...) so classification and diagnostics keep it.
 * @param {Error} err
 * @returns {string}
 */
function _extractCauseCode(err) {
  let cause = err?.cause;
  for (let depth = 0; depth < 4 && cause; depth++) {
    if (typeof cause.code === "string" && cause.code) return cause.code;
    cause = cause.cause;
  }
  return "";
}

/**
 * Classify a raw fetch/HTTP error into a YceEngineError.
 * @param {Error} err
 * @returns {YceEngineError}
 */
function _classifyError(err) {
  if (err instanceof YceEngineError) return err;

  // HTTP status-based classification
  if (err.status) {
    const s = err.status;
    const details = {
      status: s,
      relayCode: String(err.relayCode || "").trim() || undefined,
      errorSource: String(err.errorSource || "").trim() || undefined,
    };
    if (s === 413) return new YceEngineError(err.message, "PAYLOAD_TOO_LARGE", details);
    if (s === 429) return new YceEngineError(err.message, "RATE_LIMITED", details);
    if (s === 401 || s === 403) return new YceEngineError(err.message, "AUTH_ERROR", details);
    return new YceEngineError(err.message, "SERVER_ERROR", details);
  }

  const causeCode = _extractCauseCode(err);
  const message = causeCode ? `${err.message} (${causeCode})` : err.message;
  const details = causeCode ? { cause: causeCode } : {};

  // Timeout (AbortSignal.timeout throws AbortError or TimeoutError; undici
  // connect-phase hangs surface as UND_ERR_CONNECT_TIMEOUT / ETIMEDOUT)
  if (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    /timeout/i.test(err.message) ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    causeCode === "ETIMEDOUT"
  ) {
    return new YceEngineError(message, "TIMEOUT", details);
  }

  // Everything else is a network-level issue
  return new YceEngineError(message, "NETWORK_ERROR", details);
}

function _isTransientCapacitySignal({ status = null, code = "", message = "" } = {}) {
  if (status === 429) return true;
  const normalized = `${code} ${message}`.toLowerCase();
  return normalized.includes("resource_exhausted") ||
    normalized.includes("rate limit") ||
    normalized.includes("rate_limit") ||
    normalized.includes("quota exceeded");
}

// ─── Protocol Constants ────────────────────────────────────

// YCE remote inference protocol endpoints and client metadata.
// Defaults go through the public YCE relay (yce.aigy.de) so clients never
// address third-party hosts. Relay requires Bearer YCE_RELAY_TOKEN + X-YCE-Lease-Id.
const DEFAULT_YCE_RELAY_ORIGIN = "https://yce.aigy.de";
const API_BASE =
  process.env.YCE_API_BASE ||
  `${DEFAULT_YCE_RELAY_ORIGIN}/yce/api`;
const AUTH_BASE =
  process.env.YCE_AUTH_BASE ||
  `${DEFAULT_YCE_RELAY_ORIGIN}/yce/auth`;
const YCE_REMOTE_APP_ID = process.env.YCE_REMOTE_APP_ID || "yce";
const YCE_REMOTE_APP_VER = process.env.YCE_REMOTE_APP_VER || process.env.WS_APP_VER || "1.48.2";
const YCE_REMOTE_LS_VER = process.env.YCE_REMOTE_LS_VER || process.env.WS_LS_VER || "1.9544.35";
const YCE_REMOTE_MODEL = process.env.YCE_REMOTE_MODEL || process.env.WS_MODEL || "MODEL_SWE_1_6_FAST";
const DEBUG_MODE = process.env.YCE_ENGINE_DEBUG === "1" || process.env.YCE_ENGINE_DEBUG === "true" || process.env.FAST_CONTEXT_DEBUG === "1" || process.env.FAST_CONTEXT_DEBUG === "true";

// ─── Transport Tuning ──────────────────────────────────────

// undici's default global dispatcher keeps idle sockets for only 4s and waits
// 10s for TCP/TLS connect. Search turns are seconds apart, so with defaults
// every turn pays a fresh TLS handshake (~1-1.6s to the relay). Swap in an
// Agent tuned for this call pattern via the documented global-dispatcher
// symbol, so the vendored engine needs no undici dependency. If the runtime
// doesn't expose the symbol, fetch keeps its stock behavior.
const _GLOBAL_DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");
// Captured at module load so test stubs that replace globalThis.fetch never
// see the dispatcher-priming request below.
const _realFetch = globalThis.fetch;
let _dispatcherInstalled = false;

async function _installTunedDispatcher() {
  if (_dispatcherInstalled) return;
  _dispatcherInstalled = true;
  if (process.env.YCE_DISPATCHER_TUNING === "0") return;
  if (typeof _realFetch !== "function") return;
  try {
    // A data: URL fetch forces undici to lazily create its global dispatcher
    // without touching the network, giving us the Agent constructor.
    await _realFetch("data:text/plain,");
    const current = globalThis[_GLOBAL_DISPATCHER_SYMBOL];
    const Agent = current?.constructor;
    if (typeof Agent !== "function") return;
    globalThis[_GLOBAL_DISPATCHER_SYMBOL] = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connect: { timeout: 5_000 },
    });
  } catch {
    // Tuning is best-effort; stock fetch behavior remains correct.
  }
}

// Default excludes aligned with YCE fast-search guidance.
// Minimal defaults — only dirs that are almost never source code.
// Users can add more via the exclude_paths parameter.
const DEFAULT_EXCLUDE_PATHS = [
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "*.min.*",
];

// Repo-map optimization defaults (tunable via MCP params).
const REPO_MAP_OPTIMIZER_DEFAULTS = {
  mode: "bootstrap_hotspot", // classic | bootstrap_hotspot
  bootstrapTreeDepth: 1,
  hotspotTopK: 4,
  hotspotTreeDepth: 2,
  maxBytes: 120 * 1024,
};

function _mergeExcludePaths(excludePaths = []) {
  const merged = [...DEFAULT_EXCLUDE_PATHS];
  for (const p of excludePaths || []) {
    if (typeof p === "string" && p && !merged.includes(p)) {
      merged.push(p);
    }
  }
  return merged;
}

// ─── System Prompt Template ────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are an expert software engineer, responsible for providing context \
to another engineer to solve a code issue in the current codebase. \
The user will present you with a description of the issue, and it is \
your job to provide a series of file paths with associated line ranges \
that contain ALL the information relevant to understand and correctly \
address the issue.

# IMPORTANT:
- A relevant file does not mean only the files that must be modified to \
solve the task. It means any file that contains information relevant to \
planning and implementing the fix, such as the definitions of classes \
and functions that are relevant to the pieces of code that will have to \
be modified.
- You should include enough context around the relevant lines to allow \
the engineer to understand the task correctly. You must include ENTIRE \
semantic blocks (functions, classes, definitions, etc). For example:
If addressing the issue requires modifying a method within a class, then \
you should include the entire class definition, not just the lines around \
the method we want to modify.
- NEVER truncate these blocks unless they are very large (hundreds of \
lines or more, in which case providing only a relevant portion of the \
block is acceptable).
- Your job is to essentially alleviate the job of the other engineer by \
giving them a clean starting context from which to start working. More \
precisely, you should minimize the number of files the engineer has to \
read to understand and solve the task correctly (while not providing \
irrelevant code snippets).

# ENVIRONMENT
- Working directory: /codebase. Make sure to run commands in this \
directory, not \`.
- Tool access: use the restricted_exec tool ONLY
- Allowed sub-commands (schema-enforced):
  - rg: Search for patterns in files using ripgrep
    - Required: pattern (string), path (string)
    - Optional: include (array of globs), exclude (array of globs)
  - readfile: Read contents of a file with optional line range
    - Required: file (string)
    - Optional: start_line (int), end_line (int) — 1-indexed, inclusive
  - tree: Display directory structure as a tree
    - Required: path (string)
    - Optional: levels (int)
  - powershell: Windows-only process query; this is not a general shell
    - Required: command (string)
    - Allowed shapes: the exact legacy Get-CimInstance Win32_Process or the strict -Filter "ProcessId = ... OR ProcessId = ..." form

# THINKING RULES
- Think step-by-step. Plan, reason, and reflect before each tool call.
- Use tool calls liberally and purposefully to ground every conclusion \
in real code, not assumptions.
- If a command fails, rethink and try something different; do not \
complain to the user.
- AVOID REDUNDANT SEARCHES: Do not search for the same pattern multiple \
times with slightly different paths or excludes. One well-targeted search \
is better than multiple overlapping ones.
- PRIORITIZE READING over searching: Once you find a file path, read it \
directly instead of searching for more variations of the same pattern.

# FAST-SEARCH DEFAULTS (optimize rg/tree on large repos)
- Start NARROW, then widen only if needed. Prefer searching likely code \
roots first (e.g., \`src/\`, \`lib/\`, \`app/\`, \`packages/\`, \`services/\`) \
instead of \`/codebase\`.
- Prefer fixed-string search for literals: escape patterns or keep regex \
simple. Use smart case; avoid case-insensitive unless necessary.
- Prefer file-type filters and globs (in include) over full-repo scans.
- Default EXCLUDES for speed (apply via the exclude array): \
node_modules, .git, dist, build, coverage, .venv, venv, target, out, \
.cache, __pycache__, vendor, deps, third_party, logs, data, *.min.*
- Skip huge files where possible; when opening files, prefer reading \
only relevant ranges with readfile.
- Limit directory traversal with tree levels to quickly orient before \
deeper inspection.

# SOME EXAMPLES OF WORKFLOWS
- MAP – Use \`tree\` with small levels; \`rg\` on likely roots to grasp \
structure and hotspots.
- ANCHOR – \`rg\` for problem keywords and anchor symbols; restrict by \
language globs via include.
- TRACE – Follow imports with targeted \`rg\` in narrowed roots; open \
files with \`readfile\` scoped to entire semantic blocks.
- VERIFY – Confirm each candidate path exists by reading or additional \
searches; drop false positives (tests, vendored, generated) unless they \
must change.

# TOOL USE GUIDELINES
- You must use a SINGLE restricted_exec call in your answer, that lets \
you execute at most {max_commands} commands in a single turn. Each command must be \
an object with a \`type\` field of \`rg\`, \`readfile\`, \`tree\`, \`ls\`, \`glob\`, or the strictly allowlisted \`powershell\` process-query type and the appropriate fields for that type.
- Example restricted_exec usage:
[TOOL_CALLS]restricted_exec[ARGS]{{
  "command1": {{
    "type": "rg",
    "pattern": "Controller",
    "path": "/codebase/slime",
    "include": ["**/*.py"],
    "exclude": ["**/node_modules/**", "**/.git/**", "**/dist/**", \
"**/build/**", "**/.venv/**", "**/__pycache__/**"]
  }},
  "command2": {{
    "type": "readfile",
    "file": "/codebase/slime/train.py",
    "start_line": 1,
    "end_line": 200
  }},
  "command3": {{
    "type": "tree",
    "path": "/codebase/slime/",
    "levels": 2
  }}
}}
- You have at most {max_turns} turns to interact with the environment by calling \
tools, so issuing multiple commands at once is necessary and encouraged \
to speed up your research.
- Each command result may be truncated to 50 lines; prefer multiple \
targeted reads/searches to build complete context.
- DO NOT EVER USE MORE THAN {max_commands} commands in a single turn, or you will \
be penalized.

# ANSWER FORMAT (strict format, including tags)
- You will output an XML structure with a root element "ANSWER" \
containing "file" elements. Each "file" element will have a "path" \
attribute and contain "range" elements.
- You will output this as your final response.
- The line ranges must be inclusive.

Output example inside the "answer" tool argument:
<ANSWER>
  <file path="/codebase/info_theory/formulas/entropy.py">
    <range>10-60</range>
    <range>150-210</range>
  </file>
  <file path="/codebase/info_theory/data_structures/bits.py">
    <range>1-40</range>
    <range>110-170</range>
  </file>
</ANSWER>


Remember: Prefer narrow, fixed-string, and type-filtered searches with \
aggressive excludes and size/depth limits. Widen scope only as needed. \
Use the restricted tools available to you, and output your answer in \
exactly the specified format.

# NO RESULTS POLICY
If after thorough searching you are confident that NO relevant files exist \
for the given query (e.g., the function/class/concept does not exist in the \
codebase), you MUST return an empty ANSWER:
<ANSWER></ANSWER>
Do NOT return irrelevant files (such as entry points or config files) just \
to provide some output. An empty answer is always better than a misleading one.

# RESULT COUNT
Aim to return at most {max_results} files in your answer. Focus on the most \
relevant files first. If fewer files are relevant, return fewer.
`;

const FINAL_FORCE_ANSWER =
  "You have no turns left. Now you MUST provide your final ANSWER, even if it's not complete.";

const BOOTSTRAP_PROMPT_TEMPLATE = `You are a bootstrap planning agent for codebase hotspot discovery.
Your ONLY goal is to discover high-signal search keywords and hotspot directories for a later full search phase.

# OUTPUT CONTRACT
- Use the restricted_exec tool ONLY.
- Prefer rg + tree commands. Avoid deep readfile unless absolutely necessary.
- Do NOT output final <ANSWER> for code fixes in this phase.
- Keep commands focused and broad enough to identify likely relevant modules quickly.

# TOOL BUDGET
- You have at most {max_turns} turns.
- You may use up to {max_commands} commands per turn.

# STRATEGY
1) Start from the provided mini repo map.
2) Use targeted rg patterns derived from the user problem.
3) Use tree on likely top-level directories to identify hotspots.
4) Stop once you have enough keyword and hotspot coverage for phase-2.
`;

/**
 * Smart trim accumulated messages to reduce payload size.
 *
 * Why this is needed:
 * - Proto size grows quickly across turns (messages + tool results).
 * - Keeping only the last N messages naively may drop the tool-call ↔ tool-result
 *   linkage (tool_call_id/ref_call_id) and remove useful progress context.
 *
 * Strategy:
 * - Keep system prompt (index 0).
 * - Keep user problem statement, but compact the repo map when trimming.
 * - Keep the latest tool-call + tool-result pair (plus any trailing prompts).
 * - Insert a compact progress summary so the model doesn't lose the thread.
 *
 * @param {Array} messages
 * @param {Object} [state]
 * @param {string} [state.query]
 * @param {string[]} [state.recentFiles]
 * @param {string[]} [state.recentPatterns]
 * @param {Array<{type:string, desc:string}>} [state.recentCommands]
 * @param {number} [state.turn]
 * @returns {boolean} true if messages were actually trimmed/compacted
 */
function _trimMessages(messages, state = {}) {
  if (!Array.isArray(messages) || messages.length < 2) return false;

  const systemMsg = messages[0];
  const userMsg = messages[1];

  const truncateToolResultsPreserve = (text, maxPerBlock = 4000, maxTotal = 20000) => {
    if (typeof text !== "string" || text.length <= maxTotal) return text;
    const re = /<(command\d+)_result>\n([\s\S]*?)\n<\/\1_result>/g;
    let m;
    const parts = [];
    let matched = false;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      const key = m[1];
      let body = m[2] || "";
      if (body.length > maxPerBlock) {
        body = body.slice(0, maxPerBlock) + "\n...[truncated]...";
      }
      parts.push(`<${key}_result>\n${body}\n</${key}_result>`);
      if (parts.join("").length > maxTotal) break;
    }
    if (!matched) {
      return text.slice(0, maxTotal) + "\n...[tool results truncated]...";
    }
    const out = parts.join("");
    return out.length <= maxTotal ? out : out.slice(0, maxTotal) + "\n...[tool results truncated]...";
  };

  // Find the most recent tool-result message and its matching tool-call message (if present).
  let lastToolResultIdx = -1;
  let refId = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 4 && typeof m.ref_call_id === "string" && m.ref_call_id) {
      lastToolResultIdx = i;
      refId = m.ref_call_id;
      break;
    }
  }

  let lastToolCallIdx = -1;
  if (refId) {
    for (let i = lastToolResultIdx - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 2 && m.tool_call_id === refId) {
        lastToolCallIdx = i;
        break;
      }
    }
  }

  // Tail: keep tool-call + tool-result pair, plus anything after it (e.g., force-answer).
  let tailStart = -1;
  if (lastToolResultIdx !== -1) {
    tailStart = lastToolCallIdx !== -1 ? lastToolCallIdx : Math.max(2, lastToolResultIdx - 1);
  } else {
    // No tool results yet: keep the last few messages only.
    tailStart = Math.max(2, messages.length - 4);
  }
  const tail = messages.slice(tailStart);

  // Compact the user message (repo map) when trimming, since it's usually the largest chunk.
  let compactedUser = userMsg;
  let didCompactUser = false;
  if (userMsg && typeof userMsg.content === "string" && userMsg.content.includes("Repo Map")) {
    const q =
      (typeof state.query === "string" && state.query) ||
      userMsg.content.match(/Problem Statement:\s*([^\n]+)/)?.[1]?.trim() ||
      "";
    const compact = `Problem Statement: ${q}\n\nRepo Map: (omitted to reduce payload). Use tree/rg to explore structure if needed.`;
    if (compact.length < userMsg.content.length) {
      compactedUser = { ...userMsg, content: compact };
      didCompactUser = true;
    }
  }

  // Build a compact progress summary to preserve important context across trims.
  const recentCommands = Array.isArray(state.recentCommands) ? state.recentCommands : [];
  const recentFiles = Array.isArray(state.recentFiles) ? state.recentFiles : [];
  const recentPatterns = Array.isArray(state.recentPatterns) ? state.recentPatterns : [];
  const turnNote = Number.isInteger(state.turn) ? ` turn=${state.turn}` : "";

  const summaryLines = [
    `[Context trimmed to reduce payload size.${turnNote}]`,
    recentCommands.length ? `recent_commands: ${recentCommands.slice(-6).map((c) => c.desc).join(" | ")}` : "",
    recentFiles.length ? `recent_files: ${recentFiles.slice(-12).join(", ")}` : "",
    recentPatterns.length ? `rg_patterns: ${recentPatterns.slice(-20).join(", ")}` : "",
    "Continue from the most recent tool results kept below.",
  ].filter(Boolean);

  const summaryMsg = { role: 1, content: summaryLines.join("\n") };

  // If trimming doesn't actually reduce anything, bail.
  // We consider it "useful" if we either compact the user message or drop history.
  const willDropHistory = tailStart > 2;
  if (!didCompactUser && !willDropHistory) return false;

  // Reduce oversized assistant/tool messages in the tail to avoid immediate re-overflow.
  for (const m of tail) {
    if (m && typeof m.content === "string") {
      if (m.role === 2 && m.content.length > 8000) {
        m.content = m.content.slice(0, 8000) + "\n...[assistant content truncated]...";
      }
      if (m.role === 4 && m.content.length > 20000) {
        m.content = truncateToolResultsPreserve(m.content, 4000, 20000);
      }
    }
  }

  messages.length = 0;
  messages.push(systemMsg);
  // Avoid duplicating user message if it's already within the kept tail.
  if (tailStart > 1) {
    messages.push(compactedUser);
  }
  messages.push(summaryMsg, ...tail);
  return true;
}

/**
 * @param {number} maxTurns
 * @param {number} maxCommands
 * @param {number} maxResults
 * @returns {string}
 */
function buildSystemPrompt(maxTurns = 3, maxCommands = 8, maxResults = 10) {
  return SYSTEM_PROMPT_TEMPLATE
    .replaceAll("{max_turns}", String(maxTurns))
    .replaceAll("{max_commands}", String(maxCommands))
    .replaceAll("{max_results}", String(maxResults));
}

function buildBootstrapPrompt(maxTurns = 2, maxCommands = 6) {
  return BOOTSTRAP_PROMPT_TEMPLATE
    .replaceAll("{max_turns}", String(maxTurns))
    .replaceAll("{max_commands}", String(maxCommands));
}

function _extractTopDirFromCodebasePath(path = "") {
  const p = String(path || "").replace(/\\/g, "/");
  if (!p.startsWith("/codebase")) return null;
  const rel = p.replace(/^\/codebase\/?/, "");
  if (!rel) return null;
  return rel.split("/")[0] || null;
}

async function _runBootstrapPhase({
  query,
  projectRoot,
  credentialState,
  timeoutMs,
  excludePaths,
  bootstrapTreeDepth,
  bootstrapMaxTurns,
  bootstrapMaxCommands,
  onProgress,
}) {
  const log = (msg) => onProgress?.(`[bootstrap] ${msg}`);
  const hints = { rgPatterns: [], hotDirs: [] };

  try {
    const { tree: miniMap, depth } = getRepoMap(projectRoot, bootstrapTreeDepth, excludePaths);
    const systemPrompt = buildBootstrapPrompt(bootstrapMaxTurns, bootstrapMaxCommands);
    const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${depth} /codebase):\n\`\`\`text\n${miniMap}\n\`\`\``;

    const messages = [
      { role: 5, content: systemPrompt },
      { role: 1, content: userContent },
    ];

    const toolDefs = getToolDefinitions(bootstrapMaxCommands);
    const executor = new ToolExecutor(projectRoot);

    for (let turn = 0; turn < bootstrapMaxTurns; turn++) {
      log(`Turn ${turn + 1}/${bootstrapMaxTurns}`);
      let respData;
      try {
        respData = await _streamingRequestWithRelayFailover({
          credentialState,
          buildProto: (currentApiKey, currentJwt) =>
            _buildRequest(currentApiKey, currentJwt, messages, toolDefs),
          timeoutMs,
          maxRetries: 2,
        });
      } catch (e) {
        log(`request failed: ${e.code || "UNKNOWN"}`);
        break;
      }

      const [thinking, toolInfo] = _parseResponse(respData);
      if (!toolInfo) break;

      const [toolName, toolArgs] = toolInfo;
      if (toolName !== "restricted_exec") break;

      const callId = randomUUID();
      const argsJson = JSON.stringify(toolArgs);
      const cmds = Object.keys(toolArgs).filter((k) => k.startsWith("command"));

      for (const cmdKey of cmds) {
        const cmd = toolArgs[cmdKey];
        if (!cmd || typeof cmd !== "object") continue;
        if (cmd.type === "rg" && typeof cmd.pattern === "string" && cmd.pattern) {
          hints.rgPatterns.push(cmd.pattern);
        }
        if (cmd.type === "tree" && typeof cmd.path === "string") {
          const top = _extractTopDirFromCodebasePath(cmd.path);
          if (top) hints.hotDirs.push(top);
        }
      }

      const results = await executor.execToolCallAsync(toolArgs);
      messages.push({
        role: 2,
        content: thinking,
        tool_call_id: callId,
        tool_name: "restricted_exec",
        tool_args_json: argsJson,
      });
      messages.push({ role: 4, content: results, ref_call_id: callId });
    }
  } catch {
    // Bootstrap is best-effort. Fall back silently.
  }

  return {
    rgPatterns: [...new Set(hints.rgPatterns)].slice(-30),
    hotDirs: [...new Set(hints.hotDirs)].slice(-12),
  };
}

// ─── Tool Schema ───────────────────────────────────────────

function _buildCommandSchema(n) {
  return {
    type: "object",
    description: `Command ${n} to execute. Must be one of: rg, readfile, tree, ls, glob, or the strictly allowlisted Windows powershell process query.`,
    oneOf: [
      {
        properties: {
          type: { type: "string", const: "rg", description: "Search for patterns in files using ripgrep." },
          pattern: { type: "string", description: "The regex pattern to search for." },
          path: { type: "string", description: "The path to search in." },
          include: { type: "array", items: { type: "string" }, description: "File patterns to include." },
          exclude: { type: "array", items: { type: "string" }, description: "File patterns to exclude." },
        },
        required: ["type", "pattern", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "readfile", description: "Read contents of a file with optional line range." },
          file: { type: "string", description: "Path to the file to read." },
          start_line: { type: "integer", description: "Starting line number (1-indexed)." },
          end_line: { type: "integer", description: "Ending line number (1-indexed)." },
        },
        required: ["type", "file"],
      },
      {
        properties: {
          type: { type: "string", const: "tree", description: "Display directory structure as a tree." },
          path: { type: "string", description: "Path to the directory." },
          levels: { type: "integer", description: "Number of directory levels." },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "ls", description: "List files in a directory." },
          path: { type: "string", description: "Path to the directory." },
          long_format: { type: "boolean" },
          all: { type: "boolean" },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "glob", description: "Find files matching a glob pattern." },
          pattern: { type: "string" },
          path: { type: "string" },
          type_filter: { type: "string", enum: ["file", "directory", "all"] },
        },
        required: ["type", "pattern", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "powershell", description: "Run only the strict Windows process query; never provide a pipeline, semicolon, or another PowerShell statement." },
          command: { type: "string", description: "Exact legacy Get-CimInstance Win32_Process or exact ProcessId filter query. No extra arguments or attached commands." },
        },
        required: ["type", "command"],
      },
    ],
  };
}

/**
 * @param {number} maxCommands
 * @returns {string}
 */
function getToolDefinitions(maxCommands = 8) {
  const props = {};
  for (let i = 1; i <= maxCommands; i++) {
    props[`command${i}`] = _buildCommandSchema(i);
  }
  const tools = [
    {
      type: "function",
      function: {
        name: "restricted_exec",
        description: "Execute restricted commands (rg, readfile, tree, ls, glob, or the strict Windows process query) in parallel.",
        parameters: { type: "object", properties: props, required: ["command1"] },
      },
    },
    {
      type: "function",
      function: {
        name: "answer",
        description: "Final answer with relevant files and line ranges.",
        parameters: {
          type: "object",
          properties: { answer: { type: "string", description: "The final answer in XML format." } },
          required: ["answer"],
        },
      },
    },
  ];
  return JSON.stringify(tools);
}

// ─── Credentials ───────────────────────────────────────────

function isUsableLeasedApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return false;
  if (key.startsWith("sk-")) return true;
  // Accept known session-token shapes from the key pool without branding them.
  if (key.includes("session-token")) return true;
  return key.length >= 32;
}

let _leasedRelay = null;
let _lastRelayError = "";
let _lastRelayFailure = null;
let _relayQuotaBlockedUntilMs = 0;
let _relayLeaseBackoffUntilMs = 0;

const _sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

// Server backoff windows only help if they survive the process, and every CLI
// invocation is a fresh process. Persist the windows to a small state file so
// the next invocation fails fast locally instead of re-hitting the same 429.
let _relayStateFile = process.env.YCE_RELAY_STATE_FILE ||
  join(homedir(), ".cache", "yce-engine", "relay-state.json");
let _relayStateLoaded = false;
let _relayStatePersistEnabled = process.env.YCE_RELAY_STATE_PERSIST !== "0";

function _loadPersistedRelayState() {
  if (_relayStateLoaded) return;
  _relayStateLoaded = true;
  if (!_relayStatePersistEnabled) return;
  try {
    const raw = JSON.parse(readFileSync(_relayStateFile, "utf-8"));
    const now = Date.now();
    if (Number.isFinite(raw?.quotaBlockedUntilMs) && raw.quotaBlockedUntilMs > now) {
      _relayQuotaBlockedUntilMs = raw.quotaBlockedUntilMs;
    }
    if (Number.isFinite(raw?.leaseBackoffUntilMs) && raw.leaseBackoffUntilMs > now) {
      _relayLeaseBackoffUntilMs = raw.leaseBackoffUntilMs;
    }
    if ((_relayQuotaBlockedUntilMs > now || _relayLeaseBackoffUntilMs > now) &&
        raw.lastFailure && typeof raw.lastFailure === "object") {
      _lastRelayFailure = raw.lastFailure;
    }
  } catch {
    // Missing or corrupt state file means no active backoff.
  }
}

function _persistRelayState() {
  if (!_relayStatePersistEnabled) return;
  try {
    const now = Date.now();
    if (_relayQuotaBlockedUntilMs <= now && _relayLeaseBackoffUntilMs <= now) {
      rmSync(_relayStateFile, { force: true });
      return;
    }
    mkdirSync(dirname(_relayStateFile), { recursive: true });
    writeFileSync(_relayStateFile, JSON.stringify({
      quotaBlockedUntilMs: _relayQuotaBlockedUntilMs,
      leaseBackoffUntilMs: _relayLeaseBackoffUntilMs,
      lastFailure: _lastRelayFailure,
    }));
  } catch {
    // State persistence must never break the search flow.
  }
}

function _parseRetryAfterSeconds(response, payload = {}) {
  const payloadSeconds = Number(payload?.retry_after_seconds);
  if (Number.isFinite(payloadSeconds) && payloadSeconds > 0) {
    return Math.ceil(payloadSeconds);
  }
  const header = String(response?.headers?.get?.("retry-after") || "").trim();
  if (!header) return 0;
  const numericSeconds = Number(header);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return Math.ceil(numericSeconds);
  }
  const retryAtMs = Date.parse(header);
  if (!Number.isFinite(retryAtMs)) return 0;
  return Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000));
}

function _formatRelayFailure(failure, relayUrl) {
  const retry = failure?.retryAfterSeconds > 0
    ? ` retry-after=${failure.retryAfterSeconds}s`
    : "";
  return `relay lease failed: HTTP ${failure?.status || 0}${failure?.code ? ` ${failure.code}` : ""}${retry} from ${relayUrl}/yce/lease-key`;
}

function _recordRelayFailure(response, payload, relayUrl) {
  const status = Number(response?.status) || 0;
  const code = String(payload?.code || "").trim();
  const retryAfterSeconds = _parseRetryAfterSeconds(response, payload);
  const resetAt = String(payload?.reset_at || "").trim();
  const resetAtMs = Date.parse(resetAt);
  const inferredRetryable = code === "UPSTREAM_CAPACITY_BACKOFF" ||
    code === "RATE_LIMITED" ||
    code === "POOL_BUSY" ||
    code === "USER_BUSY";
  const failure = {
    status,
    code,
    retryable: typeof payload?.retryable === "boolean"
      ? payload.retryable
      : inferredRetryable,
    retryAfterSeconds,
    resetAt,
    scope: String(payload?.scope || "").trim(),
    message: String(payload?.error || payload?.message || "").trim(),
    period: String(payload?.period || "").trim(),
    used: Number.isFinite(Number(payload?.used)) ? Number(payload.used) : null,
    limit: Number.isFinite(Number(payload?.limit)) ? Number(payload.limit) : null,
  };
  _lastRelayFailure = failure;
  _lastRelayError = _formatRelayFailure(failure, relayUrl);

  const now = Date.now();
  if (code === "QUOTA_EXCEEDED") {
    // A current server supplies reset_at. Older servers get a short local
    // suppression window so repeated calls do not hammer the same 429.
    _relayQuotaBlockedUntilMs = Number.isFinite(resetAtMs) && resetAtMs > now
      ? resetAtMs
      : now + 60_000;
  }
  if ((code === "UPSTREAM_CAPACITY_BACKOFF" || code === "RATE_LIMITED") && retryAfterSeconds > 0) {
    _relayLeaseBackoffUntilMs = Math.max(
      _relayLeaseBackoffUntilMs,
      now + retryAfterSeconds * 1000,
    );
  }
  _persistRelayState();
  return failure;
}

// A CLI invocation must never sleep for minutes because the server sent a
// large Retry-After; beyond this cap we fail fast with the structured error.
const MAX_LEASE_WAIT_MS = 20_000;

function _cachedRelayFailure(now = Date.now()) {
  _loadPersistedRelayState();
  if (_relayQuotaBlockedUntilMs > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((_relayQuotaBlockedUntilMs - now) / 1000));
    return {
      ...(_lastRelayFailure || {}),
      status: _lastRelayFailure?.status || 429,
      code: "QUOTA_EXCEEDED",
      retryable: false,
      retryAfterSeconds,
    };
  }
  if (_relayLeaseBackoffUntilMs > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((_relayLeaseBackoffUntilMs - now) / 1000));
    return {
      ...(_lastRelayFailure || {}),
      code: _lastRelayFailure?.code || "UPSTREAM_CAPACITY_BACKOFF",
      retryable: true,
      retryAfterSeconds,
    };
  }
  return null;
}

function _relayFailureError(fallbackCode, details = {}) {
  const failure = _lastRelayFailure;
  if (!failure) {
    return new YceEngineError(
      _lastRelayError || "relay key pool is temporarily unavailable",
      fallbackCode,
      details,
    );
  }
  return new YceEngineError(
    failure.message || _lastRelayError || "relay key pool is temporarily unavailable",
    failure.code || fallbackCode,
    {
      status: failure.status,
      retryable: failure.retryable,
      retryAfterSeconds: failure.retryAfterSeconds,
      resetAt: failure.resetAt,
      scope: failure.scope,
      period: failure.period,
      used: failure.used,
      limit: failure.limit,
      ...details,
    },
  );
}

/**
 * Headers required by the public YCE protocol proxy (scheme B):
 * Authorization: Bearer <YCE_RELAY_TOKEN>
 * X-YCE-Lease-Id: <lease_id from /yce/lease-key>
 * X-YCE-Key-Id: optional, must match lease when set
 * @param {Object|null} [usageContext]
 * @returns {Record<string, string>}
 */
function _protocolAuthHeaders(usageContext = null) {
  const relayToken = String(
    usageContext?.relayToken || _leasedRelay?.relayToken || process.env.YCE_RELAY_TOKEN || "",
  ).trim();
  const leaseId = String(
    usageContext?.leaseId || _leasedRelay?.leaseId || "",
  ).trim();
  const keyId = String(
    usageContext?.keyId || _leasedRelay?.keyId || "",
  ).trim();
  /** @type {Record<string, string>} */
  const headers = {};
  if (relayToken) headers["Authorization"] = `Bearer ${relayToken}`;
  if (leaseId) headers["X-YCE-Lease-Id"] = leaseId;
  if (keyId) headers["X-YCE-Key-Id"] = keyId;
  return headers;
}

function _usesPublicYceProtocolProxy() {
  const bases = [API_BASE, AUTH_BASE].map((v) => String(v || "").toLowerCase());
  return bases.some((b) => b.includes("/yce/api") || b.includes("/yce/auth") || b.includes("yce.aigy.de"));
}

async function _requestRelayLease({
  excludeKeyIds = [],
  retryAttempt = 0,
  sleep = _sleep,
  random = Math.random,
} = {}) {
  const normalizedExclusions = [...new Set(
    (excludeKeyIds || []).map((value) => String(value || "").trim()).filter(Boolean),
  )];
  const normalizedRetryAttempt = retryAttempt === 1 ? 1 : 0;
  const relayUrl = _normalizeRelayUrl(process.env.YCE_RELAY_URL) || DEFAULT_YCE_RELAY_ORIGIN;
  const relayToken = String(process.env.YCE_RELAY_TOKEN || "").trim();
  if (!relayToken) {
    _lastRelayError = "missing relay token (set YCE_RELAY_TOKEN)";
    return null;
  }

  const cachedFailure = _cachedRelayFailure();
  if (cachedFailure?.code === "QUOTA_EXCEEDED") {
    _lastRelayFailure = cachedFailure;
    _lastRelayError = _formatRelayFailure(cachedFailure, relayUrl);
    return null;
  }
  if (cachedFailure?.retryAfterSeconds > 0) {
    const waitMs = cachedFailure.retryAfterSeconds * 1000 + Math.floor(random() * 250);
    if (waitMs > MAX_LEASE_WAIT_MS) {
      _lastRelayFailure = cachedFailure;
      _lastRelayError = _formatRelayFailure(cachedFailure, relayUrl);
      return null;
    }
    await sleep(waitMs);
  }
  _lastRelayError = "";
  _lastRelayFailure = null;

  // The lease is the first request of a run; install the tuned dispatcher
  // before it so the connection it opens lands in the reusable pool.
  await _installTunedDispatcher();

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${relayUrl}/yce/lease-key`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${relayToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          exclude_key_ids: normalizedExclusions,
          retry_attempt: normalizedRetryAttempt,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        const failure = _recordRelayFailure(response, errorPayload, relayUrl);
        const waitMs = failure.retryAfterSeconds * 1000 + Math.floor(random() * 250);
        const shouldWaitOnce = attempt === 0 &&
          failure.retryAfterSeconds > 0 &&
          waitMs <= MAX_LEASE_WAIT_MS &&
          [
            "UPSTREAM_CAPACITY_BACKOFF",
            "RATE_LIMITED",
            "POOL_BUSY",
            "USER_BUSY",
          ].includes(failure.code);
        if (shouldWaitOnce) {
          await sleep(waitMs);
          continue;
        }
        return null;
      }

      const payload = await response.json();
      const apiKey = String(payload?.api_key || "").trim();
      if (!isUsableLeasedApiKey(apiKey)) return null;

      _lastRelayError = "";
      _lastRelayFailure = null;
      _relayQuotaBlockedUntilMs = 0;
      _relayLeaseBackoffUntilMs = 0;
      _persistRelayState();
      return {
        apiKey,
        keyId: String(payload?.key_id || "").trim(),
        leaseId: String(payload?.lease_id || "").trim(),
        relayUrl,
        relayToken,
        retryAttempt: normalizedRetryAttempt,
        leaseExpiresAt: String(payload?.lease_expires_at || "").trim(),
        // Optional server capability fields; absent on older servers.
        leaseReusable: typeof payload?.lease_reusable === "boolean" ? payload.lease_reusable : undefined,
        maxStreamCalls: Number.isFinite(Number(payload?.max_stream_calls)) && Number(payload.max_stream_calls) > 0
          ? Number(payload.max_stream_calls)
          : undefined,
        usageMode: String(payload?.usage_mode || "").trim() || undefined,
      };
    }
    return null;
  } catch (error) {
    _lastRelayError = `relay lease error: ${error?.message || String(error)}`;
    _lastRelayFailure = {
      status: 0,
      code: "RELAY_NETWORK_ERROR",
      retryable: true,
      retryAfterSeconds: 0,
      resetAt: "",
      scope: "network",
      message: _lastRelayError,
    };
    return null;
  }
}

async function leaseApiKeyFromRelay({
  excludeKeyIds = [],
  retryAttempt = 0,
  forceNew = false,
  sleep = _sleep,
  random = Math.random,
} = {}) {
  const hasExclusions = (excludeKeyIds || []).some((value) => String(value || "").trim());
  const normalizedRetryAttempt = retryAttempt === 1 ? 1 : 0;
  if (_leasedRelay?.apiKey && !forceNew && !hasExclusions && normalizedRetryAttempt === 0) {
    return _leasedRelay.apiKey;
  }
  if (forceNew) _leasedRelay = null;
  const leased = await _requestRelayLease({
    excludeKeyIds,
    retryAttempt: normalizedRetryAttempt,
    sleep,
    random,
  });
  if (!leased) return null;
  _leasedRelay = leased;
  return leased.apiKey;
}

function _clearLeasedRelay(expectedLeaseId = "") {
  if (!_leasedRelay) return;
  if (expectedLeaseId && _leasedRelay.leaseId !== expectedLeaseId) return;
  _leasedRelay = null;
}

// One lease per search run — STRICTLY OPT-IN by server capability. The lease
// is reused only when the server's lease response explicitly declares
// lease_reusable:true; older/production servers without the field keep the
// original lease-per-call behavior (their quota accounting depends on it).
// The server keeps a lease active for its full TTL (5 min default) and marks
// it completed when the /yce/usage receipt arrives, so a reused lease sends
// one receipt at release time (see usage accounting above). Reuse saves the
// per-turn lease RTT and lease-scheduler pressure; quota still follows the
// actual upstream calls (the server bills each forwarded call).
// YCE_LEASE_REUSE=0 forces lease-per-call; YCE_LEASE_REUSE=1 forces reuse on
// (testing only, against servers known to support it).
const LEASE_REUSE_SAFETY_MS = 15_000;
const DEFAULT_MAX_STREAM_CALLS_PER_LEASE = 16;
// The server counts every POST (including same-lease retries) against its
// cap while the client only observes its own attempts; keep headroom so the
// client rotates leases before the server's hard limit 401s a live search.
const LEASE_CALL_RETRY_HEADROOM = 4;

function _leaseCallBudgetLeft(usageContext) {
  const serverLimit = Number.isFinite(usageContext?.maxStreamCalls) && usageContext.maxStreamCalls > 0
    ? usageContext.maxStreamCalls
    : DEFAULT_MAX_STREAM_CALLS_PER_LEASE;
  const limit = Math.max(1, serverLimit - LEASE_CALL_RETRY_HEADROOM);
  const used = Math.max(
    usageContext?.usageStats?.calls || 0,
    usageContext?.attempts || 0,
  );
  return used < limit;
}

function _leaseReusable(usageContext) {
  if (process.env.YCE_LEASE_REUSE === "0") return false;
  if (usageContext?.serverAllowsReuse !== true && process.env.YCE_LEASE_REUSE !== "1") return false;
  if (!_leaseCallBudgetLeft(usageContext)) return false;
  const expiresAtMs = Date.parse(String(usageContext?.leaseExpiresAt || ""));
  return Number.isFinite(expiresAtMs) && expiresAtMs - LEASE_REUSE_SAFETY_MS > Date.now();
}

function _leaseExpired(usageContext) {
  const expiresAtMs = Date.parse(String(usageContext?.leaseExpiresAt || ""));
  return Number.isFinite(expiresAtMs) && expiresAtMs - LEASE_REUSE_SAFETY_MS <= Date.now();
}

function _usageContextFromLease(leased) {
  return {
    keyId: leased.keyId,
    leaseId: leased.leaseId || "",
    relayUrl: leased.relayUrl,
    relayToken: leased.relayToken,
    leaseExpiresAt: leased.leaseExpiresAt || "",
    serverAllowsReuse: leased.leaseReusable,
    maxStreamCalls: leased.maxStreamCalls,
    usageMode: leased.usageMode,
  };
}

function _normalizeRelayUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function _extractStreamError(data) {
  try {
    const frames = connectFrameDecode(data);
    for (const frameData of frames) {
      const textCandidate = frameData.toString("utf-8").trim();
      if (!textCandidate.startsWith("{")) continue;
      const errObj = JSON.parse(textCandidate);
      if (errObj?.error) {
        const code = String(errObj.error.code || "unknown");
        const message = String(errObj.error.message || "");
        return {
          code,
          message,
          formatted: `[Error] ${code}: ${message}`.trim(),
          transientCapacity: _isTransientCapacitySignal({ code, message }),
        };
      }
    }
  } catch {
    // Ignore malformed frames; normal parser will handle the response later.
  }
  return null;
}

async function _httpErrorFromResponse(response) {
  let payload = {};
  try {
    const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
    if (contentType.includes("json")) payload = await response.json();
  } catch {
    payload = {};
  }
  const relayCode = String(payload?.code || "").trim();
  const errorSource = String(payload?.source || "").trim();
  const message = String(payload?.error || payload?.message || `HTTP ${response.status}`).trim() ||
    `HTTP ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  error.relayCode = relayCode;
  error.errorSource = errorSource;
  return error;
}

async function _reportYceUsage(usageContext, {
  event = "code_search",
  callSeq = null,
  statusCode = null,
  errorMessage = "",
  errorCode = "",
  errorSource = "",
  durationMs = null,
  calls = null,
} = {}) {
  if (!usageContext?.relayUrl || !usageContext?.relayToken || !usageContext?.keyId) return;
  const body = JSON.stringify({
    key_id: usageContext.keyId,
    lease_id: usageContext.leaseId || "",
    event,
    call_seq: typeof callSeq === "number" && callSeq > 0 ? callSeq : null,
    status_code: typeof statusCode === "number" ? statusCode : null,
    error_message: String(errorMessage || "").slice(0, 1000),
    error_code: String(errorCode || "").slice(0, 128),
    error_source: String(errorSource || "").slice(0, 32),
    duration_ms: typeof durationMs === "number" ? durationMs : null,
    calls: typeof calls === "number" && calls > 0 ? calls : null,
  });
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${usageContext.relayUrl}/yce/usage`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${usageContext.relayToken}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        usageContext.lastUsageError = "";
        return true;
      }
      const payload = await response.json().catch(() => ({}));
      lastError = String(payload?.error || `HTTP ${response.status}`);
      // 4xx means the receipt itself is invalid and retrying cannot repair it.
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        break;
      }
    } catch (error) {
      lastError = error?.message || String(error);
    }
    if (attempt < 2) await _sleep(150 * (2 ** attempt));
  }
  usageContext.lastUsageError = lastError || "usage receipt was not acknowledged";
  return false;
}

// usage_mode=per_call_v1 separates telemetry from release: every logical call
// reports its own outcome, and lease_release is sent only when the search drops
// the lease. Older servers omit the capability, so the client preserves their
// lease-scoped aggregate receipt. search() flushes all reports before return.
const _pendingUsageReports = new Set();

function _reportYceUsageBackground(usageContext, info) {
  const pending = _reportYceUsage(usageContext, info)
    .catch(() => {})
    .finally(() => _pendingUsageReports.delete(pending));
  _pendingUsageReports.add(pending);
  return pending;
}

async function _flushUsageReports() {
  while (_pendingUsageReports.size > 0) {
    await Promise.allSettled([..._pendingUsageReports]);
  }
}

function _accumulateLeaseUsage(usageContext, {
  statusCode = null,
  durationMs = null,
  errorMessage = "",
  errorCode = "",
  errorSource = "",
} = {}) {
  if (!usageContext) return;
  const stats = usageContext.usageStats || (usageContext.usageStats = {
    calls: 0,
    successCalls: 0,
    failureCalls: 0,
    lastStatusCode: null,
    lastErrorMessage: "",
    lastErrorCode: "",
    lastErrorSource: "",
    totalDurationMs: 0,
  });
  stats.calls += 1;
  if (typeof statusCode === "number") stats.lastStatusCode = statusCode;
  if (typeof durationMs === "number") stats.totalDurationMs += durationMs;
  if (String(errorMessage || "") || (typeof statusCode === "number" && statusCode >= 400)) {
    stats.failureCalls += 1;
    stats.lastErrorMessage = String(errorMessage || "");
    stats.lastErrorCode = String(errorCode || "");
    stats.lastErrorSource = String(errorSource || "");
  } else {
    stats.successCalls += 1;
  }
  if (usageContext.usageMode === "per_call_v1") {
    return _reportYceUsageBackground(usageContext, {
      event: "code_search_call",
      callSeq: stats.calls,
      statusCode,
      errorMessage,
      errorCode,
      errorSource,
      durationMs,
      calls: 1,
    });
  }
}

function _legacyLeaseUsageInfo(usageContext) {
  const stats = usageContext?.usageStats;
  if (!stats || stats.calls === 0) return null;
  return {
    event: "code_search",
    statusCode: stats.lastStatusCode,
    errorMessage: stats.lastErrorMessage,
    errorCode: stats.lastErrorCode,
    errorSource: stats.lastErrorSource,
    durationMs: stats.totalDurationMs > 0 ? stats.totalDurationMs : null,
    calls: stats.calls,
  };
}

// Release the reusable lease exactly once. New servers receive a dedicated
// lease_release event; old servers keep the legacy aggregate code_search
// receipt, which still doubles as release.
function _releaseLeaseUsage(usageContext, override = null) {
  if (!usageContext || usageContext.usageReported || usageContext.usageReportPending) return;
  const info = usageContext.usageMode === "per_call_v1"
    ? { event: "lease_release" }
    : (override || _legacyLeaseUsageInfo(usageContext));
  if (!info) return;
  const pending = _reportYceUsageBackground(usageContext, info);
  usageContext.usageReportPending = pending;
  pending.then((acknowledged) => {
    if (acknowledged) usageContext.usageReported = true;
  }).finally(() => {
    if (usageContext.usageReportPending === pending) usageContext.usageReportPending = null;
  });
}

// Record the failing logical call. Per-call mode leaves the lease open until
// the caller clears it; legacy mode sends the aggregate receipt immediately.
async function _reportLeaseFailure(usageContext, info) {
  if (!usageContext) return;
  const rawError = info?.error;
  const classified = rawError ? _classifyError(rawError) : null;
  const normalizedInfo = {
    ...info,
    statusCode: info?.statusCode ?? classified?.details?.status ?? rawError?.status ?? null,
    errorMessage: info?.errorMessage || classified?.message || rawError?.message || "request failed",
    errorCode: info?.errorCode || classified?.details?.relayCode || rawError?.relayCode || "",
    errorSource: info?.errorSource || classified?.details?.errorSource || rawError?.errorSource || "",
  };
  delete normalizedInfo.error;
  const pending = _accumulateLeaseUsage(usageContext, normalizedInfo);
  if (usageContext.usageMode === "per_call_v1") {
    await pending;
    return;
  }
  if (usageContext.usageReported) return;
  const acknowledged = await _reportYceUsage(usageContext, _legacyLeaseUsageInfo(usageContext));
  if (acknowledged) usageContext.usageReported = true;
}

// ─── JWT Cache ──────────────────────────────────────────────

/** @type {Map<string, { token: string, expiresAt: number }>} */
const _jwtCache = new Map();

/**
 * Decode JWT payload and extract expiration time.
 * @param {string} jwt
 * @returns {number} expiration timestamp in seconds
 */
function _getJwtExp(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return payload.exp || 0;
  } catch {
    return 0;
  }
}

/**
 * Get a cached or fresh JWT token.
 * Refreshes when token expires or is within 60s of expiration.
 * @param {string} apiKey
 * @param {Object|null} [usageContext] relay lease context for public protocol proxy
 * @returns {Promise<string>}
 */
async function getCachedJwt(apiKey, usageContext = null) {
  const now = Math.floor(Date.now() / 1000);
  const cached = _jwtCache.get(apiKey);
  if (cached && cached.expiresAt > now + 60) return cached.token;
  const token = await fetchJwt(apiKey, usageContext);
  const exp = _getJwtExp(token);
  _jwtCache.set(apiKey, { token, expiresAt: exp || now + 3600 });
  return token;
}

// ─── Network Layer ─────────────────────────────────────────

/**
 * Standard unary HTTP POST with proto content type.
 *
 * Unary calls (JWT fetch, rate-limit check) sit on the critical path of every
 * search, so one transient socket error (e.g. ECONNRESET on a reused
 * keep-alive connection) must not kill the whole run: retry once on
 * network/timeout/5xx failures. Client errors (4xx) never retry.
 *
 * @param {string} url
 * @param {Buffer} protoBytes
 * @param {boolean} [compress=true]
 * @returns {Promise<Buffer>}
 */
async function _unaryRequest(url, protoBytes, compress = true, usageContext = null, maxRetries = 1) {
  const headers = {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "gzip",
    ..._protocolAuthHeaders(usageContext),
  };

  let body;
  if (compress) {
    body = gzipSync(protoBytes);
    headers["Content-Encoding"] = "gzip";
  } else {
    body = protoBytes;
  }

  await _installTunedDispatcher();
  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let classified;
    try {
      const resp = await doFetch();
      if (resp.ok) {
        const arrayBuf = await resp.arrayBuffer();
        return Buffer.from(arrayBuf);
      }
      const err = await _httpErrorFromResponse(resp);
      classified = _classifyError(err);
    } catch (error) {
      classified = _classifyError(error);
    }
    lastErr = classified;
    const retryable = classified.code === "NETWORK_ERROR" ||
      classified.code === "TIMEOUT" ||
      classified.code === "SERVER_ERROR";
    if (!retryable || attempt >= maxRetries) break;
    await _sleep(500 * (attempt + 1) + Math.floor(Math.random() * 250));
  }
  throw lastErr;
}

/**
 * Connect-RPC streaming POST to the YCE semantic search stream with retry.
 * @param {Buffer} protoBytes
 * @param {number} [timeoutMs=30000]
 * @param {number} [maxRetries=2]
 * @returns {Promise<Buffer>}
 */
async function _streamingRequest(protoBytes, timeoutMs = 30000, maxRetries = 2, usageContext = null) {
  const frame = connectFrameEncode(protoBytes);
  const url = `${API_BASE}/GetDevstralStream`;
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const baseTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
  const abortMs = baseTimeoutMs + 5000;
  // timeoutMs is the budget for the whole logical call INCLUDING retries.
  // Without this, retries can stack up to ~3x the budget and the outer
  // process kill timer fires before the engine can report anything.
  const deadlineAt = Date.now() + abortMs;

  const headers = {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "Connect-Accept-Encoding": "gzip",
    "Connect-Content-Encoding": "gzip",
    "Connect-Timeout-Ms": String(baseTimeoutMs),
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "identity",
    "Baggage": `sentry-release=language-server-yce@${YCE_REMOTE_LS_VER},` +
      `sentry-environment=stable,sentry-sampled=false,` +
      `sentry-trace_id=${traceId},` +
      `sentry-public_key=b813f73488da69eedec534dba1029111`,
    "Sentry-Trace": `${traceId}-${spanId}-0`,
    ..._protocolAuthHeaders(usageContext),
  };

  await _installTunedDispatcher();
  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body: frame,
    signal: AbortSignal.timeout(Math.max(1000, Math.min(abortMs, deadlineAt - Date.now()))),
  });

  // Jittered backoff so concurrent clients don't retry in lockstep; skip the
  // retry entirely when the remaining budget can't fit a meaningful attempt.
  const backoffOrGiveUp = async (attempt) => {
    const delayMs = 1000 * (attempt + 1) + Math.floor(Math.random() * 500);
    if (Date.now() + delayMs + 2000 > deadlineAt) return false;
    await _sleep(delayMs);
    return true;
  };

  const logicalStartedAt = Date.now();
  let lastErr;
  let lastStatus = null;
  let lastErrorMessage = "request failed";
  let lastErrorCode = "";
  let lastErrorSource = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // The server's per-lease call cap counts every POST, retries included;
      // track attempts so the reuse budget matches the server's ledger.
      if (usageContext) usageContext.attempts = (usageContext.attempts || 0) + 1;
      const resp = await doFetch();
      if (!resp.ok) {
        const err = await _httpErrorFromResponse(resp);
        lastErr = err;
        lastStatus = resp.status;
        lastErrorMessage = err.message;
        lastErrorCode = err.relayCode || "";
        lastErrorSource = err.errorSource || "";
        // 429 is a capacity signal for one bounded cross-key retry. Other 4xx
        // failures are client/auth errors and must not be retried on another key.
        if (resp.status === 429 || (resp.status >= 400 && resp.status < 500)) break;
        if (attempt < maxRetries && await backoffOrGiveUp(attempt)) continue;
        break;
      }

      const arrayBuf = await resp.arrayBuffer();
      const data = Buffer.from(arrayBuf);
      const streamError = _extractStreamError(data);
      if (streamError) {
        lastStatus = resp.status;
        lastErrorMessage = streamError.formatted;
        lastErr = streamError.transientCapacity
          ? new YceEngineError(streamError.formatted, "TRANSIENT_CAPACITY", {
              status: resp.status,
              upstreamCode: streamError.code,
            })
          : new YceEngineError(streamError.formatted, "SERVER_ERROR", {
              status: resp.status,
              upstreamCode: streamError.code,
            });
        break;
      }
      _accumulateLeaseUsage(usageContext, {
        statusCode: resp.status,
        durationMs: Date.now() - logicalStartedAt,
      });
      return data;
    } catch (e) {
      lastErr = e;
      lastStatus = typeof e?.status === "number" ? e.status : null;
      lastErrorMessage = e?.message || e?.code || "request failed";
      const classified = _classifyError(e);
      lastErrorCode = classified?.details?.relayCode || e?.relayCode || "";
      lastErrorSource = classified?.details?.errorSource || e?.errorSource || "";
      if (classified.code === "AUTH_ERROR" || classified.code === "PAYLOAD_TOO_LARGE") break;
      if (attempt < maxRetries && await backoffOrGiveUp(attempt)) continue;
      break;
    }
  }
  const classified = _classifyError(lastErr || new Error(lastErrorMessage));
  await _reportLeaseFailure(usageContext, {
    statusCode: lastStatus,
    errorMessage: lastErrorMessage,
    errorCode: classified?.details?.relayCode || lastErrorCode,
    errorSource: classified?.details?.errorSource || lastErrorSource,
    durationMs: Date.now() - logicalStartedAt,
  });
  classified.__yceUsageReported = true;
  throw classified;
}

async function _leaseRelayCredential(options = {}) {
  const leased = await _requestRelayLease(options);
  if (!leased?.apiKey || !leased?.keyId) return null;
  _leasedRelay = leased;
  return { ...leased };
}

function _clearRelayCredentialState(state) {
  const leaseId = state?.usageContext?.leaseId || "";
  _clearLeasedRelay(leaseId);
  if (!state) return;
  // Dropping the lease is the release point: send its single usage receipt
  // (no-op when an error path already reported, or nothing ran on it).
  _releaseLeaseUsage(state.usageContext);
  state.apiKey = null;
  state.jwt = null;
  state.usageContext = null;
}

function _isCrossKeyRetryable(error) {
  if (!error) return false;
  if (error.code === "RATE_LIMITED") return false;
  if (error.code === "TRANSIENT_CAPACITY") return true;
  if ((error?.details?.status ?? error?.status) === 429) return false;
  return _isTransientCapacitySignal({
    status: error?.details?.status ?? error?.status ?? null,
    code: error?.details?.upstreamCode || error?.code || "",
    message: error?.message || "",
  });
}

function _isRelayLeaseLifecycleError(error) {
  if (!error || error?.details?.errorSource !== "relay") return false;
  return new Set([
    "LEASE_REQUIRED",
    "LEASE_INVALID",
    "LEASE_INACTIVE",
    "LEASE_EXPIRED",
    "LEASE_CALL_LIMIT",
  ]).has(String(error?.details?.relayCode || ""));
}

async function _streamingRequestWithRelayFailover({
  credentialState,
  buildProto,
  timeoutMs = 30000,
  maxRetries = 2,
  leaseCredential = _leaseRelayCredential,
  getJwt = getCachedJwt,
  request = _streamingRequest,
  sleep = _sleep,
  random = Math.random,
}) {
  if (!credentialState || typeof buildProto !== "function") {
    throw new Error("credentialState and buildProto are required");
  }

  const ensureCredential = async (options = {}) => {
    if (!credentialState.relayManaged) return;
    if (credentialState.apiKey && credentialState.jwt && credentialState.usageContext) {
      if (!_leaseExpired(credentialState.usageContext)) return;
      _clearRelayCredentialState(credentialState);
    }
    const leased = await leaseCredential(options);
    if (!leased?.apiKey || !leased?.keyId) {
      throw _relayFailureError(
        options.retryAttempt === 1 ? "RELAY_POOL_BUSY" : "RELAY_UNAVAILABLE",
      );
    }
    credentialState.apiKey = leased.apiKey;
    credentialState.usageContext = _usageContextFromLease(leased);
    try {
      credentialState.jwt = await getJwt(leased.apiKey, credentialState.usageContext);
    } catch (error) {
      const classified = _classifyError(error);
      if (_isRelayLeaseLifecycleError(classified) && options.leaseLifecycleRetry !== true) {
        _clearRelayCredentialState(credentialState);
        return ensureCredential({
          retryAttempt: 0,
          forceNew: true,
          leaseLifecycleRetry: true,
        });
      }
      await _reportLeaseFailure(credentialState.usageContext, {
        error,
        statusCode: error?.status || 401,
        errorMessage: error?.message || "failed to fetch JWT",
      });
      _clearRelayCredentialState(credentialState);
      throw error;
    }
  };

  await ensureCredential({ retryAttempt: 0, forceNew: true });
  const failedKeyId = credentialState.usageContext?.keyId || "";
  // Current relays return structured lease lifecycle errors. Those are safe to
  // heal with one fresh lease even before the first stream (for example Redis
  // restarted after lease issue). A bare/upstream 401 is never re-leased.
  try {
    const data = await request(
      buildProto(credentialState.apiKey, credentialState.jwt),
      timeoutMs,
      maxRetries,
      credentialState.usageContext,
    );
    // Keep a still-valid lease for the next logical call of this search run;
    // ensureCredential re-leases automatically once it nears expiry.
    if (credentialState.relayManaged && !_leaseReusable(credentialState.usageContext)) {
      _clearRelayCredentialState(credentialState);
    }
    return data;
  } catch (error) {
    const staleLease = credentialState.relayManaged &&
      _isRelayLeaseLifecycleError(error);
    if (staleLease) {
      _clearRelayCredentialState(credentialState);
      await ensureCredential({ retryAttempt: 0, forceNew: true });
      return await request(
        buildProto(credentialState.apiKey, credentialState.jwt),
        timeoutMs,
        maxRetries,
        credentialState.usageContext,
      ).then((data) => {
        if (!_leaseReusable(credentialState.usageContext)) {
          _clearRelayCredentialState(credentialState);
        }
        return data;
      }).catch((retryError) => {
        _clearRelayCredentialState(credentialState);
        throw retryError;
      });
    }
    if (!credentialState.relayManaged || !_isCrossKeyRetryable(error)) {
      if (credentialState.relayManaged) _clearRelayCredentialState(credentialState);
      throw error;
    }
    _clearRelayCredentialState(credentialState);
  }

  await sleep(250 + Math.floor(random() * 501));
  const alternate = await leaseCredential({
    excludeKeyIds: failedKeyId ? [failedKeyId] : [],
    retryAttempt: 1,
    forceNew: true,
  });
  if (!alternate?.apiKey || !alternate?.keyId) {
    throw _relayFailureError("RELAY_POOL_BUSY", { excludedKeyId: failedKeyId });
  }

  credentialState.apiKey = alternate.apiKey;
  credentialState.usageContext = _usageContextFromLease(alternate);
  try {
    credentialState.jwt = await getJwt(alternate.apiKey, credentialState.usageContext);
    return await request(
      buildProto(credentialState.apiKey, credentialState.jwt),
      timeoutMs,
      maxRetries,
      credentialState.usageContext,
    );
  } catch (error) {
    if (!error?.__yceUsageReported && !credentialState.jwt) {
      await _reportLeaseFailure(credentialState.usageContext, {
        error,
        statusCode: error?.status || 401,
        errorMessage: error?.message || "failed to fetch JWT",
      });
    }
    throw error;
  } finally {
    _clearRelayCredentialState(credentialState);
  }
}

/**
 * Authenticate with API key to get JWT token.
 * @param {string} apiKey
 * @param {Object|null} [usageContext]
 * @returns {Promise<string>}
 */
async function fetchJwt(apiKey, usageContext = null) {
  if (_usesPublicYceProtocolProxy()) {
    const auth = _protocolAuthHeaders(usageContext);
    if (!auth.Authorization || !auth["X-YCE-Lease-Id"]) {
      throw new YceEngineError(
        "public YCE protocol requires YCE_RELAY_TOKEN and an active lease (X-YCE-Lease-Id)",
        "AUTH_ERROR",
      );
    }
  }
  const meta = new ProtobufEncoder();
  meta.writeString(1, YCE_REMOTE_APP_ID);
  meta.writeString(2, YCE_REMOTE_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "zh-cn");
  meta.writeString(7, YCE_REMOTE_LS_VER);
  meta.writeString(12, YCE_REMOTE_APP_ID);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));

  const outer = new ProtobufEncoder();
  outer.writeMessage(1, meta);

  const resp = await _unaryRequest(`${AUTH_BASE}/GetUserJwt`, outer.toBuffer(), false, usageContext);
  for (const s of extractStrings(resp)) {
    if (s.startsWith("eyJ") && s.includes(".")) {
      return s;
    }
  }
  throw new Error("Failed to extract JWT from GetUserJwt response");
}

/**
 * Check rate limit. Returns true if OK, false if rate-limited.
 * @param {string} apiKey
 * @param {string} jwt
 * @param {Object|null} [usageContext]
 * @returns {Promise<boolean>}
 */
async function checkRateLimit(apiKey, jwt, usageContext = null) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));
  req.writeString(3, YCE_REMOTE_MODEL);

  try {
    await _unaryRequest(`${API_BASE}/CheckUserMessageRateLimit`, req.toBuffer(), true, usageContext);
    return true;
  } catch (e) {
    // Classified errors carry the HTTP status in details, raw ones on the error.
    if (e.status === 429 || e?.details?.status === 429) return false;
    return true; // Don't block on network issues
  }
}

// ─── Request Building ──────────────────────────────────────

/**
 * Build protobuf metadata with app info, system info, JWT, etc.
 * @param {string} apiKey
 * @param {string} jwt
 * @returns {ProtobufEncoder}
 */
function _buildMetadata(apiKey, jwt) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, YCE_REMOTE_APP_ID);
  meta.writeString(2, YCE_REMOTE_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "zh-cn");

  const plat = platform();
  const sysInfo = {
    Os: plat,
    Arch: arch(),
    Release: release(),
    Version: osVersion(),
    Machine: arch(),
    Nodename: hostname(),
    Sysname: plat === "darwin" ? "Darwin" : plat === "win32" ? "Windows_NT" : "Linux",
    ProductVersion: "",
  };
  meta.writeString(5, JSON.stringify(sysInfo));
  meta.writeString(7, YCE_REMOTE_LS_VER);

  const cpuList = cpus();
  const ncpu = cpuList.length || 4;
  const mem = totalmem();
  const cpuInfo = {
    NumSockets: 1,
    NumCores: ncpu,
    NumThreads: ncpu,
    VendorID: "",
    Family: "0",
    Model: "0",
    ModelName: cpuList[0]?.model || "Unknown",
    Memory: mem,
  };
  meta.writeString(8, JSON.stringify(cpuInfo));
  meta.writeString(12, YCE_REMOTE_APP_ID);
  meta.writeString(21, jwt);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));
  return meta;
}

/**
 * Build a chat message protobuf.
 * @param {number} role - 1=user, 2=assistant, 4=tool_result, 5=system
 * @param {string} content
 * @param {Object} [opts]
 * @param {string} [opts.toolCallId]
 * @param {string} [opts.toolName]
 * @param {string} [opts.toolArgsJson]
 * @param {string} [opts.refCallId]
 * @returns {ProtobufEncoder}
 */
function _buildChatMessage(role, content, opts = {}) {
  const msg = new ProtobufEncoder();
  msg.writeVarint(2, role);
  msg.writeString(3, content);

  if (opts.toolCallId && opts.toolName && opts.toolArgsJson) {
    const tc = new ProtobufEncoder();
    tc.writeString(1, opts.toolCallId);
    tc.writeString(2, opts.toolName);
    tc.writeString(3, opts.toolArgsJson);
    msg.writeMessage(6, tc);
  }

  if (opts.refCallId) {
    msg.writeString(7, opts.refCallId);
  }

  return msg;
}

/**
 * Build a full request with metadata, messages, and tool definitions.
 * @param {string} apiKey
 * @param {string} jwt
 * @param {Array} messages
 * @param {string} toolDefs
 * @returns {Buffer}
 */
function _buildRequest(apiKey, jwt, messages, toolDefs) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));

  for (const m of messages) {
    const msgEnc = _buildChatMessage(m.role, m.content, {
      toolCallId: m.tool_call_id,
      toolName: m.tool_name,
      toolArgsJson: m.tool_args_json,
      refCallId: m.ref_call_id,
    });
    req.writeMessage(2, msgEnc);
  }

  req.writeString(3, toolDefs);
  return req.toBuffer();
}

// ─── Response Parsing ──────────────────────────────────────

/**
 * Strip invalid UTF-8 bytes from a Buffer → clean string.
 * Matches Python's bytes.decode("utf-8", errors="ignore").
 * @param {Buffer} buf
 * @returns {string}
 */
function stripInvalidUtf8(buf) {
  return buf.toString("utf-8").replace(/\ufffd/g, "");
}

/**
 * Parse tool call from [TOOL_CALLS]name[ARGS]{json} format.
 * @param {string} text
 * @returns {[string, string, Object]|null} [thinking, name, args] or null
 */
function _parseToolCall(text) {
  text = text.replace(/<\/s>/g, "");
  const m = text.match(/\[TOOL_CALLS\](\w+)\[ARGS\](\{.+)/s);
  if (!m) return null;

  const name = m[1];
  const raw = m[2].trim();

  // Find matching closing brace
  let depth = 0;
  let end = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === 0) end = raw.length;

  let args;
  const jsonCandidate = raw.slice(0, end);
  try {
    args = JSON.parse(jsonCandidate);
  } catch {
    // Attempt lenient fix: unquoted keys like  exclude":  →  "exclude":
    try {
      const fixed = jsonCandidate.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
      args = JSON.parse(fixed);
    } catch {
      return null;
    }
  }

  const thinking = text.slice(0, m.index).trim();
  return [thinking, name, args];
}

/**
 * Parse streaming response: decode frames, extract text, parse tool calls.
 * @param {Buffer} data
 * @returns {[string, [string, Object]|null]} [text, toolInfo]
 */
function _parseResponse(data) {
  const frames = connectFrameDecode(data);
  let allText = "";

  for (const frameData of frames) {
    // Check for error JSON
    try {
      const textCandidate = frameData.toString("utf-8");
      if (textCandidate.startsWith("{")) {
        const errObj = JSON.parse(textCandidate);
        if (errObj.error) {
          const code = errObj.error.code || "unknown";
          const msg = errObj.error.message || "";
          return [`[Error] ${code}: ${msg}`, null];
        }
      }
    } catch {
      // Not JSON, continue
    }

    // Extract text from frame — strip invalid UTF-8 (matches Python errors="ignore")
    const rawText = stripInvalidUtf8(frameData);
    if (rawText.includes("[TOOL_CALLS]")) {
      allText = rawText;
      break;
    }

    for (const s of extractStrings(frameData)) {
      if (s.length > 10) {
        allText += s;
      }
    }
  }

  const parsed = _parseToolCall(allText);
  if (parsed) {
    const [thinking, name, args] = parsed;
    return [thinking, [name, args]];
  }
  return [allText, null];
}

// ─── Core Search ───────────────────────────────────────────

// Max safe tree size in bytes (server payload limit ~346KB, fixed overhead ~26KB,
// leave room for conversation accumulation across rounds)
const MAX_TREE_BYTES = 250 * 1024;

/**
 * Convert an exclude pattern (directory/file name or simple glob) to RegExp
 * for directory tree filtering.
 * @param {string} pattern - e.g. "node_modules", "dist", "*.min.*"
 * @returns {RegExp}
 */
function _excludePatternToRegex(pattern) {
  if (!/[*?]/.test(pattern)) {
    // Simple name — exact match
    return new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
  }
  // Glob → regex
  let regex = "^";
  for (const c of pattern) {
    if (c === "*") regex += ".*";
    else if (c === "?") regex += ".";
    else if (".+^${}()|[]\\".includes(c)) regex += "\\" + c;
    else regex += c;
  }
  regex += "$";
  return new RegExp(regex);
}

/**
 * Count files in a directory (non-recursive, fast estimate).
 * @param {string} dir
 * @returns {number}
 */
function _countFilesQuick(dir) {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Estimate project size and suggest optimal tree depth.
 * - Small project (< 500 entries): depth 4
 * - Medium project (500-5000 entries): depth 3
 * - Large project (> 5000 entries): depth 2
 * @param {string} projectRoot
 * @returns {number}
 */
function _suggestTreeDepth(projectRoot) {
  const count = _countFilesQuick(projectRoot);
  if (count < 500) return 4;
  if (count <= 5000) return 3;
  return 2;
}

/**
 * Get a directory tree of the project with adaptive depth fallback.
 *
 * Tries the requested depth first. If the tree output exceeds MAX_TREE_BYTES,
 * automatically falls back to lower depths until it fits.
 *
 * @param {string} projectRoot
 * @param {number} [targetDepth=3] - Desired tree depth (0-6), 0 means auto
 * @param {string[]} [excludePaths=[]] - Patterns to exclude from tree
 * @returns {{ tree: string, depth: number, sizeBytes: number, fellBack: boolean, autoDepth: boolean }}
 */
function getRepoMap(projectRoot, targetDepth = 3, excludePaths = []) {
  // Auto depth: if targetDepth is 0, use heuristic
  const autoDepth = targetDepth === 0;
  if (autoDepth) {
    targetDepth = _suggestTreeDepth(projectRoot);
  }
  const excludeRegexes = excludePaths.length ? excludePaths.map(_excludePatternToRegex) : [];

  for (let L = targetDepth; L >= 1; L--) {
    try {
      const treeStr = buildDirectoryTree(projectRoot, {
        maxDepth: L,
        excludeRegexes,
        virtualRoot: "/codebase",
        maxBytes: MAX_TREE_BYTES + 8192,
      });
      const sizeBytes = Buffer.byteLength(treeStr, "utf-8");

      if (sizeBytes <= MAX_TREE_BYTES) {
        return { tree: treeStr, depth: L, sizeBytes, fellBack: L < targetDepth, autoDepth };
      }
      // Too large, try lower depth
    } catch {
      // tree failed at this level, try lower
    }
  }

  // Ultimate fallback: simple ls (also respects excludePaths)
  try {
    let entries = readdirSync(projectRoot).sort();
    if (excludeRegexes.length) {
      entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e)));
    }
    const treeStr = ["/codebase", ...entries.slice(0, 1000).map((e) => `├── ${e}`)].join("\n");
    return { tree: treeStr, depth: 0, sizeBytes: Buffer.byteLength(treeStr, "utf-8"), fellBack: true, autoDepth };
  } catch {
    const treeStr = "/codebase\n(empty or inaccessible)";
    return { tree: treeStr, depth: 0, sizeBytes: treeStr.length, fellBack: true, autoDepth };
  }
}

function _tokenizeQuery(query = "") {
  return [...new Set(
    String(query)
      .toLowerCase()
      .split(/[^a-z0-9_\-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
  )];
}

function _scoreTopLevelDir(dirName, queryTokens = []) {
  const name = String(dirName || "").toLowerCase();
  let score = 0;

  const commonRoots = ["src", "app", "lib", "packages", "services", "server", "backend", "frontend", "api"];
  if (commonRoots.includes(name)) score += 2;

  for (const token of queryTokens) {
    if (name.includes(token)) score += 4;
  }

  return score;
}

function _listTopLevelDirs(projectRoot, excludePaths = []) {
  const excludeRegexes = excludePaths.length ? excludePaths.map(_excludePatternToRegex) : [];
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(projectRoot).sort();
  } catch {
    return out;
  }

  for (const e of entries) {
    if (excludeRegexes.some((rx) => rx.test(e))) continue;
    const abs = join(projectRoot, e);
    try {
      if (statSync(abs).isDirectory()) out.push(e);
    } catch {
      // ignore
    }
  }
  return out;
}

function _buildSubtreeForDir(projectRoot, dir, levels = 2) {
  const abs = join(projectRoot, dir);
  const vRoot = `/codebase/${dir}`;
  try {
    return buildDirectoryTree(abs, {
      maxDepth: levels,
      virtualRoot: vRoot,
      maxBytes: 64 * 1024,
    });
  } catch {
    return `${vRoot}\n  (failed to generate subtree)`;
  }
}

function buildOptimizedRepoMap({
  query,
  projectRoot,
  treeDepth,
  excludePaths,
  optimizer = {},
  bootstrapHints = null,
  onProgress = null,
}) {
  const log = (msg) => onProgress?.(msg);
  const cfg = { ...REPO_MAP_OPTIMIZER_DEFAULTS, ...(optimizer || {}) };
  if (cfg.mode === "classic") {
    const base = getRepoMap(projectRoot, treeDepth, excludePaths);
    return {
      ...base,
      strategy: "classic",
      hotDirs: [],
    };
  }

  const bootstrapDepth = Math.max(1, Math.min(3, Number(cfg.bootstrapTreeDepth) || 1));
  const hotspotTopK = Math.max(0, Math.min(8, Number(cfg.hotspotTopK) || 4));
  const hotspotTreeDepth = Math.max(1, Math.min(4, Number(cfg.hotspotTreeDepth) || 2));
  const maxBytes = Math.max(16 * 1024, Number(cfg.maxBytes) || REPO_MAP_OPTIMIZER_DEFAULTS.maxBytes);

  const bootstrap = getRepoMap(projectRoot, bootstrapDepth, excludePaths);
  const topDirs = _listTopLevelDirs(projectRoot, excludePaths);

  // Extract keywords from bootstrap hints (rgPatterns)
  const keywords = bootstrapHints?.rgPatterns || [];

  // Use BM25F + Probe + RRF for directory scoring
  // This replaces the old token-based scoring + commonRoots approach
  let hotDirs = [];
  let pathSpines = [];
  try {
    const results = scoreDirectories(query, projectRoot, topDirs, excludePaths, {
      topK: hotspotTopK,
      useProbe: true, // Enable probe grep signal
      keywords, // Bootstrap keywords
      minReturn: 2, // Always return at least 2 directories for coverage
    });
    hotDirs = results.hotDirs;
    pathSpines = results.pathSpines;
    log(`BM25F scoring: hotDirs=[${hotDirs.join(",")}] pathSpines=${pathSpines.length} signals=${JSON.stringify(results.signals)}`);
  } catch (e) {
    // Lightweight fallback: use quick scoring without commonRoots
    log(`BM25F failed, using quick token scoring: ${e.message}`);
    const queryTerms = tokenizeBM25(query);
    const scored = topDirs.map((d) => {
      const dirTerms = tokenizeBM25(d);
      let score = 0;
      for (const qt of queryTerms) {
        if (dirTerms.some(dt => dt.includes(qt) || qt.includes(dt))) score += 1;
      }
      return { dir: d, score };
    }).sort((a, b) => b.score - a.score);

    // Always return at least topK directories (no score > 0 filter)
    hotDirs = scored.slice(0, hotspotTopK).map((x) => x.dir);
    if (hotDirs.length === 0) hotDirs = topDirs.slice(0, hotspotTopK);
    log(`Quick scoring fallback: ${hotDirs.join(",")}`);
  }

  const hotspotSections = [];
  for (const d of hotDirs) {
    hotspotSections.push(_buildSubtreeForDir(projectRoot, d, hotspotTreeDepth));
  }

  // Build path spines section for deep file visibility
  const pathSpineSection = pathSpines.length > 0
    ? "# Relevant File Paths (from BM25F path spine extraction)\n" + pathSpines.map(p => `- /codebase/${p}`).join("\n")
    : "";

  let tree = bootstrap.tree;
  const sections = [];
  if (hotspotSections.length) {
    sections.push("# Hotspot Subtrees\n" + hotspotSections.join("\n\n"));
  }
  if (pathSpineSection) {
    sections.push(pathSpineSection);
  }
  if (sections.length) {
    tree = `${bootstrap.tree}\n\n${sections.join("\n\n")}`;
  }

  // Keep map under configurable budget.
  let sizeBytes = Buffer.byteLength(tree, "utf-8");
  if (sizeBytes > maxBytes && (hotspotSections.length || pathSpineSection)) {
    // First try removing path spines
    if (pathSpineSection) {
      const withoutSpines = sections.length > 1
        ? `${bootstrap.tree}\n\n${sections[0]}`
        : bootstrap.tree;
      sizeBytes = Buffer.byteLength(withoutSpines, "utf-8");
      if (sizeBytes <= maxBytes) {
        tree = withoutSpines;
      }
    }

    // If still too large, progressively remove hotspot sections
    if (sizeBytes > maxBytes && hotspotSections.length) {
      let kept = [...hotspotSections];
      while (kept.length > 0) {
        kept.pop();
        tree = kept.length
          ? `${bootstrap.tree}\n\n# Hotspot Subtrees\n${kept.join("\n\n")}`
          : bootstrap.tree;
        sizeBytes = Buffer.byteLength(tree, "utf-8");
        if (sizeBytes <= maxBytes) break;
      }
    }
  }

  return {
    tree,
    depth: bootstrap.depth,
    sizeBytes: Buffer.byteLength(tree, "utf-8"),
    fellBack: bootstrap.fellBack,
    autoDepth: bootstrap.autoDepth,
    strategy: "bootstrap_hotspot",
    hotDirs,
  };
}

/**
 * Parse answer XML into structured file + range data.
 * @param {string} xmlText
 * @param {string} projectRoot
 * @returns {{ files: Array }}
 */
function _parseAnswer(xmlText, projectRoot) {
  const files = [];
  const resolvedRoot = resolve(projectRoot);
  const fileRegex = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
  let fm;
  while ((fm = fileRegex.exec(xmlText)) !== null) {
    const vpath = fm[2];
    let rel = vpath.replace(/^\/codebase[\/\\]?/, "");
    rel = rel.replace(/^[\/\\]+/, "");

    // Path safety: reject traversal attempts (../) and paths outside project root
    const fullPath = resolve(projectRoot, rel);
    const relToRoot = relative(resolvedRoot, fullPath);
    if (relToRoot === ".." || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
      continue;
    }

    const ranges = [];
    const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
    let rm;
    while ((rm = rangeRegex.exec(fm[3])) !== null) {
      ranges.push([parseInt(rm[1], 10), parseInt(rm[2], 10)]);
    }

    files.push({ path: rel, full_path: fullPath, ranges });
  }
  return { files };
}

/**
 * Execute Fast Context search.
 *
 * @param {Object} opts
 * @param {string} opts.query - Natural language search query
 * @param {string} opts.projectRoot - Project root directory
 * @param {string} [opts.apiKey] - YCE-compatible API key (auto-discovered if not set)
 * @param {string} [opts.jwt] - JWT token (auto-fetched if not set)
 * @param {number} [opts.maxTurns=3] - Search rounds
 * @param {number} [opts.maxCommands=8] - Max commands per round
 * @param {number} [opts.maxResults=10] - Max number of files to return
 * @param {number} [opts.treeDepth=3] - Directory tree depth for repo map (1-6, auto fallback)
 * @param {number} [opts.timeoutMs=30000] - Connect-Timeout-Ms for streaming requests
 * @param {string[]} [opts.excludePaths=[]] - Patterns to exclude from tree
 * @param {function} [opts.onProgress] - Progress callback
 * @returns {Promise<Object>}
 */
export async function search(options) {
  const runState = {};
  try {
    return await _searchImpl(options, runState);
  } finally {
    // Release the lease still held at end of search: the usage receipt is
    // what frees the server-side in-flight slot — without it the user's
    // concurrency budget stays occupied until the lease TTL expires and
    // back-to-back searches hit USER_BUSY.
    if (runState.credentialState) _clearRelayCredentialState(runState.credentialState);
    // Background usage reports must not outlive the CLI process.
    await _flushUsageReports();
  }
}

async function _searchImpl({
  query,
  projectRoot,
  apiKey = null,
  jwt = null,
  maxTurns = 3,
  maxCommands = 8,
  maxResults = 10,
  treeDepth = 3,
  timeoutMs = 30000,
  excludePaths = [],
  repoMapMode = "bootstrap_hotspot",
  bootstrapTreeDepth = 1,
  hotspotTopK = 4,
  hotspotTreeDepth = 2,
  hotspotMaxBytes = 120 * 1024,
  bootstrapEnabled = true,
  bootstrapMaxTurns = 2,
  bootstrapMaxCommands = 6,
  onProgress = null,
}, runState = {}) {
  const log = (msg) => onProgress?.(msg);
  projectRoot = resolve(projectRoot);
  const effectiveExcludePaths = _mergeExcludePaths(excludePaths);
  const explicitApiKey = Boolean(apiKey);
  let initialUsageContext = null;
  let relayManaged = false;

  // Get credentials
  if (!apiKey) {
    const leased = await _leaseRelayCredential({ retryAttempt: 0 });
    if (leased) {
      apiKey = leased.apiKey;
      initialUsageContext = _usageContextFromLease(leased);
      relayManaged = true;
    } else {
      apiKey = String(process.env.YCE_API_KEY || "").trim();
      if (!apiKey) {
        const relayToken = String(process.env.YCE_RELAY_TOKEN || "").trim();
        if (relayToken) {
          const detail = _lastRelayError || "relay key lease returned no usable key";
          throw new Error(
            `YCE relay key lease failed: ${detail}. Check YCE_RELAY_URL/YCE_RELAY_TOKEN and retry.`,
          );
        }
        throw new Error(
          "YCE API key not found. Configure YCE_RELAY_URL/YCE_RELAY_TOKEN (default relay: https://yce.aigy.de; YCE_RELAY_TOKEN must be a YCE search key) " +
          "or set YCE_API_KEY. Run yce-engine.mjs --check-key to verify relay connectivity.",
        );
      }
    }
  }
  if (explicitApiKey) {
    initialUsageContext = null;
    relayManaged = false;
  }
  if (!jwt) {
    log("Fetching JWT...");
    for (let leaseLifecycleRetry = 0; ; leaseLifecycleRetry++) {
      try {
        jwt = await getCachedJwt(apiKey, initialUsageContext);
        break;
      } catch (error) {
        const classified = _classifyError(error);
        if (relayManaged && leaseLifecycleRetry === 0 && _isRelayLeaseLifecycleError(classified)) {
          _releaseLeaseUsage(initialUsageContext);
          _clearLeasedRelay(initialUsageContext?.leaseId || "");
          const replacement = await _leaseRelayCredential({ retryAttempt: 0, forceNew: true });
          if (replacement?.apiKey && replacement?.keyId) {
            apiKey = replacement.apiKey;
            initialUsageContext = _usageContextFromLease(replacement);
            continue;
          }
        }
        if (relayManaged) {
          await _reportLeaseFailure(initialUsageContext, {
            error,
            statusCode: error?.status || 401,
            errorMessage: error?.message || "failed to fetch JWT",
          });
          _releaseLeaseUsage(initialUsageContext);
          _clearLeasedRelay(initialUsageContext?.leaseId || "");
        }
        throw error;
      }
    }
  }
  const credentialState = {
    apiKey,
    jwt,
    usageContext: initialUsageContext,
    relayManaged,
  };
  runState.credentialState = credentialState;

  // Advisory rate-limit probe. Runs concurrently with the bootstrap phase and
  // local repo-map work instead of adding a serial RTT up front; the streaming
  // path already downgrades 429s with bounded cross-key failover, so the probe
  // only needs to settle before the main search loop starts.
  log("Checking rate limit...");
  const probedKeyId = credentialState.usageContext?.keyId || "";
  const rateLimitPromise = checkRateLimit(apiKey, jwt, credentialState.usageContext)
    .catch(() => true);

  const handleRateLimited = async () => {
    if (credentialState.relayManaged) {
      const failedKeyId = credentialState.usageContext?.keyId || "";
      await _reportLeaseFailure(credentialState.usageContext, {
        statusCode: 429,
        errorMessage: "rate limit check rejected the leased key",
      });
      _clearRelayCredentialState(credentialState);
      const alternate = await _leaseRelayCredential({
        excludeKeyIds: failedKeyId ? [failedKeyId] : [],
        retryAttempt: 1,
        forceNew: true,
      });
      if (!alternate) {
        return { files: [], error: `RELAY_POOL_BUSY: ${_lastRelayError || "no alternate key available"}` };
      }
      credentialState.apiKey = alternate.apiKey;
      credentialState.usageContext = _usageContextFromLease(alternate);
      try {
        credentialState.jwt = await getCachedJwt(alternate.apiKey, credentialState.usageContext);
      } catch (error) {
        await _reportLeaseFailure(credentialState.usageContext, {
          error,
          statusCode: error?.status || 401,
          errorMessage: error?.message || "failed to fetch JWT",
        });
        _clearRelayCredentialState(credentialState);
        throw error;
      }
      if (await checkRateLimit(credentialState.apiKey, credentialState.jwt, credentialState.usageContext)) {
        // Keep this alternate lease for the first streaming call. The helper
        // clears it after that logical call completes.
        return null;
      }
      await _reportLeaseFailure(credentialState.usageContext, {
        statusCode: 429,
        errorMessage: "rate limit check rejected the alternate leased key",
      });
      _clearRelayCredentialState(credentialState);
      return { files: [], error: "Rate limited, please try again later" };
    }
    return { files: [], error: "Rate limited, please try again later" };
  };

  const executor = new ToolExecutor(projectRoot);
  const toolDefs = getToolDefinitions(maxCommands);
  const systemPrompt = buildSystemPrompt(maxTurns, maxCommands, maxResults);

  let bootstrapHints = null;
  if (bootstrapEnabled) {
    bootstrapHints = await _runBootstrapPhase({
      query,
      projectRoot,
      credentialState,
      timeoutMs,
      excludePaths: effectiveExcludePaths,
      bootstrapTreeDepth,
      bootstrapMaxTurns,
      bootstrapMaxCommands,
      onProgress,
    });
    log(`Bootstrap hints: patterns=${bootstrapHints.rgPatterns.length}, hot_dirs=${bootstrapHints.hotDirs.length}`);
  }

  // Settle the advisory probe before the main loop; a 429 still gets the
  // bounded key-switch treatment. Skip if bootstrap failover already replaced
  // the probed key — the verdict belongs to the old key.
  const probeStillRelevant = !credentialState.relayManaged ||
    (credentialState.usageContext?.keyId || "") === probedKeyId;
  if (!(await rateLimitPromise) && probeStillRelevant) {
    const rateLimited = await handleRateLimited();
    if (rateLimited) return rateLimited;
  }

  const { tree: repoMap, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack, autoDepth, strategy: repoMapStrategy, hotDirs = [] } = buildOptimizedRepoMap({
    query,
    projectRoot,
    treeDepth,
    excludePaths: effectiveExcludePaths,
    optimizer: {
      mode: repoMapMode,
      bootstrapTreeDepth,
      hotspotTopK,
      hotspotTreeDepth,
      maxBytes: hotspotMaxBytes,
    },
    bootstrapHints,
    onProgress,
  });
  log(`Repo map: tree -L ${actualDepth} (${(treeSizeBytes / 1024).toFixed(1)}KB)${fellBack ? ` [fell back from L=${treeDepth}]` : ""}${autoDepth ? " [auto]" : ""} [strategy=${repoMapStrategy}]${hotDirs.length ? ` [hot=${hotDirs.join(",")}]` : ""}`);
  const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\``;

  const messages = [
    { role: 5, content: systemPrompt },
    { role: 1, content: userContent },
  ];

  // Trim state for smart context trimming
  const trimState = {
    query,
    turn: 0,
    recentFiles: [],
    recentPatterns: [],
    recentCommands: [],
  };

  // Total API calls = maxTurns + 1 (last round for answer)
  const totalApiCalls = maxTurns + 1;
  let compensatedTurns = 0;
  const MAX_COMPENSATIONS = 2;
  let forceAnswerInjected = false;
  let contextTrimmed = false;

  const buildSearchMeta = (turnsUsed, extra = {}) => ({
    treeDepth: actualDepth,
    requestedTreeDepth: treeDepth,
    treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
    fellBack,
    autoDepth,
    contextTrimmed,
    projectRoot,
    repoMapStrategy,
    hotDirs,
    excludePaths: effectiveExcludePaths,
    turnsUsed,
    ...extra,
  });

  for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn++) {
    log(`Turn ${turn + 1}/${totalApiCalls}`);
    trimState.turn = turn + 1;

    const buildTurnProto = (currentApiKey, currentJwt) => {
      let proto = _buildRequest(currentApiKey, currentJwt, messages, toolDefs);
      if (DEBUG_MODE) {
        console.error(`\n[DEBUG] ===== Turn ${turn + 1} Request =====`);
        console.error(`[DEBUG] Messages count: ${messages.length}`);
        console.error(`[DEBUG] Last message role: ${messages[messages.length - 1]?.role}`);
        console.error(`[DEBUG] Proto size: ${proto.length} bytes`);
      }
      const MAX_PROTO_BYTES = 320 * 1024;
      if (proto.length > MAX_PROTO_BYTES && messages.length > 1) {
        log(`Proto size ${proto.length} bytes > ${MAX_PROTO_BYTES}. Trimming context before request...`);
        if (_trimMessages(messages, trimState)) {
          contextTrimmed = true;
          proto = _buildRequest(currentApiKey, currentJwt, messages, toolDefs);
          if (DEBUG_MODE) console.error(`[DEBUG] Proto size after trim: ${proto.length} bytes`);
        }
      }
      return proto;
    };

    let respData;
    try {
      respData = await _streamingRequestWithRelayFailover({
        credentialState,
        buildProto: buildTurnProto,
        timeoutMs,
        maxRetries: 2,
      });
    } catch (e) {
      const errCode = e.code || "UNKNOWN";
      const baseMeta = buildSearchMeta(turn + 1, { errorCode: errCode });

      // Auto-retry with trimmed context on payload/timeout errors
      if ((errCode === "PAYLOAD_TOO_LARGE" || errCode === "TIMEOUT") && messages.length > 1) {
        log(`${errCode} on turn ${turn + 1}: trimming context and retrying...`);
        if (_trimMessages(messages, trimState)) contextTrimmed = true;
        try {
          respData = await _streamingRequestWithRelayFailover({
            credentialState,
            buildProto: (currentApiKey, currentJwt) =>
              _buildRequest(currentApiKey, currentJwt, messages, toolDefs),
            timeoutMs,
            maxRetries: 2,
          });
        } catch (retryErr) {
          const retryCode = retryErr.code || errCode;
          return {
            files: [],
            error: `${retryCode}: ${retryErr.message} (retry after context trim also failed)`,
            _meta: buildSearchMeta(turn + 1, { errorCode: retryCode, contextTrimmed: true }),
          };
        }
      } else {
        return {
          files: [],
          error: `${errCode}: ${e.message}`,
          _meta: baseMeta,
        };
      }
    }

    const [thinking, toolInfo] = _parseResponse(respData);

    // Debug logging
    if (DEBUG_MODE) {
      console.error(`\n[DEBUG] ===== Turn ${turn + 1} Response =====`);
      console.error(`[DEBUG] Response size: ${respData.length} bytes`);
      console.error(`[DEBUG] Thinking: ${thinking.slice(0, 500)}${thinking.length > 500 ? '...' : ''}`);
      console.error(`[DEBUG] Tool info: ${toolInfo ? `${toolInfo[0]}` : 'null'}`);
    }

    if (toolInfo === null) {
      if (thinking.startsWith("[Error]")) {
        return { files: [], error: thinking, _meta: buildSearchMeta(turn + 1) };
      }
      return { files: [], raw_response: thinking, _meta: buildSearchMeta(turn + 1) };
    }

    const [toolName, toolArgs] = toolInfo;

    if (toolName === "answer") {
      const answerXml = toolArgs.answer || "";
      log("Received final answer");
      const result = _parseAnswer(answerXml, projectRoot);
      result.rg_patterns = [...new Set(executor.collectedRgPatterns)];
      result._meta = buildSearchMeta(turn + 1);
      return result;
    }

    if (toolName === "restricted_exec") {
      const callId = randomUUID();
      const argsJson = JSON.stringify(toolArgs);

      const cmds = Object.keys(toolArgs).filter((k) => k.startsWith("command"));
      log(`Executing ${cmds.length} local commands`);

      // Debug logging
      if (DEBUG_MODE) {
        console.error(`\n[DEBUG] ===== Tool Calls =====`);
        for (const cmdKey of cmds) {
          const cmd = toolArgs[cmdKey];
          console.error(`[DEBUG] ${cmdKey}: ${JSON.stringify(cmd)}`);
        }
      }

      // Check for valid commands (those with a type field)
      const validCommands = cmds.filter((k) => {
        const cmd = toolArgs[k];
        return cmd && typeof cmd === "object" && cmd.type;
      });
      if (validCommands.length === 0 && compensatedTurns < MAX_COMPENSATIONS) {
        compensatedTurns++;
        log(`Turn compensation: no valid commands, extending search by 1 turn (${compensatedTurns}/${MAX_COMPENSATIONS})`);
      } else if (validCommands.length === 0) {
        log(`Turn compensation skipped: max compensations (${MAX_COMPENSATIONS}) reached, forcing turn advance`);
      }

      const results = await executor.execToolCallAsync(toolArgs);

      // Update trim state with a compact summary of what we executed
      try {
        const tailUnique = (arr, n) => {
          const out = [];
          const seen = new Set();
          for (let i = arr.length - 1; i >= 0 && out.length < n; i--) {
            const v = arr[i];
            if (typeof v !== "string" || !v) continue;
            if (seen.has(v)) continue;
            seen.add(v);
            out.push(v);
          }
          return out.reverse();
        };

        const newCommands = [];
        const newFiles = [];
        const newPatterns = [];

        for (const cmdKey of cmds) {
          const cmd = toolArgs[cmdKey];
          if (!cmd || typeof cmd !== "object") continue;
          const t = cmd.type;
          if (t === "rg" && cmd.pattern) {
            newPatterns.push(cmd.pattern);
            newCommands.push({ type: "rg", desc: `rg ${cmd.pattern}` });
          } else if (t === "readfile" && cmd.file) {
            const shortFile = cmd.file.replace(/^\/codebase\//, "");
            newFiles.push(shortFile);
            newCommands.push({ type: "readfile", desc: `read ${shortFile}` });
          } else if (t === "tree" && cmd.path) {
            newCommands.push({ type: "tree", desc: `tree ${cmd.path}` });
          } else if (t === "powershell" && cmd.command) {
            newCommands.push({ type: "powershell", desc: "strict Windows process query" });
          }
        }

        trimState.recentCommands = [...trimState.recentCommands, ...newCommands].slice(-12);
        trimState.recentFiles = tailUnique([...trimState.recentFiles, ...newFiles], 20);
        trimState.recentPatterns = tailUnique([...trimState.recentPatterns, ...newPatterns], 30);
      } catch {
        // Ignore errors in trim state update
      }

      messages.push({
        role: 2,
        content: thinking,
        tool_call_id: callId,
        tool_name: "restricted_exec",
        tool_args_json: argsJson,
      });
      messages.push({ role: 4, content: results, ref_call_id: callId });

      // Inject force-answer after last effective search round
      const effectiveTurn = turn - compensatedTurns;
      if (effectiveTurn >= maxTurns - 1 && !forceAnswerInjected) {
        messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
        forceAnswerInjected = true;
        log("Injected force-answer prompt");
      }
    }
  }

  return {
    files: [],
    error: "Max turns reached without getting an answer",
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    _meta: buildSearchMeta(totalApiCalls + compensatedTurns),
  };
}

/**
 * Search and return formatted result suitable for MCP tool response.
 *
 * @param {Object} opts
 * @param {string} opts.query
 * @param {string} opts.projectRoot
 * @param {string} [opts.apiKey]
 * @param {number} [opts.maxTurns=3]
 * @param {number} [opts.maxCommands=8]
 * @param {number} [opts.maxResults=10]
 * @param {number} [opts.treeDepth=3]
 * @param {number} [opts.timeoutMs=30000]
 * @param {string[]} [opts.excludePaths=[]]
 * @returns {Promise<string>}
 */
function _formatSearchResult(result, options) {
  const {
    maxTurns = 3,
    maxCommands = 8,
    maxResults = 10,
    timeoutMs = 30000,
    excludePaths = [],
  } = options;
  if (result.error) {
    const meta = result._meta;
    let errMsg = `Error: ${result.error}`;
    if (meta) {
      errMsg += `\n\n[diagnostic] error_type=${meta.errorCode || "unknown"}, tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
      if (meta.fellBack) errMsg += ` (auto fell back from requested depth)`;
      if (meta.contextTrimmed) errMsg += `, context_trimmed=true`;
      if (meta.projectRoot) errMsg += `\n[diagnostic] project_path=${meta.projectRoot}`;
      errMsg += `\n[config] max_turns=${maxTurns}, max_results=${maxResults}, max_commands=${maxCommands}, timeout_ms=${timeoutMs}`;
      if (excludePaths.length) errMsg += `, exclude_paths=[${excludePaths.join(", ")}]`;
      // Targeted hints based on error type
      if (meta.errorCode === "PAYLOAD_TOO_LARGE" || meta.errorCode === "TIMEOUT") {
        errMsg += `\n[hint] Payload/timeout error. Try: reduce tree_depth, reduce max_turns, add exclude_paths, or narrow project_path to a subdirectory.`;
      } else if (meta.errorCode === "AUTH_ERROR") {
        errMsg += `\n[hint] Authentication error. Configure YCE_RELAY_URL/YCE_RELAY_TOKEN (YCE_RELAY_TOKEN must be a YCE search key), or set YCE_API_KEY, then run yce-engine.mjs --check-key.`;
      } else if (meta.errorCode === "RATE_LIMITED") {
        errMsg += `\n[hint] Rate limited. Wait a moment and retry.`;
      } else {
        errMsg += `\n[hint] If the error is payload-related, try a lower tree_depth value or add exclude_paths.`;
      }
    }
    return errMsg;
  }

  const files = result.files || [];
  const rgPatterns = result.rg_patterns || [];
  // Deduplicate + filter short patterns
  const uniquePatterns = [...new Set(rgPatterns)].filter((p) => p.length >= 3);

  if (!files.length && !uniquePatterns.length) {
    const raw = result.raw_response || "";
    if (!raw) return "No relevant files found.";
    const MAX_RAW = 500;
    const truncated = raw.length > MAX_RAW ? raw.slice(0, MAX_RAW) + "\n...[raw_response truncated]..." : raw;
    return `No relevant files found.\n\nRaw response:\n${truncated}`;
  }

  const parts = [];
  const n = files.length;

  if (files.length) {
    parts.push(`Found ${n} relevant files.`);
    parts.push("");
    for (let i = 0; i < files.length; i++) {
      const entry = files[i];
      const rangesStr = entry.ranges.map(([s, e]) => `L${s}-${e}`).join(", ");
      parts.push(`  [${i + 1}/${n}] ${entry.full_path} (${rangesStr})`);
    }
  } else {
    parts.push("No files found.");
  }

  if (uniquePatterns.length) {
    parts.push("");
    parts.push(`grep keywords: ${uniquePatterns.join(", ")}`);
  }

  // Append diagnostic metadata so the calling AI knows what happened
  const meta = result._meta;
  if (meta) {
    const fbNote = meta.fellBack ? ` (fell back from requested depth)` : "";
    parts.push("");
    let configLine = `[config] tree_depth=${meta.treeDepth}${fbNote}, tree_size=${meta.treeSizeKB}KB, max_turns=${maxTurns}, max_results=${maxResults}, timeout_ms=${timeoutMs}`;
    if (excludePaths.length) configLine += `, exclude_paths=[${excludePaths.join(", ")}]`;
    parts.push(configLine);
  }

  return parts.join("\n");
}

function _buildStructuredDiagnostics(result, options) {
  const meta = result?._meta || {};
  return {
    tree_depth: meta.treeDepth ?? options.treeDepth ?? null,
    requested_tree_depth: meta.requestedTreeDepth ?? options.treeDepth ?? null,
    tree_size_kb: meta.treeSizeKB ?? null,
    fell_back: meta.fellBack === true,
    auto_depth: meta.autoDepth === true || options.treeDepth === 0,
    context_trimmed: meta.contextTrimmed === true,
    repo_map_strategy: meta.repoMapStrategy || options.repoMapMode || "bootstrap_hotspot",
    hot_dirs: Array.isArray(meta.hotDirs) ? meta.hotDirs : [],
    exclude_paths: Array.isArray(meta.excludePaths) ? meta.excludePaths : [...(options.excludePaths || [])],
    max_turns: options.maxTurns ?? 3,
    max_commands: options.maxCommands ?? 8,
    max_results: options.maxResults ?? 10,
    timeout_ms: options.timeoutMs ?? 30000,
    bootstrap_enabled: options.bootstrapEnabled !== false,
    bootstrap_tree_depth: options.bootstrapTreeDepth ?? 1,
    hotspot_top_k: options.hotspotTopK ?? 4,
    hotspot_tree_depth: options.hotspotTreeDepth ?? 2,
    hotspot_max_bytes: options.hotspotMaxBytes ?? 120 * 1024,
    bootstrap_max_turns: options.bootstrapMaxTurns ?? 2,
    bootstrap_max_commands: options.bootstrapMaxCommands ?? 6,
    turns_used: meta.turnsUsed ?? null,
    error_type: meta.errorCode || null,
    project_path: meta.projectRoot || options.projectRoot || null,
  };
}

export async function searchWithDetails(options) {
  const result = await search(options);
  const files = (result.files || []).map((entry) => ({
    path: entry.full_path,
    ranges: Array.isArray(entry.ranges) ? entry.ranges : [],
  }));
  const grepPatterns = [...new Set(result.rg_patterns || [])].filter((pattern) => pattern.length >= 3);
  const output = _formatSearchResult(result, options);
  return {
    success: !result.error,
    output,
    result_present: files.length > 0 || grepPatterns.length > 0,
    empty_result: !result.error && files.length === 0 && grepPatterns.length === 0,
    files,
    grep_patterns: grepPatterns,
    diagnostics: _buildStructuredDiagnostics(result, options),
    error: result.error || null,
  };
}

export async function searchWithContent(options) {
  const details = await searchWithDetails(options);
  return details.output;
}

/**
 * Extract YCE API key info (for CLI/tool use).
 * @returns {Promise<Object>}
 */
export async function extractKeyInfo() {
  const leased = await leaseApiKeyFromRelay();
  if (leased) {
    return { api_key: leased, db_path: "relay:/yce/lease-key" };
  }

  const envKey = String(process.env.YCE_API_KEY || "").trim();
  if (envKey) {
    return { api_key: envKey, db_path: "env:YCE_API_KEY" };
  }

  return {
    error: "YCE relay key lease failed.",
    hint:
      "Configure YCE_RELAY_URL/YCE_RELAY_TOKEN (default relay: https://yce.aigy.de; YCE_RELAY_TOKEN must be a YCE search key) " +
      "or set YCE_API_KEY.",
    detail: _lastRelayError || undefined,
    db_path: _normalizeRelayUrl(process.env.YCE_RELAY_URL) || DEFAULT_YCE_RELAY_ORIGIN,
  };
}

export const __test = {
  YceEngineError,
  extractStreamError: _extractStreamError,
  isTransientCapacitySignal: _isTransientCapacitySignal,
  leaseApiKeyFromRelay,
  leaseRelayCredential: _leaseRelayCredential,
  protocolAuthHeaders: _protocolAuthHeaders,
  usesPublicYceProtocolProxy: _usesPublicYceProtocolProxy,
  streamingRequest: _streamingRequest,
  streamingRequestWithRelayFailover: _streamingRequestWithRelayFailover,
  API_BASE,
  AUTH_BASE,
  unaryRequest: _unaryRequest,
  classifyError: _classifyError,
  flushUsageReports: _flushUsageReports,
  leaseReusable: _leaseReusable,
  accumulateLeaseUsage: _accumulateLeaseUsage,
  releaseLeaseUsage: _releaseLeaseUsage,
  reportLeaseFailure: _reportLeaseFailure,
  clearRelayCredentialState: _clearRelayCredentialState,
  setRelayStateFile(path) {
    _relayStateFile = path;
    _relayStateLoaded = false;
  },
  resetRelayState() {
    _leasedRelay = null;
    _lastRelayError = "";
    _lastRelayFailure = null;
    _relayQuotaBlockedUntilMs = 0;
    _relayLeaseBackoffUntilMs = 0;
    _relayStateLoaded = false;
    _jwtCache.clear();
    try { rmSync(_relayStateFile, { force: true }); } catch {}
  },
};
