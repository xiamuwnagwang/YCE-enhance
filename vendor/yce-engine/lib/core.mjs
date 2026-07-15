/**
 * YCE Engine — core protocol implementation (Node.js).
 *
 * YCE semantic code search engine.
 *
 * Flow:
 *   query + tree → YCE semantic search API
 *   → YCE returns tool_calls (rg/readfile/tree/ls/glob, up to 8 parallel)
 *   → execute locally → send results back → repeat for N rounds
 *   → ANSWER: file paths + line ranges + suggested rg patterns
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative, sep, isAbsolute } from "node:path";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { platform, arch, release, version as osVersion, hostname, cpus, totalmem } from "node:os";

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
 * Classify a raw fetch/HTTP error into a YceEngineError.
 * @param {Error} err
 * @returns {YceEngineError}
 */
function _classifyError(err) {
  if (err instanceof YceEngineError) return err;

  // HTTP status-based classification
  if (err.status) {
    const s = err.status;
    if (s === 413) return new YceEngineError(err.message, "PAYLOAD_TOO_LARGE", { status: s });
    if (s === 429) return new YceEngineError(err.message, "RATE_LIMITED", { status: s });
    if (s === 401 || s === 403) return new YceEngineError(err.message, "AUTH_ERROR", { status: s });
    return new YceEngineError(err.message, "SERVER_ERROR", { status: s });
  }

  // Timeout (AbortSignal.timeout throws AbortError or TimeoutError)
  if (err.name === "AbortError" || err.name === "TimeoutError" || /timeout/i.test(err.message)) {
    return new YceEngineError(err.message, "TIMEOUT");
  }

  // Everything else is a network-level issue
  return new YceEngineError(err.message, "NETWORK_ERROR");
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
an object with a \`type\` field of \`rg\`, \`readfile\`, or \`tree\` and the appropriate fields for that type.
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
    description: `Command ${n} to execute. Must be one of: rg, readfile, or tree.`,
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
        description: "Execute restricted commands (rg, readfile, tree, ls, glob) in parallel.",
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

async function _requestRelayLease({ excludeKeyIds = [], retryAttempt = 0 } = {}) {
  const normalizedExclusions = [...new Set(
    (excludeKeyIds || []).map((value) => String(value || "").trim()).filter(Boolean),
  )];
  const normalizedRetryAttempt = retryAttempt === 1 ? 1 : 0;
  _lastRelayError = "";
  const relayUrl = _normalizeRelayUrl(process.env.YCE_RELAY_URL) || DEFAULT_YCE_RELAY_ORIGIN;
  const relayToken = String(process.env.YCE_RELAY_TOKEN || "").trim();
  if (!relayToken) {
    _lastRelayError = "missing relay token (set YCE_RELAY_TOKEN)";
    return null;
  }

  try {
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
      const relayCode = String(errorPayload?.code || "").trim();
      const retryAfter = String(response.headers.get("retry-after") || "").trim();
      _lastRelayError = `relay lease failed: HTTP ${response.status}${relayCode ? ` ${relayCode}` : ""}${retryAfter ? ` retry-after=${retryAfter}s` : ""} from ${relayUrl}/yce/lease-key`;
      return null;
    }

    const payload = await response.json();
    const apiKey = String(payload?.api_key || "").trim();
    if (!isUsableLeasedApiKey(apiKey)) return null;

    return {
      apiKey,
      keyId: String(payload?.key_id || "").trim(),
      leaseId: String(payload?.lease_id || "").trim(),
      relayUrl,
      relayToken,
      retryAttempt: normalizedRetryAttempt,
      leaseExpiresAt: String(payload?.lease_expires_at || "").trim(),
    };
  } catch (error) {
    _lastRelayError = `relay lease error: ${error?.message || String(error)}`;
    return null;
  }
}

async function leaseApiKeyFromRelay({ excludeKeyIds = [], retryAttempt = 0, forceNew = false } = {}) {
  const hasExclusions = (excludeKeyIds || []).some((value) => String(value || "").trim());
  const normalizedRetryAttempt = retryAttempt === 1 ? 1 : 0;
  if (_leasedRelay?.apiKey && !forceNew && !hasExclusions && normalizedRetryAttempt === 0) {
    return _leasedRelay.apiKey;
  }
  if (forceNew) _leasedRelay = null;
  const leased = await _requestRelayLease({ excludeKeyIds, retryAttempt: normalizedRetryAttempt });
  if (!leased) return null;
  _leasedRelay = leased;
  return leased.apiKey;
}

function _clearLeasedRelay(expectedLeaseId = "") {
  if (!_leasedRelay) return;
  if (expectedLeaseId && _leasedRelay.leaseId !== expectedLeaseId) return;
  _leasedRelay = null;
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

async function _reportYceUsage(usageContext, { statusCode = null, errorMessage = "", durationMs = null } = {}) {
  if (!usageContext?.relayUrl || !usageContext?.relayToken || !usageContext?.keyId) return;
  try {
    await fetch(`${usageContext.relayUrl}/yce/usage`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${usageContext.relayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key_id: usageContext.keyId,
        lease_id: usageContext.leaseId || "",
        event: "code_search",
        status_code: typeof statusCode === "number" ? statusCode : null,
        error_message: String(errorMessage || "").slice(0, 1000),
        duration_ms: typeof durationMs === "number" ? durationMs : null,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Usage reporting must never break local code search.
  }
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
 * @param {string} url
 * @param {Buffer} protoBytes
 * @param {boolean} [compress=true]
 * @returns {Promise<Buffer>}
 */
async function _unaryRequest(url, protoBytes, compress = true, usageContext = null) {
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

  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });

  let resp;
  try {
    resp = await doFetch();
  } catch (error) {
    throw _classifyError(error);
  }

  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw _classifyError(err);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
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

  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body: frame,
    signal: AbortSignal.timeout(abortMs),
  });

  const logicalStartedAt = Date.now();
  let lastErr;
  let lastStatus = null;
  let lastErrorMessage = "request failed";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await doFetch();
      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        lastErr = err;
        lastStatus = resp.status;
        lastErrorMessage = err.message;
        // 429 is a capacity signal for one bounded cross-key retry. Other 4xx
        // failures are client/auth errors and must not be retried on another key.
        if (resp.status === 429 || (resp.status >= 400 && resp.status < 500)) break;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
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
      await _reportYceUsage(usageContext, {
        statusCode: resp.status,
        errorMessage: "",
        durationMs: Date.now() - logicalStartedAt,
      });
      return data;
    } catch (e) {
      lastErr = e;
      lastStatus = typeof e?.status === "number" ? e.status : null;
      lastErrorMessage = e?.message || e?.code || "request failed";
      const classified = _classifyError(e);
      if (classified.code === "AUTH_ERROR" || classified.code === "PAYLOAD_TOO_LARGE") break;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  const classified = _classifyError(lastErr || new Error(lastErrorMessage));
  await _reportYceUsage(usageContext, {
    statusCode: lastStatus,
    errorMessage: lastErrorMessage,
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
  state.apiKey = null;
  state.jwt = null;
  state.usageContext = null;
}

function _isCrossKeyRetryable(error) {
  if (!error) return false;
  if (error.code === "TRANSIENT_CAPACITY" || error.code === "RATE_LIMITED") return true;
  return _isTransientCapacitySignal({
    status: error?.details?.status ?? error?.status ?? null,
    code: error?.details?.upstreamCode || error?.code || "",
    message: error?.message || "",
  });
}

async function _streamingRequestWithRelayFailover({
  credentialState,
  buildProto,
  timeoutMs = 30000,
  maxRetries = 2,
  leaseCredential = _leaseRelayCredential,
  getJwt = getCachedJwt,
  request = _streamingRequest,
}) {
  if (!credentialState || typeof buildProto !== "function") {
    throw new Error("credentialState and buildProto are required");
  }

  const ensureCredential = async (options = {}) => {
    if (!credentialState.relayManaged) return;
    if (credentialState.apiKey && credentialState.jwt && credentialState.usageContext) return;
    const leased = await leaseCredential(options);
    if (!leased?.apiKey || !leased?.keyId) {
      throw new YceEngineError(
        _lastRelayError || "relay key pool is temporarily unavailable",
        options.retryAttempt === 1 ? "RELAY_POOL_BUSY" : "RELAY_UNAVAILABLE",
      );
    }
    credentialState.apiKey = leased.apiKey;
    credentialState.usageContext = {
      keyId: leased.keyId,
      leaseId: leased.leaseId || "",
      relayUrl: leased.relayUrl,
      relayToken: leased.relayToken,
    };
    try {
      credentialState.jwt = await getJwt(leased.apiKey, credentialState.usageContext);
    } catch (error) {
      await _reportYceUsage(credentialState.usageContext, {
        statusCode: error?.status || 401,
        errorMessage: error?.message || "failed to fetch JWT",
      });
      _clearRelayCredentialState(credentialState);
      throw error;
    }
  };

  await ensureCredential({ retryAttempt: 0, forceNew: true });
  const failedKeyId = credentialState.usageContext?.keyId || "";
  try {
    const data = await request(
      buildProto(credentialState.apiKey, credentialState.jwt),
      timeoutMs,
      maxRetries,
      credentialState.usageContext,
    );
    if (credentialState.relayManaged) _clearRelayCredentialState(credentialState);
    return data;
  } catch (error) {
    if (!credentialState.relayManaged || !_isCrossKeyRetryable(error)) {
      if (credentialState.relayManaged) _clearRelayCredentialState(credentialState);
      throw error;
    }
    _clearRelayCredentialState(credentialState);
  }

  const alternate = await leaseCredential({
    excludeKeyIds: failedKeyId ? [failedKeyId] : [],
    retryAttempt: 1,
    forceNew: true,
  });
  if (!alternate?.apiKey || !alternate?.keyId) {
    throw new YceEngineError(
      _lastRelayError || "relay key pool is busy after one bounded failover",
      "RELAY_POOL_BUSY",
      { excludedKeyId: failedKeyId },
    );
  }

  credentialState.apiKey = alternate.apiKey;
  credentialState.usageContext = {
    keyId: alternate.keyId,
    leaseId: alternate.leaseId || "",
    relayUrl: alternate.relayUrl,
    relayToken: alternate.relayToken,
  };
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
      await _reportYceUsage(credentialState.usageContext, {
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
    if (e.status === 429) return false;
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
export async function search({
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
}) {
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
      initialUsageContext = {
        keyId: leased.keyId,
        leaseId: leased.leaseId || "",
        relayUrl: leased.relayUrl,
        relayToken: leased.relayToken,
      };
      relayManaged = true;
    } else {
      apiKey = String(process.env.YCE_API_KEY || "").trim();
      if (!apiKey) {
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
    try {
      jwt = await getCachedJwt(apiKey, initialUsageContext);
    } catch (error) {
      if (relayManaged) {
        await _reportYceUsage(initialUsageContext, {
          statusCode: error?.status || 401,
          errorMessage: error?.message || "failed to fetch JWT",
        });
        _clearLeasedRelay(initialUsageContext?.leaseId || "");
      }
      throw error;
    }
  }
  const credentialState = {
    apiKey,
    jwt,
    usageContext: initialUsageContext,
    relayManaged,
  };

  // Check rate limit
  log("Checking rate limit...");
  if (!(await checkRateLimit(apiKey, jwt, credentialState.usageContext))) {
    if (credentialState.relayManaged) {
      const failedKeyId = credentialState.usageContext?.keyId || "";
      await _reportYceUsage(credentialState.usageContext, {
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
      credentialState.usageContext = {
        keyId: alternate.keyId,
        leaseId: alternate.leaseId || "",
        relayUrl: alternate.relayUrl,
        relayToken: alternate.relayToken,
      };
      try {
        credentialState.jwt = await getCachedJwt(alternate.apiKey, credentialState.usageContext);
      } catch (error) {
        await _reportYceUsage(credentialState.usageContext, {
          statusCode: error?.status || 401,
          errorMessage: error?.message || "failed to fetch JWT",
        });
        _clearRelayCredentialState(credentialState);
        throw error;
      }
      if (await checkRateLimit(credentialState.apiKey, credentialState.jwt, credentialState.usageContext)) {
        // Keep this alternate lease for the first streaming call. The helper
        // clears it after that logical call completes.
      } else {
        await _reportYceUsage(credentialState.usageContext, {
          statusCode: 429,
          errorMessage: "rate limit check rejected the alternate leased key",
        });
        _clearRelayCredentialState(credentialState);
        return { files: [], error: "Rate limited, please try again later" };
      }
    } else {
      return { files: [], error: "Rate limited, please try again later" };
    }
  }

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
  resetRelayState() {
    _leasedRelay = null;
    _lastRelayError = "";
    _jwtCache.clear();
  },
};
