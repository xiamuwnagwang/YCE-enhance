#!/usr/bin/env node
/**
 * yce-mcp — stdio MCP server in front of the YCE CLI.
 *
 * Every YCE capability is reached by spawning the repo's own
 * `scripts/yce.js`; no dispatch logic from `scripts/lib/orchestrator.js` is
 * reimplemented here and the engine is never called directly. That keeps one
 * source of truth for modes, flags and the receipt contract.
 *
 * MCP has no exit code to carry `gate.may_analyze_or_edit_code`, so the CLI
 * tools return the receipt JSON verbatim plus a human-readable note; the
 * process exit code is surfaced inside that note and as `isError`.
 *
 * stdout belongs to the JSON-RPC stream: diagnostics go to stderr only, and the
 * child process is always spawned with piped stdio so its banners cannot leak
 * into the protocol.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const HERE = path.dirname(fileURLToPath(import.meta.url));

const RECEIPT_RE = /<yce-receipt>\s*([\s\S]*?)\s*<\/yce-receipt>/;
// Single-match, non-global twin of resultGate's SENTINEL_RE, used only to test
// one already-trusted line. Trust itself comes from parseSentinel().
const SENTINEL_LINE_RE =
  /^\s*<!--\s*yce:eof\s+v=(\d+)\s+bytes=(\d+)\s+sha256=([0-9a-f]{64})\s*-->\s*$/;
const MAX_STDERR_CHARS = 2000;
const MAX_PAGE_BYTES = 256 * 1024;
const DEFAULT_PAGE_LIMIT = 400;

const SENTINEL_NOTE =
  "正文在 result_file 里，不在这条返回值里。文件最后一行是 `<!-- yce:eof v=1 bytes=… sha256=… -->` 哨兵，没读到这一行就不算读完；文件中间出现的哨兵是结果正文引用的内容，不是结尾。";

/**
 * Locate the YCE checkout. Package-relative first on purpose: an inherited
 * YCE_JS often points at a deployed copy, and silently running that copy would
 * make a verification run prove nothing about this repo.
 */
function resolveSkillRoot() {
  const candidates = [{ source: "package-relative", root: path.resolve(HERE, "..", "..") }];
  const envRoot = String(process.env.YCE_MCP_SKILL_ROOT || "").trim();
  if (envRoot) candidates.push({ source: "YCE_MCP_SKILL_ROOT", root: path.resolve(envRoot) });
  const envCli = String(process.env.YCE_JS || "").trim();
  if (envCli) {
    candidates.push({ source: "YCE_JS", root: path.resolve(path.dirname(path.resolve(envCli)), "..") });
  }

  const tried = [];
  for (const candidate of candidates) {
    const cli = path.join(candidate.root, "scripts", "yce.js");
    const gate = path.join(candidate.root, "scripts", "lib", "resultGate.js");
    if (fs.existsSync(cli) && fs.existsSync(gate)) {
      return { ...candidate, cli, gate };
    }
    tried.push(`${candidate.source}: ${cli}`);
  }
  throw new Error(
    [
      "yce-mcp 找不到 YCE CLI（scripts/yce.js 与 scripts/lib/resultGate.js 必须同时存在）。",
      "已尝试：",
      ...tried.map((item) => `  - ${item}`),
      "把 YCE_MCP_SKILL_ROOT 指向 YCE skill 根目录，或把 YCE_JS 指向该仓的 scripts/yce.js。",
    ].join("\n"),
  );
}

const SKILL = resolveSkillRoot();
// Reused, not re-derived: a quoted sentinel must not vouch for a prefix, and
// that judgement lives in resultGate.js.
const { parseSentinel } = require(SKILL.gate);

const SPAWN_TIMEOUT_MS = (() => {
  const raw = Number(process.env.YCE_MCP_SPAWN_TIMEOUT_MS);
  // Generous by design: the CLI owns per-stage timeouts (search/network ≥120s,
  // plan ≥300s) and a shorter cap here would cut off a healthy run.
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
})();

function pushValue(argv, flag, value) {
  if (value === undefined || value === null) return;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!text) return;
  argv.push(`--${flag}`, text);
}

function pushBool(argv, flag, value) {
  if (value === true) argv.push(`--${flag}`);
}

function truncateForNote(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  return trimmed.length > MAX_STDERR_CHARS
    ? `${trimmed.slice(0, MAX_STDERR_CHARS)}…（截断，完整内容见 CLI 直跑输出）`
    : trimmed;
}

/** Spawn the CLI. argv is an array, so paths containing spaces stay intact. */
function runCli(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SKILL.cli, ...argv], {
      cwd: SKILL.root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        argv,
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function parseReceipt(stdout) {
  const match = RECEIPT_RE.exec(String(stdout || ""));
  if (!match) return null;
  const text = match[1];
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function toolError(lines) {
  return {
    isError: true,
    content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
  };
}

/**
 * Shape the CLI outcome into an MCP result: receipt JSON first (the machine
 * contract), prose second.
 */
function buildCliResult(toolName, run) {
  if (run.timedOut) {
    return toolError([
      `${toolName}: yce CLI 被 yce-mcp 超时杀掉（上限 ${SPAWN_TIMEOUT_MS} ms，用 YCE_MCP_SPAWN_TIMEOUT_MS 调整）。这次没有收据，不得当成检索结果。`,
      `命令：node ${SKILL.cli} ${run.argv.join(" ")}`,
      truncateForNote(run.stderr) && `CLI stderr：\n${truncateForNote(run.stderr)}`,
    ]);
  }

  const receipt = parseReceipt(run.stdout);
  const notes = [
    `${toolName}: yce CLI 退出码 ${run.code}（0=放行；1=参数或用法错误；2=输出不完整必须重跑；3=完整但没有主结果）。`,
  ];

  if (receipt && receipt.json) {
    const data = receipt.json;
    const gate = data.gate || {};
    notes.push(
      `闸门：may_analyze_or_edit_code=${gate.may_analyze_or_edit_code} / may_use_network_facts=${gate.may_use_network_facts} / may_present_plan=${gate.may_present_plan}；只有本次要用的那一项为 true，才能据此分析或修改代码。`,
    );
    notes.push(
      `result_file=${data.result_file}（xml_bytes=${data.xml_bytes}，xml_sha256=${data.xml_sha256}）。`,
    );
    notes.push(SENTINEL_NOTE);
    notes.push(
      `分页读正文用 yce_read_result；复核用（在 ${SKILL.root} 下执行）：node ./scripts/validate-yce-result.mjs "${data.result_file}" --expect-sha256 ${data.xml_sha256} --expect-bytes ${data.xml_bytes}`,
    );
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      notes.push(`收据里有 ${data.errors.length} 条 errors，先看 errors 与 reasons 再决定下一步。`);
    }
  } else if (receipt) {
    notes.push(
      "stdout 里的 <yce-receipt> 块不是合法 JSON：按输出不完整处理，重跑一次，不要使用这次结果。",
    );
  } else {
    notes.push(
      "stdout 里没有 <yce-receipt> 块。CLI 在写结果文件失败时会把整份 XML 直接打到 stdout，--help 与 INVALID_ARGS 也是裸 XML；上面第一段是 CLI 原始 stdout，按它判断，不要当成收据。",
    );
  }

  const stderrNote = truncateForNote(run.stderr);
  if (stderrNote) notes.push(`CLI stderr（版本提示/降级/额度一类诊断，不是结果）：\n${stderrNote}`);

  const payload = receipt ? receipt.text : String(run.stdout || "").trim() || "(CLI stdout 为空)";
  return {
    isError: run.code !== 0,
    content: [
      { type: "text", text: payload },
      { type: "text", text: notes.join("\n") },
    ],
  };
}

async function callCli(toolName, argv) {
  try {
    const run = await runCli(argv);
    return buildCliResult(toolName, run);
  } catch (error) {
    return toolError([
      `${toolName}: 启动 yce CLI 失败：${error && error.message ? error.message : String(error)}`,
      `命令：node ${SKILL.cli} ${argv.join(" ")}`,
    ]);
  }
}

// --- shared schema fragments -------------------------------------------------
// Numeric bounds stay with the CLI (它的参数表是唯一权威): zod only enforces
// shape, so out-of-range values come back as the CLI's own INVALID_ARGS.

const cwdField = {
  cwd: z
    .string()
    .optional()
    .describe("目标项目绝对路径。不在该目录时必须传。"),
};

const taskFields = {
  task: z.string().optional().describe("任务卡 id，续接同一个任务锚点时传。"),
  no_task: z.boolean().optional().describe("true = 本次不创建也不关联任务卡。"),
};

const networkFields = {
  network_profile: z
    .enum(["quick", "balanced", "exhaustive"])
    .optional()
    .describe("联网检索档位，默认 balanced。"),
  library: z.string().optional().describe("限定官方库名。"),
  repo: z.string().optional().describe("限定 owner/name 仓库。"),
  timeout_network_ms: z.number().int().positive().optional(),
};

const searchTuningFields = {
  max_turns: z.number().int().optional(),
  max_commands: z.number().int().optional(),
  max_results: z.number().int().optional(),
  tree_depth: z.number().int().optional(),
  exclude: z.string().optional().describe("排除 glob，多个用逗号分隔。"),
  repo_map_mode: z.enum(["classic", "bootstrap_hotspot"]).optional(),
  bootstrap_mode: z.enum(["local", "remote"]).optional(),
  no_bootstrap: z.boolean().optional(),
  no_jev_screen: z.boolean().optional(),
  no_context: z.boolean().optional().describe("true = 关掉 code-context 附带片段。"),
  no_cache: z.boolean().optional().describe("true = 跳过检索缓存。"),
  timeout_search_ms: z.number().int().positive().optional(),
  out: z.string().optional().describe("结果落盘位置（文件或目录）；默认写临时目录。"),
};

function pushTaskArgs(argv, args) {
  pushValue(argv, "task", args.task);
  pushBool(argv, "no-task", args.no_task);
}

function pushNetworkArgs(argv, args) {
  pushValue(argv, "network-profile", args.network_profile);
  pushValue(argv, "library", args.library);
  pushValue(argv, "repo", args.repo);
  pushValue(argv, "timeout-network-ms", args.timeout_network_ms);
}

function pushSearchTuningArgs(argv, args) {
  pushValue(argv, "max-turns", args.max_turns);
  pushValue(argv, "max-commands", args.max_commands);
  pushValue(argv, "max-results", args.max_results);
  pushValue(argv, "tree-depth", args.tree_depth);
  pushValue(argv, "exclude", args.exclude);
  pushValue(argv, "repo-map-mode", args.repo_map_mode);
  pushValue(argv, "bootstrap-mode", args.bootstrap_mode);
  pushBool(argv, "no-bootstrap", args.no_bootstrap);
  pushBool(argv, "no-jev-screen", args.no_jev_screen);
  pushBool(argv, "no-context", args.no_context);
  pushBool(argv, "no-cache", args.no_cache);
  pushValue(argv, "timeout-search-ms", args.timeout_search_ms);
  pushValue(argv, "out", args.out);
}

// --- yce_read_result --------------------------------------------------------

function sliceLines(lines, offset, limit) {
  const page = [];
  let bytes = 0;
  let capped = false;
  for (let index = offset - 1; index < lines.length && page.length < limit; index += 1) {
    const lineBytes = Buffer.byteLength(lines[index], "utf8") + 1;
    if (page.length > 0 && bytes + lineBytes > MAX_PAGE_BYTES) {
      capped = true;
      break;
    }
    page.push(lines[index]);
    bytes += lineBytes;
  }
  return { page, bytes, capped };
}

function readResultPage(args) {
  const target = String(args.result_file || "");
  if (!path.isAbsolute(target)) {
    return toolError([
      `yce_read_result: result_file 必须是绝对路径，收到 "${target}"。用收据里的 result_file 原值。`,
    ]);
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    return toolError([
      `yce_read_result: 读不到文件 ${target}（${error && error.code ? error.code : "ERROR"}）。结果文件默认写在临时目录，会被清理；重跑一次 yce 拿新的 result_file。`,
    ]);
  }
  if (!stat.isFile()) {
    return toolError([`yce_read_result: ${target} 不是普通文件。`]);
  }

  const offset = args.offset === undefined ? 1 : args.offset;
  const limit = args.limit === undefined ? DEFAULT_PAGE_LIMIT : args.limit;
  if (offset < 1) {
    return toolError([`yce_read_result: offset 从 1 开始，收到 ${offset}。`]);
  }
  if (limit < 1) {
    return toolError([`yce_read_result: limit 至少为 1，收到 ${limit}。`]);
  }

  const raw = fs.readFileSync(target, "utf8");
  // On disk the shape is `body\n<sentinel>\n`; dropping that one trailing
  // newline keeps the sentinel as the real last line instead of an empty string.
  const text = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = text.split("\n");
  const totalLines = lines.length;

  if (offset > totalLines) {
    return toolError([
      `yce_read_result: offset ${offset} 越界，文件共 ${totalLines} 行（可读范围 1-${totalLines}）。`,
    ]);
  }

  const { page, bytes, capped } = sliceLines(lines, offset, limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset <= totalLines;
  const parsed = parseSentinel(raw);
  const lastLine = page[page.length - 1];
  // Two separate facts: the shape of the line actually returned, and whether
  // resultGate trusts that sentinel (sole match in the file, nothing after it).
  const lastLineIsSentinel = !hasMore && SENTINEL_LINE_RE.test(lastLine || "");
  const sentinelTrusted = Boolean(parsed.sentinel);

  const meta = {
    schema: "yce-read-result/1",
    result_file: target,
    total_lines: totalLines,
    offset,
    limit,
    returned_lines: page.length,
    returned_bytes: bytes,
    page_byte_capped: capped,
    next_offset: hasMore ? nextOffset : null,
    has_more: hasMore,
    eof_reached: !hasMore,
    last_line_is_sentinel: lastLineIsSentinel,
    sentinel_trusted: sentinelTrusted,
    eof_verified: lastLineIsSentinel && sentinelTrusted,
    sentinel: parsed.sentinel,
    sentinel_ambiguous: parsed.ambiguous === true,
  };

  const notes = [];
  if (meta.eof_verified) {
    notes.push("这是末页，最后一行就是 yce:eof 哨兵，正文已读完。");
  } else if (hasMore) {
    notes.push(`还没读完：下一页传 offset=${nextOffset}${capped ? "（本页按字节上限提前收尾）" : ""}。`);
  } else if (lastLineIsSentinel && parsed.ambiguous) {
    notes.push(
      "已到文件末尾，最后一行是哨兵行，但全文有多处 yce:eof 哨兵，按 resultGate 判据这份的完整性算 unverified：用 scripts/validate-yce-result.mjs 带收据的 --expect-sha256/--expect-bytes 复核，别只看哨兵。",
    );
  } else {
    notes.push(
      "已到文件末尾，但最后一行不是 yce:eof 哨兵：按输出不完整处理，重跑 yce，不要声称读完。",
    );
  }
  notes.push("文件中间出现的哨兵是结果正文引用的内容，不是结尾。");

  return {
    content: [
      { type: "text", text: `${JSON.stringify(meta, null, 2)}\n${notes.join("\n")}` },
      { type: "text", text: page.join("\n") },
    ],
  };
}

// --- server ----------------------------------------------------------------

const server = new McpServer(
  { name: "yce-mcp", version: pkg.version },
  { instructions: `YCE CLI over stdio. 检索正文只在收据的 result_file 里，用 yce_read_result 读到 yce:eof 哨兵为止。CLI: ${SKILL.cli}` },
);

server.registerTool(
  "yce_search",
  {
    title: "YCE 代码检索",
    description:
      "跑 scripts/yce.js 做仓库代码检索（mode=search；mode=auto 会先增强提示词再检索）。query 用准确简洁的英文，标识符/路径/报错原文保持原样。返回完整收据 JSON，正文在 result_file。",
    inputSchema: {
      query: z.string().min(1).describe("英文检索意图。"),
      mode: z.enum(["search", "auto"]).optional().describe("默认 search；需求模糊时用 auto。"),
      history: z.string().optional().describe("mode=auto 时的对话历史，用于增强。"),
      with_network: z.boolean().optional().describe("true = 同一次调用叠加联网检索。"),
      no_search: z.boolean().optional().describe("true = 只增强不检索（仅 mode=auto 有意义）。"),
      ...cwdField,
      ...taskFields,
      ...networkFields,
      ...searchTuningFields,
    },
  },
  async (args) => {
    const argv = [args.query, "--mode", args.mode || "search"];
    pushValue(argv, "cwd", args.cwd);
    pushValue(argv, "history", args.history);
    pushBool(argv, "with-network", args.with_network);
    pushBool(argv, "no-search", args.no_search);
    pushTaskArgs(argv, args);
    pushNetworkArgs(argv, args);
    pushSearchTuningArgs(argv, args);
    return callCli("yce_search", argv);
  },
);

server.registerTool(
  "yce_enhance",
  {
    title: "YCE 提示词增强",
    description:
      "跑 scripts/yce.js --mode enhance，只把模糊需求改写清楚，不做代码检索。返回完整收据 JSON，增强结果在 result_file。",
    inputSchema: {
      query: z.string().min(1).describe("要增强的原始需求。"),
      history: z.string().optional().describe("对话历史，形如 \"User: …\\nAI: …\"。"),
      enhance_backend: z
        .enum(["relay", "local", "yce", "cli"])
        .optional()
        .describe("增强后端；本机 CLI 用 local。"),
      language: z.enum(["zh-CN", "en-US"]).optional(),
      timeout_enhance_ms: z.number().int().positive().optional(),
      out: z.string().optional(),
      ...cwdField,
      ...taskFields,
    },
  },
  async (args) => {
    const argv = [args.query, "--mode", "enhance"];
    pushValue(argv, "cwd", args.cwd);
    pushValue(argv, "history", args.history);
    pushValue(argv, "enhance-backend", args.enhance_backend);
    pushValue(argv, "language", args.language);
    pushValue(argv, "timeout-enhance-ms", args.timeout_enhance_ms);
    pushValue(argv, "out", args.out);
    pushTaskArgs(argv, args);
    return callCli("yce_enhance", argv);
  },
);

server.registerTool(
  "yce_network_search",
  {
    title: "YCE 联网检索",
    description:
      "跑 scripts/yce.js --mode network 做外部事实检索与交叉验证。看收据 gate.may_use_network_facts，证据在 result_file。",
    inputSchema: {
      query: z.string().min(1).describe("外部事实问题。"),
      out: z.string().optional(),
      ...cwdField,
      ...taskFields,
      ...networkFields,
    },
  },
  async (args) => {
    const argv = [args.query, "--mode", "network"];
    pushValue(argv, "cwd", args.cwd);
    pushValue(argv, "out", args.out);
    pushTaskArgs(argv, args);
    pushNetworkArgs(argv, args);
    return callCli("yce_network_search", argv);
  },
);

server.registerTool(
  "yce_plan",
  {
    title: "YCE 规划（Y-Plan）",
    description:
      "跑 scripts/yce.js --mode plan 只出 Markdown 计划，不改文件、不跑命令。看收据 gate.may_present_plan，计划正文在 result_file。",
    inputSchema: {
      query: z.string().min(1).describe("要规划的目标。"),
      with_search: z.boolean().optional().describe("true = 计划前先取仓库代码上下文（需要 cwd）。"),
      search_context: z.string().optional().describe("手工补充的代码/背景上下文。"),
      language: z.enum(["zh-CN", "en-US"]).optional(),
      plan_backend: z.enum(["relay", "local", "yce", "cli"]).optional(),
      plan_provider: z
        .enum([
          "claude",
          "openai",
          "openai-responses",
          "gemini",
          "codex",
          "cursor",
          "claude-code",
          "qoder",
          "kiro",
        ])
        .optional(),
      plan_model: z.string().optional(),
      plan_base_url: z.string().optional(),
      plan_temperature: z.number().optional(),
      web_search: z
        .enum(["enable", "disable"])
        .optional()
        .describe("显式开/关计划里的外部 web search。"),
      save: z.string().optional().describe("计划另存位置（目录或 .md 文件）。"),
      timeout_plan_ms: z.number().int().positive().optional(),
      out: z.string().optional(),
      ...cwdField,
      ...taskFields,
    },
  },
  async (args) => {
    const argv = [args.query, "--mode", "plan"];
    pushValue(argv, "cwd", args.cwd);
    pushBool(argv, "with-search", args.with_search);
    pushValue(argv, "search-context", args.search_context);
    pushValue(argv, "language", args.language);
    pushValue(argv, "plan-backend", args.plan_backend);
    pushValue(argv, "plan-provider", args.plan_provider);
    pushValue(argv, "plan-model", args.plan_model);
    pushValue(argv, "plan-base-url", args.plan_base_url);
    if (args.plan_temperature !== undefined) pushValue(argv, "plan-temperature", args.plan_temperature);
    if (args.web_search === "enable") argv.push("--enable-web-search");
    if (args.web_search === "disable") argv.push("--no-web-search");
    pushValue(argv, "save", args.save);
    pushValue(argv, "timeout-plan-ms", args.timeout_plan_ms);
    pushValue(argv, "out", args.out);
    pushTaskArgs(argv, args);
    return callCli("yce_plan", argv);
  },
);

server.registerTool(
  "yce_task",
  {
    title: "YCE 任务卡",
    description:
      "跑 scripts/yce.js task <show|list|check|done|new> 管任务锚点。注意：CLI 的 task 分支在模式解析之前就返回，输出是 <yce-task> XML，本工具原样透传，没有收据、没有 gate 字段。",
    inputSchema: {
      action: z.enum(["show", "list", "check", "done", "new"]).describe("任务卡子命令。"),
      task: z.string().optional().describe("任务卡 id；show 不传则取最近活跃卡。"),
      status: z.enum(["active", "done", "archived"]).optional().describe("list 用的状态过滤。"),
      stage: z.number().int().positive().optional().describe("check 的阶段序号。"),
      evidence: z.string().optional().describe("check 的证据文本。"),
      goal: z.string().optional().describe("new 的目标。"),
      accept: z.array(z.string()).optional().describe("new 的验收条目。"),
      title: z.string().optional().describe("new 的阶段标题。"),
      force: z.boolean().optional().describe("done 时跳过未通过的验收。"),
      ...cwdField,
    },
  },
  async (args) => {
    const argv = ["task", args.action];
    if (args.action === "check") {
      if (args.stage === undefined) {
        return toolError(["yce_task: action=check 必须传 stage（阶段序号）。"]);
      }
      argv.push(String(args.stage));
    }
    pushValue(argv, "cwd", args.cwd);
    pushValue(argv, "task", args.task);
    pushValue(argv, "status", args.status);
    pushValue(argv, "evidence", args.evidence);
    pushValue(argv, "goal", args.goal);
    pushValue(argv, "title", args.title);
    for (const item of args.accept || []) pushValue(argv, "accept", item);
    pushBool(argv, "force", args.force);

    try {
      const run = await runCli(argv);
      if (run.timedOut) {
        return toolError([
          `yce_task: yce CLI 被 yce-mcp 超时杀掉（上限 ${SPAWN_TIMEOUT_MS} ms）。`,
        ]);
      }
      const notes = [
        `yce_task(${args.action}): yce CLI 退出码 ${run.code}（0=成功，1=失败，看 <errors> 与 <hint>）。`,
        "task 子命令走的是 CLI 的任务卡分支，输出是 <yce-task> XML，不是 <yce-receipt>；它不带 gate.*、result_file、xml_sha256，别拿它当检索收据。",
      ];
      const stderrNote = truncateForNote(run.stderr);
      if (stderrNote) notes.push(`CLI stderr：\n${stderrNote}`);
      return {
        isError: run.code !== 0,
        content: [
          { type: "text", text: String(run.stdout || "").trim() || "(CLI stdout 为空)" },
          { type: "text", text: notes.join("\n") },
        ],
      };
    } catch (error) {
      return toolError([
        `yce_task: 启动 yce CLI 失败：${error && error.message ? error.message : String(error)}`,
      ]);
    }
  },
);

server.registerTool(
  "yce_read_result",
  {
    title: "读 YCE 结果文件",
    description:
      "按行分页读收据里的 result_file。末页最后一行就是 <!-- yce:eof … --> 哨兵；has_more=true 时按 next_offset 继续读。文件中间的哨兵是正文引用的内容，不是结尾。",
    inputSchema: {
      result_file: z.string().min(1).describe("收据里的 result_file 绝对路径。"),
      offset: z.number().int().optional().describe("起始行号，从 1 开始，默认 1。"),
      limit: z
        .number()
        .int()
        .optional()
        .describe(`本页最多读多少行，默认 ${DEFAULT_PAGE_LIMIT}；单页另有 256 KiB 字节上限。`),
    },
  },
  async (args) => readResultPage(args),
);

async function main() {
  // stderr only: stdout is the JSON-RPC stream.
  process.stderr.write(
    `yce-mcp ${pkg.version} | cli=${SKILL.cli} | root=${SKILL.root} | resolved-by=${SKILL.source}\n`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`yce-mcp 启动失败：${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
