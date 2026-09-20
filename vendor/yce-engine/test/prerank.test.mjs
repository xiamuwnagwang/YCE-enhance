import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scoreFiles, selectProbePatternTerms } from "../lib/directory-scorer.mjs";
import { isCjkToken } from "../lib/lexicon.cjs";
import { screenCandidates } from "../lib/jevScreen.mjs";
import { __test as coreTest } from "../lib/core.mjs";

test("file preranker fuses lexical, structure, and probe signals", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "lease_scheduler.go"), [
    "package internal",
    "",
    "// LeaseScheduler selects a key from the pool for the next upstream request.",
    "func SelectUpstreamKey(pool []string) string { return pool[0] }",
  ].join("\n"));
  writeFileSync(join(root, "internal", "unrelated.go"), [
    "package internal",
    "func RenderHealth() string { return \"ok\" }",
  ].join("\n"));

  const result = scoreFiles("select upstream key from lease pool", root, ["internal"], [], { maxResults: 1 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].path, "internal/lease_scheduler.go");
  assert.ok(result.candidates[0].ranges.length > 0);
  assert.ok(result.rgPatterns.includes("select"));
  assert.equal(result.lowConfidence, false);
});

test("Jev screen sends one batched choice request and maps probabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "yce-jev-screen-"));
  try {
    writeFileSync(join(root, "scheduler.go"), "package main\nfunc SelectKey() string { return \"key\" }\n");
    writeFileSync(join(root, "health.go"), "package main\nfunc Health() string { return \"ok\" }\n");
    let captured = null;
    const result = await screenCandidates({
      query: "choose an upstream key",
      projectRoot: root,
      candidates: [{ path: "scheduler.go" }, { path: "health.go" }],
      apiKey: "fixture-typesafe-key",
      fetchImpl: async (url, options) => {
        captured = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({
          model: "jev-latest",
          answers: { pick: { type: "choice", probabilities: { file_0: 0.91, file_1: 0.03 }, confidence: 0.91 } },
          usage: { input_tokens: 123, output_tokens: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.candidates[0].path, "scheduler.go");
    assert.equal(result.inputTokens, 123);
    assert.equal(captured.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(captured.options.headers.Authorization, "Bearer fixture-typesafe-key");
    assert.equal(captured.body.model, "jev-latest");
    assert.equal(captured.body.questions.pick.type, "choice");
    assert.equal(Object.keys(captured.body.questions.pick.criteria).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Jev screen failures are returned as optional diagnostics", async () => {
  const result = await screenCandidates({
    query: "any query",
    projectRoot: tmpdir(),
    candidates: [],
    apiKey: "",
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "missing_api_key");
});

test("Jev HTTP failures degrade without throwing", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-jev-http-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "candidate.go"), "package main\nfunc Candidate() {}\n");
  const result = await screenCandidates({
    query: "any query",
    projectRoot: root,
    candidates: [{ path: "candidate.go" }],
    apiKey: "fixture-typesafe-key",
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.reason, "http_401");
});

test("local bootstrap returns prompt hints without a remote bootstrap call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-local-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "scheduler.go"), "package internal\nfunc SelectKey() string { return \"key\" }\n");

  const result = await coreTest.runLocalBootstrapPhase({
    query: "select upstream key",
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    noJevScreen: true,
  });
  assert.equal(result.source, "local");
  assert.equal(result.remoteCalls, 0);
  assert.ok(result.candidates.some((candidate) => candidate.path === "internal/scheduler.go"));
  assert.match(coreTest.formatLocalPrerankCandidates(result.candidates), /Local Prerank Verification Leads/);
});

test("local answers correct a one-character path typo only against existing candidates", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-path-correction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "lease_scheduler.go"), "package internal\n");
  assert.equal(
    coreTest.correctLocalCandidatePath(
      "internal/lease_cheduler.go",
      root,
      [{ path: "internal/lease_scheduler.go" }],
    ),
    "internal/lease_scheduler.go",
  );
  assert.equal(
    coreTest.correctLocalCandidatePath("internal/missing.go", root, [{ path: "internal/lease_scheduler.go" }]),
    "internal/missing.go",
  );
});

test("candidate injection filters missing paths and answer parsing records validation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-path-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "lease_scheduler.go"), "package internal\n");

  const formatted = coreTest.formatLocalPrerankCandidates([
    { path: "internal/lease_scheduler.go", ranges: [[1, 1]] },
    { path: "internal/not_present.go", ranges: [[1, 1]] },
  ], 20, root);
  assert.match(formatted, /internal\/lease_scheduler\.go/);
  assert.doesNotMatch(formatted, /not_present\.go/);

  const parsed = coreTest.parseAnswer([
    "<ANSWER>",
    '  <file path="/codebase/internal/lease_cheduler.go"><range>1-2</range></file>',
    '  <file path="/codebase/internal/not_present.go"><range>1-2</range></file>',
    "</ANSWER>",
  ].join("\n"), root, [{ path: "internal/lease_scheduler.go" }]);
  assert.deepEqual(parsed.files.map((entry) => entry.path), ["internal/lease_scheduler.go"]);
  assert.deepEqual(parsed.pathValidation.corrected, [{
    from: "internal/lease_cheduler.go",
    to: "internal/lease_scheduler.go",
  }]);
  assert.deepEqual(parsed.pathValidation.removed, ["internal/not_present.go"]);

  const remoteCompatible = coreTest.parseAnswer(
    '<ANSWER><file path="/codebase/internal/not_present.go"><range>1-2</range></file></ANSWER>',
    root,
    [],
    false,
  );
  assert.deepEqual(remoteCompatible.files.map((entry) => entry.path), ["internal/not_present.go"]);
});

test("answer parsing drops inverted or zero-based ranges and counts them", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-answer-ranges-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "db.ts"), "export const x = 1;\n");

  // Seen in production on 2026-09-20: `15851-1600` for what was meant as 1585-1600.
  const parsed = coreTest.parseAnswer([
    "<ANSWER>",
    '  <file path="/codebase/lib/db.ts"><range>15851-1600</range><range>0-5</range><range>10650-10660</range></file>',
    "</ANSWER>",
  ].join("\n"), root, [{ path: "lib/db.ts" }]);
  assert.deepEqual(parsed.files.map((entry) => entry.path), ["lib/db.ts"]);
  assert.deepEqual(parsed.files[0].ranges, [[10650, 10660]]);
  assert.equal(parsed.pathValidation.invalidRanges, 2);

  // A file whose every range is invalid stays in the answer with no ranges.
  const allInvalid = coreTest.parseAnswer(
    '<ANSWER><file path="/codebase/lib/db.ts"><range>9-3</range></file></ANSWER>',
    root,
    [{ path: "lib/db.ts" }],
  );
  assert.deepEqual(allInvalid.files[0].ranges, []);
  assert.equal(allInvalid.pathValidation.invalidRanges, 1);

  // The remote-compatible path applies the same rule.
  const remote = coreTest.parseAnswer(
    '<ANSWER><file path="/codebase/lib/db.ts"><range>5-1</range><range>1-5</range></file></ANSWER>',
    root,
    [],
    false,
  );
  assert.deepEqual(remote.files[0].ranges, [[1, 5]]);
  assert.equal(remote.pathValidation.invalidRanges, 1);
});

test("answer parsing folds repeated paths into one entry with merged ranges", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-answer-dedup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "lease_scheduler.go"), "package internal\n");
  writeFileSync(join(root, "internal", "lease.go"), "package internal\n");

  const parsed = coreTest.parseAnswer([
    "<ANSWER>",
    '  <file path="/codebase/internal/lease_scheduler.go"><range>1-20</range></file>',
    '  <file path="/codebase/internal/lease.go"><range>5-9</range></file>',
    '  <file path="/codebase/internal/lease_scheduler.go"><range>40-60</range><range>1-20</range></file>',
    "</ANSWER>",
  ].join("\n"), root, [{ path: "internal/lease_scheduler.go" }, { path: "internal/lease.go" }]);

  assert.deepEqual(
    parsed.files.map((entry) => entry.path),
    ["internal/lease_scheduler.go", "internal/lease.go"],
  );
  assert.deepEqual(parsed.files[0].ranges, [[1, 20], [40, 60]]);
  assert.deepEqual(parsed.pathValidation.merged, ["internal/lease_scheduler.go"]);
  assert.deepEqual(parsed.pathValidation.removed, []);
});

test("answer parsing dedupes after a path typo is corrected onto an existing file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-answer-dedup-typo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "lease_scheduler.go"), "package internal\n");

  const parsed = coreTest.parseAnswer([
    "<ANSWER>",
    '  <file path="/codebase/internal/lease_scheduler.go"><range>1-20</range></file>',
    '  <file path="/codebase/internal/lease_cheduler.go"><range>30-40</range></file>',
    "</ANSWER>",
  ].join("\n"), root, [{ path: "internal/lease_scheduler.go" }]);

  assert.deepEqual(parsed.files.map((entry) => entry.path), ["internal/lease_scheduler.go"]);
  assert.deepEqual(parsed.files[0].ranges, [[1, 20], [30, 40]]);
});

test("remote-compatible answer parsing also keeps one entry per path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-answer-dedup-remote-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parsed = coreTest.parseAnswer([
    '<file path="/codebase/internal/absent.go"><range>1-2</range></file>',
    '<file path="/codebase/internal/absent.go"><range>7-8</range></file>',
  ].join("\n"), root, [], false);
  assert.deepEqual(parsed.files.map((entry) => entry.path), ["internal/absent.go"]);
  assert.deepEqual(parsed.files[0].ranges, [[1, 2], [7, 8]]);
});

test("tool-call parser repairs a missing opening quote on an object key", () => {
  const parsed = coreTest.parseToolCall(
    '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"route",path":"/codebase","exclude":[]}}',
  );
  assert.ok(parsed);
  assert.equal(parsed[1], "restricted_exec");
  assert.equal(parsed[2].command1.path, "/codebase");
  assert.deepEqual(parsed[2].command1.exclude, []);
});

test("tool-call parser repairs a bare simple string argument", () => {
  const parsed = coreTest.parseToolCall(
    '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":networkSearchPath,"path":"/codebase","exclude":[]}}',
  );
  assert.ok(parsed);
  assert.equal(parsed[2].command1.pattern, "networkSearchPath");
});

test("file prerank demotes test files below the source they exercise", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "pool.go"), [
    "package internal",
    "// SelectUpstreamKey picks a key from the lease pool.",
    "func SelectUpstreamKey(pool []string) string { return pool[0] }",
  ].join("\n"));
  // Repeats every query term more often than the implementation does, so on raw
  // signal alone this file outranks it — that is exactly the crowding the
  // penalty exists to undo.
  writeFileSync(join(root, "internal", "pool_test.go"), [
    "package internal",
    "// covers SelectUpstreamKey: select upstream key from the lease pool",
    "func TestSelectUpstreamKey(t *testing.T) { SelectUpstreamKey(nil) }",
    "func TestSelectUpstreamKeyEmptyPool(t *testing.T) { SelectUpstreamKey(nil) }",
    "func TestSelectUpstreamKeyLeasePool(t *testing.T) { SelectUpstreamKey(nil) }",
  ].join("\n"));

  const result = scoreFiles("select upstream key from lease pool", root, ["internal"], [], { maxResults: 5 });
  const paths = result.candidatePool.map((candidate) => candidate.path);
  assert.deepEqual(paths, ["internal/pool.go", "internal/pool_test.go"]);
});

test("declaration extraction keeps function-valued bindings and drops plain values", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-declarations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "selector.js"), [
    "const RETRY_LIMIT = 42;",
    "const upstreamSelector = () => selectUpstreamKey();",
    "export const selectUpstreamKey = function (pool) { return pool[0]; };",
    "var leasePoolMessage = \"pool is empty\";",
    "function selectLeasePool(keys) { return keys; }",
    "class LeasePoolSelector {}",
  ].join("\n"));

  const result = scoreFiles("select upstream key from lease pool", root, ["internal"], [], { maxResults: 5 });
  const names = result.candidatePool[0].declarationNames;
  assert.ok(names.includes("selectUpstreamKey"), "a const bound to a function expression is a declaration");
  assert.ok(names.includes("upstreamSelector"), "a const bound to an arrow function is a declaration");
  assert.ok(names.includes("selectLeasePool"), "a plain function declaration is a declaration");
  assert.ok(names.includes("LeasePoolSelector"), "a class declaration is a declaration");
  assert.ok(!names.includes("RETRY_LIMIT"), "a const bound to a number is not a declaration");
  assert.ok(!names.includes("leasePoolMessage"), "a var bound to a string is not a declaration");
  // Only query-relevant names become grep patterns; a repo-wide word like
  // "message" would cost a remote turn and match everything.
  assert.ok(!result.rgPatterns.includes("leasePoolMessage"));
});

test("declaration slots go to the names that overlap the query, not to file order", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-declaration-slots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  // 20 unrelated declarations first: in file order they would use up every one
  // of the 16 slots before the function the query is about is ever reached.
  const filler = Array.from({ length: 20 }, (_, index) => `function helper${index}() {}`);
  writeFileSync(join(root, "internal", "late.js"), [
    ...filler,
    "function selectUpstreamKeyFromLeasePool(pool) { return pool[0]; }",
  ].join("\n"));

  const result = scoreFiles("select upstream key from lease pool", root, ["internal"], [], { maxResults: 5 });
  const names = result.candidatePool[0].declarationNames;
  assert.equal(names.length, 16);
  assert.equal(names[0], "selectUpstreamKeyFromLeasePool");
});

test("candidates carry the matched probe lines so the screen needs no second read", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-candidate-snippet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "pool.go"), [
    "package internal",
    "",
    "func SelectUpstreamKey(pool []string) string { return pool[0] }",
  ].join("\n"));

  const candidate = scoreFiles("select upstream key", root, ["internal"], [], { maxResults: 5 }).candidatePool[0];
  assert.ok(candidate.snippet.length > 0);
  assert.ok(candidate.snippet.length <= 3);
  assert.ok(candidate.snippet.every((entry) => Number.isInteger(entry.line) && entry.line > 0));
  assert.ok(candidate.snippet.some((entry) => entry.text.includes("SelectUpstreamKey")));
});

test("the Jev screen input is built from declarations and matched lines, never from imports", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-jev-criteria-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Present on disk, and deliberately import-heavy: if the screen still read
  // files, those imports would be the whole skeleton.
  writeFileSync(join(root, "scheduler.js"), [
    "import { readFileSync } from \"node:fs\";",
    "import { resolve } from \"node:path\";",
    "export function selectUpstreamKey(pool) { return pool[0]; }",
  ].join("\n"));

  let captured = null;
  await screenCandidates({
    query: "select upstream key",
    projectRoot: root,
    candidates: [{
      path: "scheduler.js",
      declarationNames: ["selectUpstreamKey"],
      snippet: [{ line: 3, text: "export function selectUpstreamKey(pool) { return pool[0]; }" }],
    }],
    apiKey: "fixture-typesafe-key",
    fetchImpl: async (url, options) => {
      captured = JSON.parse(options.body);
      return new Response(JSON.stringify({
        answers: { pick: { type: "choice", probabilities: { file_0: 0.9 } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const criterion = captured.questions.pick.criteria.file_0;
  assert.match(criterion, /^scheduler\.js:/);
  assert.match(criterion, /declares: selectUpstreamKey/);
  assert.match(criterion, /L3: export function selectUpstreamKey/);
  assert.doesNotMatch(criterion, /^\s*import\b/m, "import lines must not reach the screen");
  assert.doesNotMatch(criterion, /node:fs/);
});

test("the test-file penalty leaves vendored code alone", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-vendor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "vendor"));
  mkdirSync(join(root, "internal"));
  const body = [
    "package pool",
    "// covers SelectUpstreamKey: select upstream key from the lease pool",
    "func SelectUpstreamKey(pool []string) string { return pool[0] }",
  ].join("\n");
  writeFileSync(join(root, "vendor", "pool.go"), body);
  writeFileSync(join(root, "internal", "pool_test.go"), body);

  const result = scoreFiles("select upstream key from lease pool", root, ["vendor", "internal"], [], { maxResults: 5 });
  const paths = result.candidatePool.map((candidate) => candidate.path);
  // Identical content, so only the path class can separate them: whether a
  // directory like vendor/, examples/ or migrations/ is noise is repo-specific,
  // and demoting it at file level measurably hurt. Only tests are demoted.
  assert.ok(paths.indexOf("vendor/pool.go") < paths.indexOf("internal/pool_test.go"));
});

test("a Chinese query ranks the file whose comment matches above an unrelated one", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-cjk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  const matching = [
    "package internal",
    "",
    "// 缓存失效 时清空 key 池快照。",
    "func ResetSnapshot() {}",
  ].join("\n");
  const unrelated = "package internal\n// 渲染健康检查页面。\nfunc RenderHealth() string { return \"ok\" }";
  writeFileSync(join(root, "internal", "cache_invalidation.go"), matching);
  writeFileSync(join(root, "internal", "unrelated.go"), unrelated);

  const result = scoreFiles("缓存失效", root, ["internal"], [], { maxResults: 5 });
  assert.equal(result.candidatePool[0].path, "internal/cache_invalidation.go");
  assert.equal(result.lexicalHits, 1);
  assert.ok(result.candidatePool[0].lexicalScore > 0);
  assert.ok(result.candidatePool[0].probeScore > 0);
  assert.deepEqual(result.candidatePool[0].ranges, [[3, 3]]);
  assert.ok(result.rgPatterns.includes("缓存失效"));
  assert.ok(result.rgPatterns.every((pattern) => matching.includes(pattern)));
});

test("an English-only corpus leaves a Chinese query at zero lexical hits and low confidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-cjk-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "pool.go"), "package internal\nfunc SelectPool() {}\n");
  const result = scoreFiles("缓存失效", root, ["internal"], [], { maxResults: 5 });
  assert.equal(result.lexicalHits, 0);
  assert.equal(result.lowConfidence, true);
  assert.equal(result.semanticGap, true);
  assert.deepEqual(result.rgPatterns, []);
  assert.ok(result.queryTerms.length > 0);
});

test("a Chinese query still reaches a directory whose path spine cannot match", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-cjk-large-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "app"));
  for (let index = 0; index < 201; index += 1) {
    writeFileSync(join(root, "app", `mod_${index}.ts`), `export const value${index} = ${index};\n`);
  }
  writeFileSync(join(root, "app", "target.ts"), "// 缓存失效 时清空快照\nexport function resetSnapshot() {}\n");

  const previous = process.env.YCE_PRERANK_INDEX;
  process.env.YCE_PRERANK_INDEX = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.YCE_PRERANK_INDEX;
    else process.env.YCE_PRERANK_INDEX = previous;
  });
  const result = scoreFiles("缓存失效", root, ["app"], [], { maxResults: 5 });
  assert.ok(result.candidatePool.length > 0);
  assert.equal(result.candidatePool[0].path, "app/target.ts");
});

test("probe terms keep English first and pick corpus-present CJK by idf", () => {
  assert.deepEqual(
    selectProbePatternTerms(["lease", "密钥", "钥池", "调度"], { lease: 1, 密钥: 0.5, 调度: 2 }),
    ["lease", "调度", "密钥"],
  );
  const ascii = Array.from({ length: 12 }, (_, index) => `term${index}`);
  assert.deepEqual(selectProbePatternTerms(ascii, {}), ascii.slice(0, 8));
});

test("a long CJK run is not offered as a grep lead", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-cjk-patterns-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "provider.ts"), "// 网络供应商 设置\nexport const provider = true;\n");
  const result = scoreFiles("管理后台的网络供应商设置在哪", root, ["."], [], { maxResults: 5 });
  const cjk = result.rgPatterns.filter(isCjkToken);
  assert.ok(cjk.every((pattern) => pattern.length <= 4));
  assert.ok(cjk.length <= 6);
});
