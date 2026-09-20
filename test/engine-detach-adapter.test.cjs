"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { runYceEngineSearch } = require("../scripts/lib/adapters/yceEngineSearch");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yce-engine-detach-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target.js");
  const engine = join(root, "fake-engine.cjs");
  writeFileSync(target, "export const target = true;\n");
  writeFileSync(engine, [
    'if (process.env.FAKE_ENGINE_MODE === "error") { console.error("fixture engine failed"); process.exit(2); }',
    `console.log(JSON.stringify({ success: true, output: "ok", result_present: true, empty_result: false, files: [{ path: ${JSON.stringify(target)}, ranges: [[1, 1]] }], grep_patterns: ["target"], diagnostics: { source: "fake" }, error: null }));`,
    "setTimeout(() => {}, Number(process.env.FAKE_ENGINE_TAIL_MS || 0));",
  ].join("\n"));
  return { root, engine };
}

function run(root, engine, env = {}) {
  return runYceEngineSearch({
    query: "locate target",
    cwd: root,
    scriptPath: engine,
    timeoutMs: 5000,
    maxResults: 5,
    maxTurns: 1,
    maxCommands: 2,
    treeDepth: 1,
    codeContextEnabled: false,
    env: { YCE_SEARCH_CACHE: "off", ...env },
  });
}

test("a detached engine run is a success with exit_code 0 and the detach diagnostic", async (t) => {
  const { root, engine } = fixture(t);
  const result = await run(root, engine, { FAKE_ENGINE_TAIL_MS: "3000" });
  assert.equal(result.search.success, true);
  assert.equal(result.search.result_present, true);
  assert.equal(result.search.exit_code, 0);
  assert.equal(result.search.diagnostics.usage_flush_detached, true);
  assert.ok(result.durationMs < 2000);
});

test("YCE_DEFER_USAGE_FLUSH=0 waits for the child and reports its real exit code", async (t) => {
  const { root, engine } = fixture(t);
  const result = await run(root, engine, {
    FAKE_ENGINE_TAIL_MS: "400",
    YCE_DEFER_USAGE_FLUSH: "0",
  });
  assert.equal(result.search.exit_code, 0);
  assert.equal(result.search.diagnostics.usage_flush_detached, undefined);
  assert.ok(result.durationMs >= 400);
});

test("the cached blob never records the detach marker", async (t) => {
  const { root, engine } = fixture(t);
  const cacheDir = mkdtempSync(join(tmpdir(), "yce-engine-detach-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const env = { YCE_SEARCH_CACHE: "true", YCE_SEARCH_CACHE_DIR: cacheDir, FAKE_ENGINE_TAIL_MS: "3000" };
  const first = await runYceEngineSearch({
    query: "locate target",
    cwd: root,
    scriptPath: engine,
    timeoutMs: 5000,
    maxResults: 5,
    maxTurns: 1,
    maxCommands: 2,
    treeDepth: 1,
    codeContextEnabled: false,
    env,
  });
  const second = await runYceEngineSearch({
    query: "locate target",
    cwd: root,
    scriptPath: engine,
    timeoutMs: 5000,
    maxResults: 5,
    maxTurns: 1,
    maxCommands: 2,
    treeDepth: 1,
    codeContextEnabled: false,
    env,
  });
  assert.equal(first.search.diagnostics.usage_flush_detached, true);
  assert.equal(first.search.diagnostics.cache_hit, false);
  assert.equal(second.search.diagnostics.cache_hit, true);
  assert.equal(second.search.diagnostics.usage_flush_detached, undefined);
});

test("an engine that crashes before printing JSON is unchanged", async (t) => {
  const { root, engine } = fixture(t);
  const result = await run(root, engine, { FAKE_ENGINE_MODE: "error" });
  assert.equal(result.error.code, "EXEC_ERROR");
  assert.equal(result.search.exit_code, 2);
});
