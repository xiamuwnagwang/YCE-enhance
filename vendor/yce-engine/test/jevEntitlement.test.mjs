// Jev screen entitlement gating (jev-gating W5).
//
// The relay classifies a jev lease request into five shapes; the engine has to
// keep them apart, and the only assertion that actually proves it is "did a
// /yce/jev-lease request go out at all". Every case here counts requests with
// an injected fetch rather than reading the branch, because the whole point of
// the pre-dispatched entitlement is a round trip that never happens.
//
// Relay truth this file is written against (repo yce-relay-frontend-main):
//   da659df  W1  jev_screen_enabled sinks into the user status read
//   8e248c3  W2  jev_lease.go:315 403 JEV_NOT_ENTITLED, writeJevLeaseFailure
//                splits 503 JEV_POOL_EXHAUSTED (terminal) from 503 NO_JEV_KEY
//                and 503 JEV_SCHEDULER_UNAVAILABLE (transient)
//   30a5ea1  W3  /yce/lease-key 200 body carries jev_screen_enabled
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test as coreTest, searchWithDetails } from "../lib/core.mjs";
import { connectFrameEncode, ProtobufEncoder } from "../lib/protobuf.mjs";

const RELAY_URL = "https://relay.invalid";
const RELAY_TOKEN = "relay-token-fixture";
const ENV_KEY = "local-env-typesafe-key";
const SCREEN_ENDPOINT = "api.typesafe.ai";

// Shares no term with the fixture repo, so the local preranker reports zero
// lexical hits and low confidence — the only thing that opens the jev block now
// that the query regex special cases are gone. The fallback pool is the fixture
// files in path order, so file_0 is still internal/cache.go.
const SCREEN_QUERY = "how does the scheduler rotate telemetry buckets";

const TEST_RELAY_STATE_FILE = join(tmpdir(), `yce-jev-entitlement-state-${process.pid}.json`);
coreTest.setRelayStateFile(TEST_RELAY_STATE_FILE);
process.on("exit", () => {
  try { rmSync(TEST_RELAY_STATE_FILE, { force: true }); } catch {}
});

function makeFixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "yce-jev-entitlement-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(
    join(root, "internal", "cache.go"),
    "package internal\nfunc InvalidateCache(key string) {}\n",
  );
  writeFileSync(
    join(root, "internal", "lease.go"),
    "package internal\nfunc LeaseKey() string { return \"key\" }\n",
  );
  return root;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jevScreenResponse() {
  return jsonResponse({
    model: "jev-latest",
    answers: {
      pick: { type: "choice", probabilities: { file_0: 0.88, file_1: 0.04 }, confidence: 0.88 },
    },
    usage: { input_tokens: 210, output_tokens: 12 },
  });
}

// Restores every process-wide seam these tests borrow.
function installEnvironment(t, { envKey = ENV_KEY, relayToken = RELAY_TOKEN, fetchImpl }) {
  const previous = {
    fetch: globalThis.fetch,
    typesafeKey: process.env.TYPESAFE_API_KEY,
    relayUrl: process.env.YCE_RELAY_URL,
    relayToken: process.env.YCE_RELAY_TOKEN,
    apiKey: process.env.YCE_API_KEY,
  };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of [
      ["TYPESAFE_API_KEY", previous.typesafeKey],
      ["YCE_RELAY_URL", previous.relayUrl],
      ["YCE_RELAY_TOKEN", previous.relayToken],
      ["YCE_API_KEY", previous.apiKey],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    coreTest.resetRelayState();
  });
  coreTest.resetRelayState();
  if (envKey) process.env.TYPESAFE_API_KEY = envKey;
  else delete process.env.TYPESAFE_API_KEY;
  delete process.env.YCE_API_KEY;
  process.env.YCE_RELAY_URL = RELAY_URL;
  if (relayToken) process.env.YCE_RELAY_TOKEN = relayToken;
  else delete process.env.YCE_RELAY_TOKEN;
  globalThis.fetch = fetchImpl;
}

// Counts the two things every case below asserts on: whether a jev lease
// request left the process, and whether the screen itself ran (and on which
// key). `jevLease` returns the relay's answer for this shape.
function countingFetch({ jevLease, onRequest = () => {} }) {
  const calls = { jevLease: 0, screen: [] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    onRequest(target);
    if (target.endsWith("/yce/jev-lease")) {
      calls.jevLease += 1;
      return jevLease();
    }
    if (target.endsWith("/yce/jev-usage")) return jsonResponse({ ok: true });
    if (target.includes(SCREEN_ENDPOINT)) {
      calls.screen.push(String(options.headers?.Authorization || ""));
      return jevScreenResponse();
    }
    throw new Error(`unexpected URL in jev entitlement test: ${target}`);
  };
  return { calls, fetchImpl };
}

// ─── The eight shapes, at the prerank phase ────────────────
// Each row names the relay's answer and the three things the spec pins down:
// key source, skip reason, and whether a lease request was sent.
const LEASE_SHAPES = [
  {
    name: "403 JEV_NOT_ENTITLED is the authoritative fallback when the lease-key body said nothing",
    jevScreenEnabled: null,
    jevLease: () => jsonResponse({ error: "jev screen not entitled", code: "JEV_NOT_ENTITLED" }, 403),
    expect: { keySource: "none", skipReason: "not_entitled", leaseRequests: 1, screenRan: false },
    leaseErrorPattern: /JEV_NOT_ENTITLED/,
  },
  {
    name: "503 JEV_POOL_EXHAUSTED is terminal and never reaches for the local env key",
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ error: "jev key pool exhausted", code: "JEV_POOL_EXHAUSTED" }, 503),
    expect: { keySource: "none", skipReason: "pool_exhausted", leaseRequests: 1, screenRan: false },
    leaseErrorPattern: /JEV_POOL_EXHAUSTED/,
  },
  {
    name: "503 NO_JEV_KEY is transient cooling and keeps the env fallback",
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ error: "no jev key available", code: "NO_JEV_KEY" }, 503),
    expect: { keySource: "env_fallback", skipReason: null, leaseRequests: 1, screenRan: true },
    leaseErrorPattern: /NO_JEV_KEY/,
  },
  {
    name: "503 JEV_SCHEDULER_UNAVAILABLE is relay infrastructure and keeps the env fallback",
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ error: "jev scheduler unavailable", code: "JEV_SCHEDULER_UNAVAILABLE" }, 503),
    expect: { keySource: "env_fallback", skipReason: null, leaseRequests: 1, screenRan: true },
    leaseErrorPattern: /JEV_SCHEDULER_UNAVAILABLE/,
  },
  {
    name: "500 JEV_POOL_LOAD_FAILED is relay infrastructure and keeps the env fallback",
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ code: "JEV_POOL_LOAD_FAILED", error: "pool decrypt failed" }, 500),
    expect: { keySource: "env_fallback", skipReason: null, leaseRequests: 1, screenRan: true },
    leaseErrorPattern: /JEV_POOL_LOAD_FAILED/,
  },
  {
    name: "a network error means the relay is unreachable, which says nothing about entitlement",
    jevScreenEnabled: true,
    jevLease: () => { throw new Error("ECONNREFUSED"); },
    expect: { keySource: "env_fallback", skipReason: null, leaseRequests: 1, screenRan: true },
    leaseErrorPattern: /jev lease error/,
  },
];

for (const shape of LEASE_SHAPES) {
  test(shape.name, async (t) => {
    const root = makeFixtureRepo(t);
    const { calls, fetchImpl } = countingFetch({ jevLease: shape.jevLease });
    installEnvironment(t, { fetchImpl });

    const result = await coreTest.runLocalBootstrapPhase({
      query: SCREEN_QUERY,
      projectRoot: root,
      excludePaths: [],
      maxResults: 5,
      jevScreenEnabled: shape.jevScreenEnabled,
    });
    await coreTest.flushUsageReports();

    assert.equal(calls.jevLease, shape.expect.leaseRequests, "wrong number of /yce/jev-lease requests");
    assert.equal(result.jev.keySource, shape.expect.keySource);
    assert.equal(result.jev.skipReason, shape.expect.skipReason);
    assert.equal(result.jev.entitled, shape.jevScreenEnabled);
    assert.match(result.jev.leaseError, shape.leaseErrorPattern);
    // The env key is set in every one of these cases, so "no screen ran" can
    // only mean the terminal branch refused to use it.
    assert.equal(calls.screen.length, shape.expect.screenRan ? 1 : 0);
    if (shape.expect.screenRan) {
      assert.equal(calls.screen[0], `Bearer ${ENV_KEY}`, "the screen ran on the wrong key");
    }
    // The prerank phase itself always produces usable output.
    assert.ok(result.candidates.length > 0);
  });
}

test("a pre-dispatched jev_screen_enabled=false sends no lease request at all", async (t) => {
  const root = makeFixtureRepo(t);
  const { calls, fetchImpl } = countingFetch({
    jevLease: () => { throw new Error("the unentitled path must not request a lease"); },
  });
  installEnvironment(t, { fetchImpl });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    jevScreenEnabled: false,
  });

  assert.equal(calls.jevLease, 0, "an unentitled user paid for a lease round trip");
  assert.equal(calls.screen.length, 0);
  assert.equal(result.jev.entitled, false);
  assert.equal(result.jev.skipReason, "not_entitled");
  // null, not "none": no key was ever reached for.
  assert.equal(result.jev.keySource, null);
  assert.equal(result.jev.leaseError, null);
  assert.equal(result.jev.attempted, false);
  assert.ok(result.candidates.length > 0);
});

// Positive control. Without it every "0 lease requests" assertion above could
// be vacuously true because the fixture never reached the jev block.
test("an entitled user does send exactly one lease request and screens on the pooled key", async (t) => {
  const root = makeFixtureRepo(t);
  const { calls, fetchImpl } = countingFetch({
    jevLease: () => jsonResponse({
      api_key: "pooled-jev-key",
      key_id: "pool-entry-5",
      lease_id: "jev-lease-5",
    }),
  });
  installEnvironment(t, { fetchImpl });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    jevScreenEnabled: true,
  });
  await coreTest.flushUsageReports();

  assert.equal(calls.jevLease, 1);
  assert.equal(result.jev.entitled, true);
  assert.equal(result.jev.keySource, "relay");
  assert.equal(result.jev.keyId, "pool-entry-5");
  assert.equal(result.jev.success, true);
  assert.equal(calls.screen.length, 1);
  assert.equal(calls.screen[0], "Bearer pooled-jev-key");
  // Entitled users get the lease sent before the local prerank so its round
  // trip overlaps the scoring instead of following it.
  assert.equal(result.jev.leasePrefetched, true);
  assert.ok(Number.isFinite(result.jev.leaseElapsedMs));
});

// The prefetch must overlap the prerank, and a prefetched lease the screen
// does not use must never turn into a screen call or a usage receipt — the
// relay bills the lease as issued (lease_count) and nothing else.
test("an entitled user's lease is sent before prerank finishes and is discarded when the screen is skipped", async (t) => {
  const root = makeFixtureRepo(t);
  let leaseSignal = null;
  const { calls, fetchImpl } = countingFetch({
    jevLease: () => jsonResponse({ api_key: "pooled-jev-key", key_id: "pool-entry-7", lease_id: "jev-lease-7" }),
  });
  const capturingFetch = (url, options = {}) => {
    if (String(url).endsWith("/yce/jev-lease")) leaseSignal = options.signal || null;
    return fetchImpl(url, options);
  };
  installEnvironment(t, { fetchImpl: capturingFetch });

  // "InvalidateCache" is a declaration in the fixture, so the prerank is high
  // confidence and the screen is skipped — but the lease had already left.
  const result = await coreTest.runLocalBootstrapPhase({
    query: "InvalidateCache lease key",
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    jevScreenEnabled: true,
  });
  await coreTest.flushUsageReports();

  assert.equal(result.jev.skipReason, "high_confidence");
  assert.equal(calls.jevLease, 1);
  assert.equal(calls.screen.length, 0);
  assert.equal(result.jev.leasePrefetched, null);
  assert.equal(result.jev.keySource, null);
  assert.ok(leaseSignal && leaseSignal.aborted, "unused prefetched lease is aborted");
});

test("YCE_JEV_LEASE_PREFETCH=0 restores the sequential lease for entitled users", async (t) => {
  const root = makeFixtureRepo(t);
  const { calls, fetchImpl } = countingFetch({
    jevLease: () => jsonResponse({ api_key: "pooled-jev-key", key_id: "pool-entry-8", lease_id: "jev-lease-8" }),
  });
  installEnvironment(t, { fetchImpl });
  const previous = process.env.YCE_JEV_LEASE_PREFETCH;
  process.env.YCE_JEV_LEASE_PREFETCH = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.YCE_JEV_LEASE_PREFETCH;
    else process.env.YCE_JEV_LEASE_PREFETCH = previous;
  });

  const skipped = await coreTest.runLocalBootstrapPhase({
    query: "InvalidateCache lease key",
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    jevScreenEnabled: true,
  });
  assert.equal(skipped.jev.skipReason, "high_confidence");
  assert.equal(calls.jevLease, 0, "no speculative lease when prefetch is off");

  const screened = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    jevScreenEnabled: true,
  });
  await coreTest.flushUsageReports();
  assert.equal(calls.jevLease, 1);
  assert.equal(screened.jev.leasePrefetched, false);
  assert.equal(screened.jev.success, true);
});

// The eighth shape's second half: a missing YCE_RELAY_TOKEN also sends zero
// requests, but for the opposite reason — it is relay-unreachable, not
// unentitled — so "zero requests" alone can never be read as not_entitled.
test("a missing YCE_RELAY_TOKEN sends no request yet still falls back to the env key", async (t) => {
  const root = makeFixtureRepo(t);
  const { calls, fetchImpl } = countingFetch({
    jevLease: () => { throw new Error("no token means no request"); },
  });
  installEnvironment(t, { relayToken: "", fetchImpl });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
  });

  assert.equal(calls.jevLease, 0);
  assert.equal(result.jev.entitled, null, "no relay said anything, so entitlement is unknown");
  assert.equal(result.jev.keySource, "env_fallback");
  assert.equal(result.jev.skipReason, null);
  assert.equal(calls.screen.length, 1, "relay-unreachable must still screen on the env key");
  assert.equal(calls.screen[0], `Bearer ${ENV_KEY}`);
});

test("an unrecognized lease code stays non-terminal so an unknown relay never disables a paid screen", async (t) => {
  const root = makeFixtureRepo(t);
  const { calls, fetchImpl } = countingFetch({
    jevLease: () => jsonResponse({ code: "JEV_SOMETHING_NEW", error: "from a newer relay" }, 503),
  });
  installEnvironment(t, { fetchImpl });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    jevScreenEnabled: true,
  });
  await coreTest.flushUsageReports();

  assert.equal(calls.jevLease, 1);
  assert.equal(result.jev.keySource, "env_fallback");
  assert.equal(calls.screen.length, 1);
});

test("the lease failure value labels terminal and transient codes apart", async (t) => {
  installEnvironment(t, {
    fetchImpl: async () => jsonResponse({ code: "JEV_POOL_EXHAUSTED", error: "jev key pool exhausted" }, 503),
  });
  const exhausted = await coreTest.leaseJevKey();
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, "JEV_POOL_EXHAUSTED");
  assert.equal(exhausted.terminal, true);

  globalThis.fetch = async () => jsonResponse({ code: "NO_JEV_KEY", error: "no jev key available" }, 503);
  const cooling = await coreTest.leaseJevKey();
  assert.equal(cooling.code, "NO_JEV_KEY");
  assert.equal(cooling.terminal, false, "a transient cooling window must never be terminal");

  globalThis.fetch = async () => new Response("<html>gateway</html>", { status: 502 });
  const gateway = await coreTest.leaseJevKey();
  assert.equal(gateway.code, "HTTP 502", "an unparseable body still yields a code");
  assert.equal(gateway.terminal, false);
});

// The pre-dispatch path must cost nothing measurable over --no-jev-screen.
// Both runs share one fixture repo and one process so the comparison is not
// swamped by setup variance; the lease count is the real invariant and the
// timing is the spec's proxy for it.
test("the unentitled path costs the same prerank budget as --no-jev-screen", async (t) => {
  const root = makeFixtureRepo(t);
  const { calls, fetchImpl } = countingFetch({
    jevLease: () => { throw new Error("neither run may request a lease"); },
  });
  installEnvironment(t, { fetchImpl });

  const run = (options) => coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    ...options,
  });

  const disabled = await run({ noJevScreen: true });
  const unentitled = await run({ jevScreenEnabled: false });

  assert.equal(calls.jevLease, 0);
  assert.equal(disabled.jev.skipReason, "disabled_by_flag");
  assert.equal(unentitled.jev.skipReason, "not_entitled");

  const overheadOf = (result) => result.prerankTotalElapsedMs - result.prerankElapsedMs;
  const delta = Math.abs(overheadOf(unentitled) - overheadOf(disabled));
  assert.ok(delta < 50, `unentitled prerank overhead differed by ${delta}ms, expected < 50ms`);
});

test("--no-jev-screen still wins over an entitled user", async (t) => {
  const root = makeFixtureRepo(t);
  const { calls, fetchImpl } = countingFetch({
    jevLease: () => { throw new Error("the flag must short-circuit before the lease"); },
  });
  installEnvironment(t, { fetchImpl });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
    noJevScreen: true,
    jevScreenEnabled: true,
  });

  assert.equal(calls.jevLease, 0);
  assert.equal(result.jev.skipReason, "disabled_by_flag");
  assert.equal(result.jev.entitled, true, "the flag hides the screen, not the entitlement");
});

// ─── End to end: the main search survives every shape ──────

function encodedTestJwt() {
  const response = new ProtobufEncoder();
  response.writeString(1, "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.");
  return response.toBuffer();
}

// A single-turn transcript: the model answers immediately with one file that
// exists in the fixture repo, so `files` is non-empty whenever the main search
// itself completed.
function answerStreamResponse() {
  const answer = "<file path=\"internal/cache.go\"><range>1-2</range></file>";
  const text = `[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer })}`;
  return new Response(connectFrameEncode(Buffer.from(text, "utf-8")), { status: 200 });
}

// Wraps the jev-shape fetch with the main search endpoints. `leaseKeyBody`
// carries the pre-dispatched entitlement exactly as relay commit 30a5ea1
// writes it.
function searchFetch({ jevLease, jevScreenEnabled }) {
  const { calls, fetchImpl: jevFetch } = countingFetch({ jevLease });
  calls.mainLease = 0;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/yce/lease-key")) {
      calls.mainLease += 1;
      const body = {
        api_key: "main-relay-key-secret-value-that-is-long-enough",
        key_id: "main-key-1",
        lease_id: "main-lease-1",
        lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
      if (typeof jevScreenEnabled === "boolean") body.jev_screen_enabled = jevScreenEnabled;
      return jsonResponse(body);
    }
    if (target.endsWith("/GetUserJwt")) return new Response(encodedTestJwt(), { status: 200 });
    if (target.endsWith("/CheckUserMessageRateLimit")) return new Response(Buffer.alloc(0), { status: 200 });
    if (target.endsWith("/GetDevstralStream")) return answerStreamResponse();
    if (target.endsWith("/yce/usage")) return jsonResponse({ success: true });
    return jevFetch(url, options);
  };
  return { calls, fetchImpl };
}

async function runSearch(root, extra = {}) {
  return searchWithDetails({
    query: SCREEN_QUERY,
    projectRoot: root,
    maxResults: 5,
    maxTurns: 1,
    timeoutMs: 5000,
    ...extra,
  });
}

// Shapes 1-7 all go through the real relay lease path; shape 8 (BYOK) is the
// one that must not, because an explicit apiKey turns relayManaged off.
const SEARCH_SHAPES = [
  {
    name: "pre-dispatched jev_screen_enabled=false",
    jevScreenEnabled: false,
    jevLease: () => { throw new Error("no lease may be requested"); },
    expect: { entitled: false, keySource: null, skipReason: "not_entitled", leaseRequests: 0 },
  },
  {
    name: "403 JEV_NOT_ENTITLED",
    jevScreenEnabled: null,
    jevLease: () => jsonResponse({ code: "JEV_NOT_ENTITLED", error: "jev screen not entitled" }, 403),
    expect: { entitled: null, keySource: "none", skipReason: "not_entitled", leaseRequests: 1 },
  },
  {
    name: "503 JEV_POOL_EXHAUSTED",
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ code: "JEV_POOL_EXHAUSTED", error: "jev key pool exhausted" }, 503),
    expect: { entitled: true, keySource: "none", skipReason: "pool_exhausted", leaseRequests: 1 },
  },
  {
    name: "503 NO_JEV_KEY",
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ code: "NO_JEV_KEY", error: "no jev key available" }, 503),
    expect: { entitled: true, keySource: "env_fallback", skipReason: null, leaseRequests: 1 },
  },
  {
    name: "503 JEV_SCHEDULER_UNAVAILABLE",
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ code: "JEV_SCHEDULER_UNAVAILABLE", error: "jev scheduler unavailable" }, 503),
    expect: { entitled: true, keySource: "env_fallback", skipReason: null, leaseRequests: 1 },
  },
  {
    name: "500 JEV_POOL_LOAD_FAILED",
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ code: "JEV_POOL_LOAD_FAILED", error: "pool decrypt failed" }, 500),
    expect: { entitled: true, keySource: "env_fallback", skipReason: null, leaseRequests: 1 },
  },
  {
    name: "a network error on the jev lease",
    jevScreenEnabled: true,
    jevLease: () => { throw new Error("ECONNREFUSED"); },
    expect: { entitled: true, keySource: "env_fallback", skipReason: null, leaseRequests: 1 },
  },
];

for (const shape of SEARCH_SHAPES) {
  test(`main search survives ${shape.name} and still returns files`, async (t) => {
    const root = makeFixtureRepo(t);
    const { calls, fetchImpl } = searchFetch(shape);
    installEnvironment(t, { fetchImpl });

    const details = await runSearch(root);

    assert.equal(details.error, null);
    assert.ok(details.files.length > 0, "the main search returned no files");
    assert.equal(calls.jevLease, shape.expect.leaseRequests);
    assert.equal(details.diagnostics.jev_screen_entitled, shape.expect.entitled);
    assert.equal(details.diagnostics.jev_key_source, shape.expect.keySource);
    assert.equal(details.diagnostics.jev_screen_skip_reason, shape.expect.skipReason);
  });
}

test("main search survives BYOK, where entitlement is unknown and the env fallback stands", async (t) => {
  const root = makeFixtureRepo(t);
  const { calls, fetchImpl } = searchFetch({
    jevScreenEnabled: true,
    jevLease: () => jsonResponse({ code: "NO_JEV_KEY", error: "no jev key available" }, 503),
  });
  installEnvironment(t, { fetchImpl });

  // An explicit apiKey turns relayManaged off: no main lease is taken, so no
  // entitlement is ever pre-dispatched even though the relay would have sent
  // one. The jwt rides along because the public protocol proxy refuses to mint
  // one without a live relay lease — BYOK brings both halves or neither.
  const details = await runSearch(root, {
    apiKey: "byok-api-key-secret-value-that-is-long-enough",
    jwt: "byok-jwt",
  });

  assert.equal(details.error, null);
  assert.ok(details.files.length > 0);
  assert.equal(calls.mainLease, 0, "BYOK must not lease a relay key");
  assert.equal(details.diagnostics.jev_screen_entitled, null);
  assert.equal(details.diagnostics.jev_key_source, "env_fallback");
  assert.equal(details.diagnostics.jev_screen_skip_reason, null);
});
