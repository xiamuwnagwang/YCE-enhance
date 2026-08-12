const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");

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
      lastRequest = { url: req.url, body };

      if (req.url === "/yce/prompt-enhance/direct") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enhancedPrompt: `direct:${body.prompt}` }));
        return;
      }

      if (req.url !== "/yce/prompt-enhance/agent") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      const prompt = String(body.prompt || "");
      sse(res, "agent1_complete", { duration_ms: 5 });
      sse(res, "agent4_start", {});
      if (prompt.includes("event-plan-case")) {
        // 后端已升级：正文干净，plan 走 plan_complete 事件
        sse(res, "agent4_chunk", { chunk: "增强提示词正文：\n干净正文" });
        sse(res, "plan_complete", {
          plan: {
            goal: "把登录会话迁到 Redis",
            stages: [{ n: 1, title: "梳理现状", accept: ["列出会话读写点"] }],
          },
        });
      } else if (prompt.includes("inline-plan-case")) {
        // 后端未升级：<plan> 锚点留在正文开头，客户端要兜底剥离
        sse(res, "agent4_chunk", {
          chunk:
            "<plan>\n<g>内联目标</g>\n<stage>\n<t>阶段一</t>\n<d>判据 A</d>\n<d>判据 B</d>\n</stage>\n</plan>\n增强提示词正文：\n兜底正文",
        });
      } else {
        sse(res, "agent4_chunk", { chunk: "增强提示词正文：\n普通正文" });
      }
      sse(res, "agent4_complete", { duration_ms: 9 });
      sse(res, "pipeline_complete", { token_usage: null });
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
});

function runEnhanceCli(prompt, extraArgs = []) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ["scripts/prompt-enhance.js", "enhance", prompt, "--auto-confirm", ...extraArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          YCE_RELAY_URL: baseUrl,
          YCE_RELAY_TOKEN: "fixture-yce-key",
          YCE_PROMPT_ENHANCE_MODE: "agent",
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

test("agent 增强透传 plan_complete 事件为 <task-plan> 块", async () => {
  const outcome = await runEnhanceCli("event-plan-case 优化登录");
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /<enhanced>/);
  assert.match(outcome.stdout, /<task-plan>/);
  const planJson = outcome.stdout.match(/<task-plan>\s*([\s\S]*?)\s*<\/task-plan>/)[1];
  const plan = JSON.parse(planJson);
  assert.equal(plan.goal, "把登录会话迁到 Redis");
  assert.equal(plan.stages[0].accept[0], "列出会话读写点");
  // 请求应带 request_id（幂等契约）
  assert.match(String(lastRequest.body.request_id || ""), /^[0-9a-f-]{36}$/);
});

test("后端未升级时从正文兜底剥离 <plan> 锚点", async () => {
  const outcome = await runEnhanceCli("inline-plan-case 优化登录");
  assert.equal(outcome.status, 0, outcome.stderr);
  // 正文无 <plan> 标签残留
  const enhancedBody = outcome.stdout.match(/<enhanced>\s*([\s\S]*?)\s*<\/enhanced>/)[1];
  assert.ok(!enhancedBody.includes("<plan>"), `正文仍含 <plan>: ${enhancedBody}`);
  assert.match(enhancedBody, /兜底正文/);
  // plan 从正文解析出来
  const plan = JSON.parse(outcome.stdout.match(/<task-plan>\s*([\s\S]*?)\s*<\/task-plan>/)[1]);
  assert.equal(plan.goal, "内联目标");
  assert.deepEqual(plan.stages[0].accept, ["判据 A", "判据 B"]);
});

test("无 plan 时不输出 <task-plan> 块", async () => {
  const outcome = await runEnhanceCli("普通增强");
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.ok(!outcome.stdout.includes("<task-plan>"));
});

test("direct 模式走 JSON 快路径并支持 language", async () => {
  const outcome = await runEnhanceCli("快速整理需求", ["--mode", "direct", "--language", "zh-CN"]);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /<enhanced>/);
  assert.match(outcome.stdout, /direct:快速整理需求/);
  assert.equal(lastRequest.url, "/yce/prompt-enhance/direct");
  assert.equal(lastRequest.body.language, "zh-CN");
  assert.match(String(lastRequest.body.request_id || ""), /^[0-9a-f-]{36}$/);
});
