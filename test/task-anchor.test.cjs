const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtempSync, rmSync, readdirSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const repoRoot = resolve(__dirname, "..");
// 建卡写在 --cwd 下的 .yce/tasks/，测试用独立 tmp 目录避免污染仓库
const projectDir = mkdtempSync(join(tmpdir(), "yce-task-anchor-"));

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
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      sse(res, "agent4_start", {});
      sse(res, "agent4_chunk", { chunk: "增强提示词正文：\n把登录会话迁到 Redis 的增强正文" });
      sse(res, "plan_complete", {
        plan: {
          goal: "把登录会话迁到 Redis 且旧会话兼容",
          stages: [
            { n: 1, title: "梳理现状", accept: ["列出会话读写点"] },
            { n: 2, title: "落地迁移", accept: ["旧会话可用", "测试通过"] },
          ],
        },
      });
      sse(res, "agent4_complete", { duration_ms: 5 });
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
  rmSync(projectDir, { recursive: true, force: true });
});

function runYce(cliArgs) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["scripts/yce.js", ...cliArgs], {
      cwd: repoRoot,
      env: {
        ...process.env,
        YCE_DISABLE_UPDATE_CHECK: "1",
        YCE_RELAY_URL: baseUrl,
        YCE_RELAY_TOKEN: "fixture-yce-key",
      },
    });
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

let createdCardId = null;

test("enhance 产出任务锚点时自动建卡并输出 task-context", async () => {
  const outcome = await runYce([
    "整理这个登录迁移需求",
    "--mode",
    "enhance",
    "--cwd",
    projectDir,
    "--xml-pretty",
  ]);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /<task-plan>/);
  assert.match(outcome.stdout, /<task-context present="true" created-now="true">/);
  const idMatch = outcome.stdout.match(/<id>(t-\d{8}-[a-z0-9]{6})<\/id>/);
  assert.ok(idMatch, `缺少卡 id: ${outcome.stdout}`);
  createdCardId = idMatch[1];
  assert.match(outcome.stdout, /把登录会话迁到 Redis 且旧会话兼容/);
  // 卡片落盘在项目 .yce/tasks/
  const files = readdirSync(join(projectDir, ".yce", "tasks"));
  assert.deepEqual(files, [`${createdCardId}.json`]);
});

test("task show 无参恢复最近活跃卡（压缩恢复入口）", async () => {
  const outcome = await runYce(["task", "show", "--cwd", projectDir]);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, new RegExp(`<id>${createdCardId}</id>`));
  assert.match(outcome.stdout, /把登录会话迁到 Redis 且旧会话兼容/);
  assert.match(outcome.stdout, /<stage n="2" done="false">/);
});

test("task check 记证据；done 未过验收时列 unmet；补齐后 done 成功", async () => {
  const check1 = await runYce([
    "task", "check", "1",
    "--task", createdCardId,
    "--evidence", "已列出 session.go L10-40 读写点",
    "--cwd", projectDir,
  ]);
  assert.equal(check1.status, 0, check1.stderr);
  assert.match(check1.stdout, /<stage n="1" done="true">/);

  const blocked = await runYce(["task", "done", "--task", createdCardId, "--cwd", projectDir]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /<unmet count="1">/);
  assert.match(blocked.stdout, /ACCEPTANCE_UNMET/);

  const check2 = await runYce([
    "task", "check", "2",
    "--task", createdCardId,
    "--evidence", "迁移完成，回归测试通过",
    "--cwd", projectDir,
  ]);
  assert.equal(check2.status, 0, check2.stderr);

  const done = await runYce(["task", "done", "--task", createdCardId, "--cwd", projectDir]);
  assert.equal(done.status, 0, done.stdout);
  assert.match(done.stdout, /<status>done<\/status>/);
});

test("--task 显式绑定会把锚点注入增强 history", async () => {
  const manual = await runYce([
    "task", "new",
    "--goal", "手动锚点目标",
    "--accept", "判据一",
    "--accept", "判据二",
    "--cwd", projectDir,
  ]);
  assert.equal(manual.status, 0, manual.stderr);
  const manualId = manual.stdout.match(/<id>(t-\d{8}-[a-z0-9]{6})<\/id>/)[1];

  const outcome = await runYce([
    "继续推进迁移",
    "--mode", "enhance",
    "--task", manualId,
    "--history", "User: 之前聊过现状",
    "--cwd", projectDir,
    "--xml-pretty",
  ]);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(
    String(lastRequest.body.conversation_history || ""),
    new RegExp(`任务锚点 ${manualId}.*手动锚点目标`),
  );
  // 绑定已有卡时不重复建卡
  assert.match(outcome.stdout, new RegExp(`<task-context present="true" created-now="false">`));
  assert.match(outcome.stdout, new RegExp(`<id>${manualId}</id>`));
});

test("--no-task 关闭本次簿记：不建卡、不输出活跃卡", async () => {
  const before = readdirSync(join(projectDir, ".yce", "tasks")).length;
  const outcome = await runYce([
    "再来一次增强",
    "--mode", "enhance",
    "--no-task",
    "--cwd", projectDir,
    "--xml-pretty",
  ]);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /<task-context present="false"\/>/);
  assert.equal(readdirSync(join(projectDir, ".yce", "tasks")).length, before);
});

test("task 子命令处理含引号与换行的结构化参数", async () => {
  const outcome = await runYce([
    "task", "new",
    "--goal", '带 "引号" 的目标\n以及换行 && <标签>',
    "--accept", '判据含 "引号"',
    "--cwd", projectDir,
  ]);
  assert.equal(outcome.status, 0, outcome.stderr);
  const id = outcome.stdout.match(/<id>(t-\d{8}-[a-z0-9]{6})<\/id>/)[1];
  const shown = await runYce(["task", "show", id, "--cwd", projectDir]);
  assert.match(shown.stdout, /带 "引号" 的目标\n以及换行 && <标签>/);
  assert.match(shown.stdout, /判据含 "引号"/);
});
