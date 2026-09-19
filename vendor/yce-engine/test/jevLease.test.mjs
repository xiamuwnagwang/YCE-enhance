import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test as coreTest } from "../lib/core.mjs";

const RELAY_URL = "https://relay.invalid";

// A query that matches the semantic-screen invitation regex so the Jev block
// is reached without depending on the local preranker reporting low confidence.
const SCREEN_QUERY = "invalidate the cache entry for a leased key";

function makeFixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "yce-jev-lease-"));
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

function jevScreenResponse({ inputTokens = 210, outputTokens = 12 } = {}) {
  return new Response(JSON.stringify({
    model: "jev-latest",
    answers: {
      pick: { type: "choice", probabilities: { file_0: 0.88, file_1: 0.04 }, confidence: 0.88 },
    },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

// Restores every process-wide seam this suite borrows: the three env vars and
// globalThis.fetch are shared by all tests in this file's process.
function installEnvironment(t, { envKey, fetchImpl }) {
  const previous = {
    fetch: globalThis.fetch,
    typesafeKey: process.env.TYPESAFE_API_KEY,
    relayUrl: process.env.YCE_RELAY_URL,
    relayToken: process.env.YCE_RELAY_TOKEN,
  };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    if (previous.typesafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous.typesafeKey;
    if (previous.relayUrl === undefined) delete process.env.YCE_RELAY_URL;
    else process.env.YCE_RELAY_URL = previous.relayUrl;
    if (previous.relayToken === undefined) delete process.env.YCE_RELAY_TOKEN;
    else process.env.YCE_RELAY_TOKEN = previous.relayToken;
  });
  if (envKey) process.env.TYPESAFE_API_KEY = envKey;
  else delete process.env.TYPESAFE_API_KEY;
  process.env.YCE_RELAY_URL = RELAY_URL;
  process.env.YCE_RELAY_TOKEN = "relay-token-fixture";
  globalThis.fetch = fetchImpl;
}

test("relay lease supplies the Jev key and the run reports its token usage", async (t) => {
  const root = makeFixtureRepo(t);
  const calls = { lease: [], screen: [], usage: [] };
  installEnvironment(t, {
    envKey: "env-key-should-not-be-used",
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target.endsWith("/yce/jev-lease")) {
        calls.lease.push({ options, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({
          api_key: "pooled-jev-key",
          key_id: "pool-entry-7",
          lease_id: "jev-lease-7",
          lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
          selection_reason: "least_recently_used",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.endsWith("/yce/jev-usage")) {
        calls.usage.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      calls.screen.push({ url: target, headers: options.headers });
      return jevScreenResponse();
    },
  });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
  });
  await coreTest.flushUsageReports();

  assert.equal(result.jev.keySource, "relay");
  assert.equal(result.jev.keyId, "pool-entry-7");
  assert.equal(result.jev.leaseError, null);
  assert.equal(result.jev.attempted, true);
  assert.equal(result.jev.success, true);

  assert.equal(calls.lease.length, 1);
  assert.equal(calls.lease[0].options.headers.Authorization, "Bearer relay-token-fixture");
  // windsurf-only lease fields must not leak into the Jev request body.
  assert.deepEqual(calls.lease[0].body, {});

  // The screen ran on the leased key, not the local env key.
  assert.equal(calls.screen.length, 1);
  assert.equal(calls.screen[0].headers.Authorization, "Bearer pooled-jev-key");

  assert.equal(calls.usage.length, 1);
  assert.equal(calls.usage[0].key_id, "pool-entry-7");
  assert.equal(calls.usage[0].lease_id, "jev-lease-7");
  assert.equal(calls.usage[0].ok, true);
  assert.equal(calls.usage[0].input_tokens, 210);
  assert.equal(calls.usage[0].output_tokens, 12);
  assert.equal(typeof calls.usage[0].duration_ms, "number");
});

test("a 500 JEV_POOL_LOAD_FAILED lease falls back to the env key and records the error", async (t) => {
  const root = makeFixtureRepo(t);
  const calls = { lease: 0, screen: [], usage: 0 };
  installEnvironment(t, {
    envKey: "local-env-typesafe-key",
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target.endsWith("/yce/jev-lease")) {
        calls.lease += 1;
        return new Response(JSON.stringify({ code: "JEV_POOL_LOAD_FAILED", error: "pool decrypt failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (target.endsWith("/yce/jev-usage")) {
        calls.usage += 1;
        return new Response("{}", { status: 200 });
      }
      calls.screen.push({ headers: options.headers });
      return jevScreenResponse({ inputTokens: 99, outputTokens: 3 });
    },
  });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
  });
  await coreTest.flushUsageReports();

  assert.equal(calls.lease, 1);
  assert.equal(result.jev.keySource, "env_fallback");
  assert.equal(result.jev.keyId, null);
  assert.match(result.jev.leaseError, /JEV_POOL_LOAD_FAILED/);
  // Never a silent skip: the screen still happened, on the local key.
  assert.equal(result.jev.attempted, true);
  assert.equal(result.jev.success, true);
  assert.equal(result.jev.skipReason, null);
  assert.equal(calls.screen.length, 1);
  assert.equal(calls.screen[0].headers.Authorization, "Bearer local-env-typesafe-key");
  // No lease was issued, so there is nothing to report usage against.
  assert.equal(calls.usage, 0);
});

test("503 NO_JEV_KEY without a local env key skips the screen and says why", async (t) => {
  const root = makeFixtureRepo(t);
  const calls = { lease: 0, screen: 0 };
  installEnvironment(t, {
    envKey: "",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith("/yce/jev-lease")) {
        calls.lease += 1;
        return new Response(JSON.stringify({ code: "NO_JEV_KEY" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      calls.screen += 1;
      return jevScreenResponse();
    },
  });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
  });

  assert.equal(calls.lease, 1);
  assert.equal(calls.screen, 0);
  assert.equal(result.jev.keySource, "none");
  assert.equal(result.jev.skipReason, "missing_api_key");
  assert.match(result.jev.leaseError, /NO_JEV_KEY/);
  assert.equal(result.jev.attempted, false);
  // The phase still returns usable local prerank output.
  assert.ok(result.candidates.length > 0);
});

test("a failed screen on a leased key still sends a receipt carrying the HTTP status", async (t) => {
  const root = makeFixtureRepo(t);
  const usage = [];
  installEnvironment(t, {
    envKey: "",
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target.endsWith("/yce/jev-lease")) {
        return new Response(JSON.stringify({
          api_key: "pooled-jev-key",
          key_id: "pool-entry-9",
          lease_id: "jev-lease-9",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.endsWith("/yce/jev-usage")) {
        usage.push(JSON.parse(options.body));
        return new Response("{}", { status: 200 });
      }
      return new Response("unauthorized", { status: 401 });
    },
  });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
  });
  await coreTest.flushUsageReports();

  assert.equal(result.jev.keySource, "relay");
  assert.equal(result.jev.success, false);
  assert.equal(result.jev.skipReason, "http_401");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].ok, false);
  assert.equal(usage[0].status_code, 401);
  assert.equal(usage[0].error_code, "http_401");
  assert.equal(usage[0].input_tokens, null);
});

test("the lease aborts at 2s so the screen never becomes a new latency source", async (t) => {
  installEnvironment(t, {
    envKey: "",
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    }),
  });

  const startedAt = Date.now();
  const lease = await coreTest.leaseJevKey();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(lease.ok, false);
  assert.match(lease.error, /jev lease error/);
  assert.ok(elapsedMs >= 1500, `lease aborted after ${elapsedMs}ms, expected the 2s budget`);
  assert.ok(elapsedMs < 5000, `lease took ${elapsedMs}ms, expected the 2s budget`);
});

test("usage receipts retry up to three times but never retry a 4xx", async (t) => {
  let attempts = 0;
  installEnvironment(t, {
    envKey: "",
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: "relay down" }), { status: 500 });
    },
  });
  const lease = { relayUrl: RELAY_URL, relayToken: "relay-token-fixture", keyId: "k1", leaseId: "l1" };

  assert.equal(await coreTest.reportJevUsage(lease, { ok: true, inputTokens: 1, outputTokens: 2 }), false);
  assert.equal(attempts, 3);
  assert.match(lease.lastUsageError, /relay down/);

  attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "unknown lease_id" }), { status: 400 });
  };
  assert.equal(await coreTest.reportJevUsage(lease, { ok: true }), false);
  assert.equal(attempts, 1, "a 400 receipt is invalid on its face and must not be retried");
  assert.match(lease.lastUsageError, /unknown lease_id/);
});
