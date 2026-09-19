import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scoreFiles } from "../lib/directory-scorer.mjs";
import { buildFileSkeleton, screenCandidates } from "../lib/jevScreen.mjs";
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
  assert.match(buildFileSkeleton("package main\nfunc Main() {}\n"), /func Main/);
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
