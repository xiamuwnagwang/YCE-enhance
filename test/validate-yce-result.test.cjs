const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const validator = join(repoRoot, "scripts", "validate-yce-result.mjs");
const fixtures = join(repoRoot, "test", "fixtures", "yce-results");

function run(file) {
  return spawnSync(process.execPath, [validator, join(fixtures, file)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function summary(file) {
  const result = run(file);
  assert.ok(result.stdout, result.stderr);
  return { status: result.status, payload: JSON.parse(result.stdout) };
}

test("正常 search result-present=true", () => {
  const { status, payload } = summary("search-present.xml");
  assert.equal(status, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.search.result_present, true);
  assert.equal(payload.gate.may_analyze_or_edit_code, true);
});

test("success=true 但 result-present=false", () => {
  const { status, payload } = summary("success-without-result.xml");
  assert.equal(status, 3);
  assert.equal(payload.success, true);
  assert.equal(payload.search.result_present, false);
  assert.equal(payload.ok, false);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
});

test("auto 增强失败后仍执行 search", () => {
  const { status, payload } = summary("auto-enhance-fail-then-search.xml");
  assert.equal(status, 0);
  assert.equal(payload.resolved_action, "enhance_then_search");
  assert.equal(payload.enhanced.success, false);
  assert.equal(payload.search.result_present, true);
  assert.equal(payload.errors[0].code, "EXEC_ERROR");
});

test("XML 解析失败", () => {
  const { status, payload } = summary("parse-fail.xml");
  assert.equal(status, 2);
  assert.equal(payload.complete, false);
  assert.equal(payload.parse_ok, false);
});

test("截断输出不得判为完整", () => {
  const { status, payload } = summary("truncated.xml");
  assert.equal(status, 2);
  assert.equal(payload.complete, false);
  assert.equal(payload.truncation_detected, true);
  assert.equal(payload.ok, false);
});

test("search 成功但 errors 非空仍可通过闸门", () => {
  const { status, payload } = summary("search-with-errors.xml");
  assert.equal(status, 0);
  assert.equal(payload.search.result_present, true);
  assert.equal(payload.errors.length, 1);
  assert.equal(payload.ok, true);
});

test("task-context 新建", () => {
  const { status, payload } = summary("task-context-new.xml");
  assert.equal(status, 0);
  assert.equal(payload.task_context.present, true);
  assert.equal(payload.task_context.created_now, true);
  assert.equal(payload.task_context.id, "t-20260814-ab12cd");
});

test("task-context 已有复述", () => {
  const { status, payload } = summary("task-context-existing.xml");
  assert.equal(status, 0);
  assert.equal(payload.task_context.present, true);
  assert.equal(payload.task_context.created_now, false);
  assert.equal(payload.task_context.id, "t-20260814-ab12cd");
});
