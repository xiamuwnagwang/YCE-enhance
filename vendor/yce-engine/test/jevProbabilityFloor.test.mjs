import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test as coreTest } from "../lib/core.mjs";

// Shares no term with the fixture repo, so the local preranker reports zero
// lexical hits and low confidence — the only thing that opens the jev block.
// The fallback pool is the fixture files in path order, so file_0 is
// internal/cache.go and file_1 is internal/lease.go.
const SCREEN_QUERY = "how does the scheduler rotate telemetry buckets";

function makeFixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "yce-jev-floor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "cache.go"), "package internal\nfunc InvalidateCache(key string) {}\n");
  writeFileSync(join(root, "internal", "lease.go"), "package internal\nfunc LeaseKey() string { return \"key\" }\n");
  return root;
}

// Puts all of Jev's weight on file_1 (internal/lease.go), which local path
// order ranks second: if the screen is acted on, the order flips.
function screenWith(topProbability) {
  return new Response(JSON.stringify({
    model: "jev-latest",
    answers: {
      pick: {
        type: "choice",
        probabilities: { file_0: 0.02, file_1: topProbability },
        confidence: topProbability,
      },
    },
    usage: { input_tokens: 210, output_tokens: 12 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function installEnvironment(t, topProbability) {
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
  process.env.TYPESAFE_API_KEY = "local-env-typesafe-key";
  delete process.env.YCE_RELAY_URL;
  delete process.env.YCE_RELAY_TOKEN;
  globalThis.fetch = async (url) => {
    const target = String(url);
    // No relay token is set, so the lease is refused without a request and the
    // env key carries the screen; nothing else should be reached.
    if (target.endsWith("/yce/jev-lease") || target.endsWith("/yce/jev-usage")) {
      throw new Error(`unexpected relay call in probability floor test: ${target}`);
    }
    return screenWith(topProbability);
  };
}

async function runScreen(t, topProbability) {
  const root = makeFixtureRepo(t);
  installEnvironment(t, topProbability);
  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
  });
  await coreTest.flushUsageReports();
  return result;
}

test("a top probability at the floor still reorders the pool onto Jev's pick", async (t) => {
  const result = await runScreen(t, 0.25);
  assert.equal(result.jev.success, true);
  assert.equal(result.jev.topProbability, 0.25);
  assert.equal(result.jev.reorderApplied, true);
  assert.equal(result.candidates[0].path, "internal/lease.go");
  assert.equal(result.candidates[0].score, 0.25);
  assert.ok(result.candidates[0].reasons.includes("jev=0.25"));
});

test("a top probability just under the floor records the screen without reordering", async (t) => {
  const result = await runScreen(t, 0.2499);
  assert.equal(result.jev.success, true);
  assert.equal(result.jev.topProbability, 0.2499);
  assert.equal(result.jev.reorderApplied, false);
  // Local path order survives untouched: no reorder, no score overwrite, no
  // jev= reason appended.
  assert.equal(result.candidates[0].path, "internal/cache.go");
  assert.equal(result.candidates[0].score, 0);
  assert.ok(!result.candidates.some((candidate) => (candidate.reasons || []).some((reason) => reason.startsWith("jev="))));
});

test("a confident screen is still recorded as attempted and successful when it is not acted on", async (t) => {
  const result = await runScreen(t, 0.01);
  assert.equal(result.jev.attempted, true);
  assert.equal(result.jev.success, true);
  assert.equal(result.jev.skipReason, null);
  assert.equal(result.jev.reorderApplied, false);
});

test("a screen that never returned a ranking leaves reorderApplied null", async (t) => {
  const root = makeFixtureRepo(t);
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
  process.env.TYPESAFE_API_KEY = "local-env-typesafe-key";
  delete process.env.YCE_RELAY_URL;
  delete process.env.YCE_RELAY_TOKEN;
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

  const result = await coreTest.runLocalBootstrapPhase({
    query: SCREEN_QUERY,
    projectRoot: root,
    excludePaths: [],
    maxResults: 5,
  });
  await coreTest.flushUsageReports();
  assert.equal(result.jev.success, false);
  assert.equal(result.jev.skipReason, "http_401");
  assert.equal(result.jev.reorderApplied, null);
});
