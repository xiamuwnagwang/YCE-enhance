import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { search, searchWithDetails, __test } from "../lib/core.mjs";
import { connectFrameEncode, ProtobufEncoder } from "../lib/protobuf.mjs";

// Isolate persisted relay backoff state from the developer's real cache file.
const TEST_RELAY_STATE_FILE = join(tmpdir(), `yce-test-fallback-state-${process.pid}.json`);
__test.setRelayStateFile(TEST_RELAY_STATE_FILE);
process.on("exit", () => {
  try { rmSync(TEST_RELAY_STATE_FILE, { force: true }); } catch {}
});

const QUERY = "select upstream key from the lease pool";

// A remote turn is a Connect frame holding one protobuf string; _parseResponse
// pulls the text back out of it, so this is enough to drive the whole loop.
function remoteTurn(text) {
  const message = new ProtobufEncoder();
  message.writeString(1, text);
  return connectFrameEncode(message.toBuffer());
}

const TOOL_CALL_TURN = remoteTurn(
  'Still mapping the repository before answering.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"tree","path":"/codebase","levels":1}}',
);
const EMPTY_ANSWER_TURN = remoteTurn(
  "Nothing conclusive was found.[TOOL_CALLS]answer[ARGS]{\"answer\":\"<ANSWER></ANSWER>\"}",
);
const NO_TOOL_CALL_TURN = remoteTurn(
  "I considered several directories but produced no tool call and no answer this turn.",
);
const ERROR_FRAME_TURN = connectFrameEncode(Buffer.from(JSON.stringify({
  error: { code: "internal", message: "upstream exploded mid-stream" },
})));

function makeFixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "lease_scheduler.go"), [
    "package internal",
    "",
    "// SelectUpstreamKey picks a key from the lease pool for the next request.",
    "func SelectUpstreamKey(pool []string) string { return pool[0] }",
  ].join("\n"));
  writeFileSync(join(root, "internal", "lease.go"), [
    "package internal",
    "",
    "// LeaseKey leases an upstream key from the pool.",
    "func LeaseKey() string { return \"key\" }",
  ].join("\n"));
  return root;
}

// Serves the two calls every search makes before the loop (rate-limit probe and
// nothing else, since the key and JWT are passed in) and then hands out the
// scripted stream turns.
function installRemote(t, turns) {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const state = { streamCalls: 0 };
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/CheckUserMessageRateLimit")) {
      return new Response(Buffer.alloc(0), { status: 200 });
    }
    if (target.endsWith("/GetDevstralStream")) {
      const turn = turns[Math.min(state.streamCalls, turns.length - 1)];
      state.streamCalls += 1;
      if (typeof turn === "number") return new Response("upstream refused", { status: turn });
      return new Response(turn, { status: 200 });
    }
    throw new Error(`unexpected URL in prerank fallback test: ${target}`);
  };
  return state;
}

function runSearch(root, overrides = {}) {
  return search({
    query: QUERY,
    projectRoot: root,
    apiKey: "fixture-api-key-long-enough-for-metadata",
    jwt: "fixture-jwt",
    maxTurns: 1,
    maxResults: 5,
    timeoutMs: 1000,
    noJevScreen: true,
    ...overrides,
  });
}

function assertLocalPrerankAnswer(result) {
  assert.ok(result.files.length > 0, "failure path returned an empty candidate pool");
  assert.equal(result._meta.answerSource, "local_prerank");
  for (const entry of result.files) {
    assert.ok(Array.isArray(entry.ranges) && entry.ranges.length > 0, `${entry.path} carried no ranges`);
  }
  assert.ok(
    result.files.some((entry) => entry.path === "internal/lease_scheduler.go"),
    "the top pre-ranked file was not handed back",
  );
}

test("a request error hands back the local prerank pool and keeps its error code", async (t) => {
  const root = makeFixtureRepo(t);
  installRemote(t, [400]);
  const result = await runSearch(root);
  assertLocalPrerankAnswer(result);
  assert.match(result.error, /SERVER_ERROR/);
  assert.equal(result._meta.errorCode, "SERVER_ERROR");
});

test("a payload error whose trimmed retry also fails still hands back the pool", async (t) => {
  const root = makeFixtureRepo(t);
  installRemote(t, [413]);
  const result = await runSearch(root);
  assertLocalPrerankAnswer(result);
  assert.match(result.error, /retry after context trim also failed/);
  assert.equal(result._meta.errorCode, "PAYLOAD_TOO_LARGE");
});

test("a turn with no tool call hands back the pool instead of a bare raw response", async (t) => {
  const root = makeFixtureRepo(t);
  installRemote(t, [NO_TOOL_CALL_TURN]);
  const result = await runSearch(root);
  assertLocalPrerankAnswer(result);
  assert.match(result.raw_response, /no tool call/);
  assert.equal(result.error, undefined);
});

test("an in-stream error frame hands back the pool and keeps the upstream message", async (t) => {
  const root = makeFixtureRepo(t);
  installRemote(t, [ERROR_FRAME_TURN]);
  const result = await runSearch(root);
  assertLocalPrerankAnswer(result);
  assert.match(result.error, /\[Error\] internal: upstream exploded mid-stream/);
});

test("exhausted turns hand back the pool and keep the max-turns error", async (t) => {
  const root = makeFixtureRepo(t);
  const state = installRemote(t, [TOOL_CALL_TURN]);
  const result = await runSearch(root);
  assertLocalPrerankAnswer(result);
  assert.equal(result.error, "Max turns reached without getting an answer");
  assert.equal(state.streamCalls, 2, "maxTurns=1 should spend exactly two remote calls");
});

test("a second empty answer hands back the pool after the one retry is spent", async (t) => {
  const root = makeFixtureRepo(t);
  const state = installRemote(t, [EMPTY_ANSWER_TURN]);
  const result = await runSearch(root);
  assertLocalPrerankAnswer(result);
  assert.equal(state.streamCalls, 2, "the empty answer must be retried exactly once");
  assert.equal(result.error, undefined);
});

test("the degraded answer is reported as present, listed in the output and carries the original error", async (t) => {
  const root = makeFixtureRepo(t);
  installRemote(t, [400]);
  const details = await searchWithDetails({
    query: QUERY,
    projectRoot: root,
    apiKey: "fixture-api-key-long-enough-for-metadata",
    jwt: "fixture-jwt",
    maxTurns: 1,
    maxResults: 5,
    timeoutMs: 1000,
    noJevScreen: true,
  });
  assert.equal(details.success, false, "a degraded answer must not be reported as a successful search");
  assert.equal(details.result_present, true);
  assert.equal(details.empty_result, false);
  assert.ok(details.files.length > 0);
  assert.equal(details.diagnostics.answer_source, "local_prerank");
  assert.equal(details.diagnostics.error_type, "SERVER_ERROR");
  assert.match(details.error, /SERVER_ERROR/);
  assert.match(details.output, /local prerank fallback/);
  assert.match(details.output, /lease_scheduler\.go/);
  assert.match(details.output, /\[diagnostic\] answer_source=local_prerank/);
});

// ─── Rate-limit exits ──────────────────────────────────────
// The advisory 429 probe settles before the main loop, so these exits are the
// earliest failure the search can take — earlier than the repo map, and
// earlier than any remote turn. The local prerank pool is already in hand by
// then, so they degrade on the same terms as the six in-loop sites.

// Serves a relay-managed search whose rate-limit probe always says 429. The
// lease responses are scripted so a test can pick which handleRateLimited
// branch it lands on.
function installRelay(t, leaseResponder) {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.YCE_RELAY_URL;
  const previousToken = process.env.YCE_RELAY_TOKEN;
  __test.resetRelayState();
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.YCE_RELAY_URL;
    else process.env.YCE_RELAY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.YCE_RELAY_TOKEN;
    else process.env.YCE_RELAY_TOKEN = previousToken;
    __test.resetRelayState();
  });
  process.env.YCE_RELAY_URL = "https://relay.invalid";
  process.env.YCE_RELAY_TOKEN = "relay-token";
  const state = { leaseCalls: 0, rateLimitCalls: 0, streamCalls: 0 };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/yce/lease-key")) {
      state.leaseCalls += 1;
      return leaseResponder(state.leaseCalls, JSON.parse(String(init?.body || "{}")));
    }
    if (target.endsWith("/GetUserJwt")) {
      return new Response(encodedTestJwt(), { status: 200 });
    }
    if (target.endsWith("/CheckUserMessageRateLimit")) {
      state.rateLimitCalls += 1;
      return new Response("busy", { status: 429 });
    }
    if (target.endsWith("/yce/usage")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target.endsWith("/GetDevstralStream")) state.streamCalls += 1;
    throw new Error(`unexpected URL in rate-limit fallback test: ${target}`);
  };
  return state;
}

function encodedTestJwt() {
  const response = new ProtobufEncoder();
  response.writeString(1, "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.");
  return response.toBuffer();
}

function leaseBody(index, validationSource = "") {
  return new Response(JSON.stringify({
    api_key: `rate-fallback-key-${index}-secret-value-that-is-long-enough`,
    key_id: `rate-fallback-key-${index}`,
    lease_id: `rate-fallback-lease-${index}`,
    validation_source: validationSource,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("an ordinary advisory 429 hands back the pool and keeps the rate-limit error", async (t) => {
  const root = makeFixtureRepo(t);
  const state = installRelay(t, (call) => leaseBody(call));
  const result = await search({
    query: QUERY,
    projectRoot: root,
    maxTurns: 1,
    maxResults: 5,
    timeoutMs: 1000,
    noJevScreen: true,
  });
  assertLocalPrerankAnswer(result);
  assert.equal(result.error, "Rate limited, please try again later");
  assert.equal(result._meta.errorCode, "RATE_LIMITED");
  assert.equal(state.leaseCalls, 1, "an ordinary 429 must not lease an alternate key");
  assert.equal(state.streamCalls, 0, "the rate-limit exit must not reach the remote loop");
});

test("RELAY_POOL_BUSY on the alternate lease hands back the pool and keeps the code", async (t) => {
  const root = makeFixtureRepo(t);
  // First lease is flagged request_recovery, so handleRateLimited is allowed
  // one alternate; the relay then has nothing left to hand out.
  const state = installRelay(t, (call) => (call === 1
    ? leaseBody(1, "request_recovery")
    : new Response(JSON.stringify({ error: "no key available" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })));
  const result = await search({
    query: QUERY,
    projectRoot: root,
    maxTurns: 1,
    maxResults: 5,
    timeoutMs: 1000,
    noJevScreen: true,
  });
  assertLocalPrerankAnswer(result);
  assert.match(result.error, /^RELAY_POOL_BUSY: /);
  assert.equal(result._meta.errorCode, "RATE_LIMITED");
  assert.equal(state.leaseCalls, 2, "request recovery gets exactly one alternate lease");
  assert.equal(state.streamCalls, 0);
});

test("a non-relay advisory 429 reports the degraded pool through the formatted output", async (t) => {
  const root = makeFixtureRepo(t);
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/CheckUserMessageRateLimit")) {
      return new Response("busy", { status: 429 });
    }
    throw new Error(`unexpected URL in non-relay rate-limit test: ${target}`);
  };
  const details = await searchWithDetails({
    query: QUERY,
    projectRoot: root,
    apiKey: "fixture-api-key-long-enough-for-metadata",
    jwt: "fixture-jwt",
    maxTurns: 1,
    maxResults: 5,
    timeoutMs: 1000,
    noJevScreen: true,
  });
  assert.equal(details.success, false, "a rate-limited degraded answer is not a successful search");
  assert.equal(details.result_present, true);
  assert.equal(details.diagnostics.answer_source, "local_prerank");
  assert.equal(details.diagnostics.error_type, "RATE_LIMITED");
  assert.match(details.error, /Rate limited/);
  assert.match(details.output, /local prerank fallback/);
  assert.match(details.output, /lease_scheduler\.go/);
  assert.match(details.output, /\[diagnostic\] answer_source=local_prerank/);
  // The repo map is never built on this path, so the tree fields must be
  // omitted rather than printed as "undefined".
  assert.doesNotMatch(details.output, /undefined/);
  assert.doesNotMatch(details.output, /tree_depth_used=/);
});

// ─── Range-less candidates ─────────────────────────────────
// These drive _localPrerankAnswerFiles and the range renderer directly rather
// than through a search. That is deliberate: today's local prerank producer
// cannot emit a range-less candidate — buildLineRanges floors an unmatched
// file at [[1, min(lines, 20)]], and a zero-line file never becomes a document
// in the first place. The synthesised [[1, 1]] was therefore a defensive
// branch that only ever misreported a pool arriving from somewhere else. It
// stays covered at this level so the wording is already correct if a future
// producer (a screen that reshapes candidates, a different hint source) does
// hand one back.

test("a candidate with no matched lines keeps empty ranges instead of a fake L1-1", (t) => {
  const root = makeFixtureRepo(t);
  const files = __test.localPrerankAnswerFiles(
    {
      source: "local",
      candidatePool: [
        { path: "internal/lease.go", ranges: [] },
        { path: "internal/lease_scheduler.go", ranges: [[3, 4]] },
      ],
    },
    root,
    5,
  );
  assert.equal(files.length, 2);
  const withoutRanges = files.find((entry) => entry.path === "internal/lease.go");
  assert.deepEqual(
    withoutRanges.ranges,
    [],
    "a range-less candidate must not be given a synthesised [[1, 1]]",
  );
  const withRanges = files.find((entry) => entry.path === "internal/lease_scheduler.go");
  assert.deepEqual(withRanges.ranges, [[3, 4]], "real ranges must survive untouched");
});

test("range-less answer files render as 'lines unknown', matching the verification leads", () => {
  assert.equal(__test.formatAnswerRanges([]), "lines unknown");
  assert.equal(__test.formatAnswerRanges(undefined), "lines unknown");
  assert.equal(__test.formatAnswerRanges([[3, 4]]), "L3-4");
  assert.equal(__test.formatAnswerRanges([[3, 4], [10, 12]]), "L3-4, L10-12");
  // The same wording _formatLocalPrerankCandidates already uses, so one pool
  // reads identically whether it arrives as a lead or as a degraded answer.
  const leads = __test.formatLocalPrerankCandidates([{ path: "internal/lease.go", ranges: [] }]);
  assert.match(leads, /lines unknown/);
});

test("without a local prerank pool the failure paths stay empty", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-fallback-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  installRemote(t, [400]);
  const result = await runSearch(root, { bootstrapEnabled: false });
  assert.deepEqual(result.files, []);
  assert.equal(result._meta.answerSource, undefined);
  assert.match(result.error, /SERVER_ERROR/);
});
