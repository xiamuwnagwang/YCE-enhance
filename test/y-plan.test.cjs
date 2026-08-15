const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { runYPlan } = require("../scripts/lib/adapters/yPlan");

const repoRoot = resolve(__dirname, "..");
const fixtureDir = mkdtempSync(join(tmpdir(), "yce-y-plan-"));
const engineScript = join(fixtureDir, "fake-yce-engine.js");

writeFileSync(
  engineScript,
  [
    "const queryIndex = process.argv.indexOf('--query');",
    "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
    "const output = `Found 1 relevant files.\\n\\nPath: src/fixture.js (L1-5)`;",
    "if (process.argv.includes('--json')) {",
    "  console.log(JSON.stringify({ success: true, output, result_present: true, empty_result: false, files: [{ path: 'src/fixture.js', ranges: [[1, 5]] }], grep_patterns: ['fixture'], diagnostics: {}, error: null }));",
    "} else {",
    "  console.log(output);",
    "}",
  ].join("\n")
);

let server;
let baseUrl;
let lastRequest = null;

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      lastRequest = { url: req.url, headers: req.headers, body };

      if (req.url !== "/yce/y-plan") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const auth = String(req.headers.authorization || "");
      if (auth !== "Bearer fixture-yce-key") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "未授权", code: "UNAUTHORIZED" }));
        return;
      }
      const task = String(body.task || "");
      if (task.includes("quota-case")) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "y-plan quota reached", code: "Y_PLAN_DAILY_QUOTA_EXCEEDED" }));
        return;
      }
      if (task.includes("disabled-case")) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "y-plan is disabled", code: "Y_PLAN_DISABLED" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      if (task.includes("error-case")) {
        sse(res, "chunk", { chunk: "partial " });
        sse(res, "error", { error: "Y-Plan 规划失败，请稍后重试" });
        res.end();
        return;
      }
      if (body.enable_web_search !== false) {
        sse(res, "search_complete", { results: 3 });
      }
      sse(res, "chunk", { chunk: "## Plan\n" });
      sse(res, "chunk", { chunk: "1. do things" });
      const planParts = ["## Plan\n1. do things"];
      if (typeof body.search_context === "string" && body.search_context) {
        planParts.push(`[ctx:${body.search_context.slice(0, 40)}]`);
      }
      if (body.config && body.config.model) {
        planParts.push(`[model:${body.config.model}]`);
      }
      sse(res, "complete", { plan: planParts.join("\n") });
      res.end();
    });
  });
  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("runYPlan returns the final plan and marks web search usage", async () => {
  const { plan, error } = await runYPlan({
    task: "Plan the leaderboard revamp",
    history: "User: context",
    relayUrl: baseUrl,
    relayToken: "fixture-yce-key",
    timeoutMs: 5000,
  });
  assert.equal(error, null);
  assert.equal(plan.success, true);
  assert.equal(plan.result_present, true);
  assert.equal(plan.search_used, true);
  assert.match(plan.plan, /## Plan/);
  assert.equal(lastRequest.body.conversation_history, "User: context");
  assert.equal(lastRequest.body.request_id, plan.request_id);
});

test("runYPlan forwards search context and custom provider config", async () => {
  const { plan, error } = await runYPlan({
    task: "Plan with grounded context",
    searchContext: "Path: src/app.ts (L10-20)",
    enableWebSearch: false,
    language: "zh-CN",
    relayUrl: baseUrl,
    relayToken: "fixture-yce-key",
    timeoutMs: 5000,
    customProvider: {
      provider: "openai",
      baseUrl: "https://example.com/v1",
      token: "byok-token",
      model: "gpt-fixture",
    },
  });
  assert.equal(error, null);
  assert.equal(plan.success, true);
  assert.equal(plan.search_used, false);
  assert.equal(plan.custom_model, true);
  assert.match(plan.plan, /\[ctx:Path: src\/app\.ts/);
  assert.match(plan.plan, /\[model:gpt-fixture\]/);
  assert.equal(lastRequest.body.enable_web_search, false);
  assert.equal(lastRequest.body.language, "zh-CN");
  assert.equal(lastRequest.body.config.provider, "openai");
});

test("runYPlan surfaces relay errors and keeps partial output", async () => {
  const { plan, error } = await runYPlan({
    task: "error-case task",
    relayUrl: baseUrl,
    relayToken: "fixture-yce-key",
    timeoutMs: 5000,
  });
  assert.equal(plan.success, false);
  assert.equal(plan.result_present, false);
  assert.equal(plan.plan, "partial ");
  assert.equal(error.source, "y-plan");
  assert.equal(error.code, "EXEC_ERROR");
});

test("runYPlan maps auth, quota, and disabled failures", async () => {
  const unauthorized = await runYPlan({
    task: "any",
    relayUrl: baseUrl,
    relayToken: "wrong-key",
    timeoutMs: 5000,
  });
  assert.equal(unauthorized.error.code, "AUTH_ERROR");

  const quota = await runYPlan({
    task: "quota-case",
    relayUrl: baseUrl,
    relayToken: "fixture-yce-key",
    timeoutMs: 5000,
  });
  assert.equal(quota.error.code, "QUOTA_EXCEEDED");

  const disabled = await runYPlan({
    task: "disabled-case",
    relayUrl: baseUrl,
    relayToken: "fixture-yce-key",
    timeoutMs: 5000,
  });
  assert.equal(disabled.error.code, "DISABLED");

  const missingToken = await runYPlan({
    task: "any",
    relayUrl: baseUrl,
    relayToken: "",
    timeoutMs: 5000,
  });
  assert.equal(missingToken.error.code, "AUTH_ERROR");
});

// CLI 端到端测试必须用异步 spawn：进程内的 fixture relay 服务器
// 依赖本进程事件循环响应请求，spawnSync 会阻塞事件循环造成死锁。
function runCli(query, extraArgs = [], envOverrides = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      // 断言 XML 内容，故走 --stdout-xml；默认收据通道见 result-receipt 测试。
      ["scripts/yce.js", query, "--mode", "plan", "--cwd", repoRoot, "--xml-pretty", "--stdout-xml", ...extraArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          YCE_DISABLE_UPDATE_CHECK: "1",
          YCE_ENGINE_SCRIPT: engineScript,
          YCE_RELAY_URL: baseUrl,
          YCE_RELAY_TOKEN: "fixture-yce-key",
          ...envOverrides,
        },
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

test("CLI plan mode emits a y-plan XML block", async () => {
  const outcome = await runCli("Plan the checkout flow refactor");
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /<mode>plan<\/mode>/);
  assert.match(outcome.stdout, /<resolved-action>plan<\/resolved-action>/);
  assert.match(outcome.stdout, /<y-plan executed="true" success="true" result-present="true">/);
  assert.match(outcome.stdout, /## Plan/);
});

test("CLI plan mode with --with-search grounds the plan in code search", async () => {
  const outcome = await runCli("Plan the checkout flow refactor", ["--with-search"]);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /<resolved-action>search_then_plan<\/resolved-action>/);
  assert.match(outcome.stdout, /<search executed="true" success="true" result-present="true"/);
  // 计划正文里应回显 search_context（fixture 会拼接 [ctx:...]）
  assert.match(outcome.stdout, /\[ctx:/);
});

test("CLI plan mode rejects an invalid language", async () => {
  const outcome = await runCli("Plan anything", ["--language", "fr-FR"]);
  assert.equal(outcome.status, 1);
  assert.match(outcome.stdout, /language must be zh-CN or en-US/);
});

test("CLI plan mode saves the plan to disk with --save", async () => {
  const saveDir = join(fixtureDir, "plans");
  const outcome = await runCli("Save the checkout plan", ["--save", saveDir]);
  assert.equal(outcome.status, 0, outcome.stderr);
  const savedPath = outcome.stdout.match(/<saved-path><!\[CDATA\[([\s\S]*?)\]\]><\/saved-path>/)?.[1];
  assert.ok(savedPath, `缺少 saved-path: ${outcome.stdout}`);
  assert.match(savedPath, /y-plan-save-the-checkout-plan-\d{8}-\d{6}\.md$/);
  const { readFileSync } = require("node:fs");
  const content = readFileSync(savedPath, "utf8");
  assert.match(content, /^---\ntask: "Save the checkout plan"/);
  assert.match(content, /## Plan/);
});

test("runYPlan 落盘辅助函数支持显式 .md 路径", () => {
  const { savePlanToFile } = require("../scripts/lib/adapters/yPlan");
  const target = join(fixtureDir, "explicit", "my-plan.md");
  const saved = savePlanToFile({
    plan: "# Y-Plan\ncontent",
    task: "explicit path",
    savePath: target,
    cwd: fixtureDir,
  });
  assert.equal(saved, target);
  const { readFileSync } = require("node:fs");
  assert.match(readFileSync(saved, "utf8"), /# Y-Plan/);
});
