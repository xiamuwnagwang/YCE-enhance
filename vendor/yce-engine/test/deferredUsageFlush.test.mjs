import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __test as coreTest,
  search,
  searchWithDetails,
  searchWithDetailsDeferred,
} from "../lib/core.mjs";
import { connectFrameEncode, ProtobufEncoder } from "../lib/protobuf.mjs";

const RELAY_URL = "https://relay.invalid";
const STATE_FILE = join(tmpdir(), `yce-deferred-usage-state-${process.pid}.json`);
coreTest.setRelayStateFile(STATE_FILE);
process.on("exit", () => {
  try { rmSync(STATE_FILE, { force: true }); } catch {}
});

function makeFixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "yce-deferred-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "cache.go"), "package internal\nfunc InvalidateCache() {}\n");
  return root;
}

function encodedTestJwt() {
  const response = new ProtobufEncoder();
  response.writeString(1, "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.");
  return response.toBuffer();
}

function answerStreamResponse() {
  const answer = '<file path="internal/cache.go"><range>1-2</range></file>';
  const text = `[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer })}`;
  return new Response(connectFrameEncode(Buffer.from(text, "utf-8")), { status: 200 });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installEnvironment(t, usageHandler) {
  const previous = {
    fetch: globalThis.fetch,
    relayUrl: process.env.YCE_RELAY_URL,
    relayToken: process.env.YCE_RELAY_TOKEN,
    apiKey: process.env.YCE_API_KEY,
    reuse: process.env.YCE_LEASE_REUSE,
  };
  t.after(async () => {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of [
      ["YCE_RELAY_URL", previous.relayUrl],
      ["YCE_RELAY_TOKEN", previous.relayToken],
      ["YCE_API_KEY", previous.apiKey],
      ["YCE_LEASE_REUSE", previous.reuse],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await coreTest.flushUsageReports();
    coreTest.resetRelayState();
  });

  coreTest.resetRelayState();
  process.env.YCE_RELAY_URL = RELAY_URL;
  process.env.YCE_RELAY_TOKEN = "relay-token-fixture";
  delete process.env.YCE_API_KEY;
  delete process.env.YCE_LEASE_REUSE;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/yce/lease-key")) {
      return jsonResponse({
        api_key: "main-relay-key-secret-value-that-is-long-enough",
        key_id: "main-key-1",
        lease_id: "main-lease-1",
        lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
        jev_screen_enabled: false,
      });
    }
    if (target.endsWith("/GetUserJwt")) return new Response(encodedTestJwt(), { status: 200 });
    if (target.endsWith("/CheckUserMessageRateLimit")) return new Response(Buffer.alloc(0), { status: 200 });
    if (target.endsWith("/GetDevstralStream")) return answerStreamResponse();
    if (target.endsWith("/yce/usage")) return usageHandler(options);
    throw new Error(`unexpected URL: ${target}`);
  };
}

function options(root) {
  return {
    query: "where is cache invalidation handled",
    projectRoot: root,
    noJevScreen: true,
    maxTurns: 1,
    maxResults: 5,
    timeoutMs: 5000,
  };
}

test("searchWithDetailsDeferred returns before the usage receipt round trip finishes", async (t) => {
  const root = makeFixtureRepo(t);
  let releaseGate;
  const gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
  let usagePosts = 0;
  let usageAcked = false;
  let postedBody = null;
  installEnvironment(t, async (request) => {
    usagePosts += 1;
    postedBody = JSON.parse(String(request.body || "{}"));
    await gate;
    usageAcked = true;
    return jsonResponse({ success: true });
  });
  t.after(() => releaseGate());

  const { details, usageFlushed } = await searchWithDetailsDeferred(options(root));
  let settled = false;
  usageFlushed.then(() => { settled = true; });
  assert.equal(details.success, true);
  assert.ok(details.files.length > 0);
  assert.equal(usagePosts, 1);
  assert.equal(usageAcked, false);
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(settled, false);
  releaseGate();
  await usageFlushed;
  assert.equal(usageAcked, true);
  assert.equal(usagePosts, 1);
  assert.equal(postedBody.lease_id, "main-lease-1");
});

test("search still awaits its receipts", async (t) => {
  const root = makeFixtureRepo(t);
  let usageAcked = false;
  installEnvironment(t, async () => {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    usageAcked = true;
    return jsonResponse({ success: true });
  });
  await search(options(root));
  assert.equal(usageAcked, true);
});

test("the deferred details payload matches searchWithDetails", async (t) => {
  const root = makeFixtureRepo(t);
  installEnvironment(t, async () => jsonResponse({ success: true }));
  const direct = await searchWithDetails(options(root));
  coreTest.resetRelayState();
  const { details, usageFlushed } = await searchWithDetailsDeferred(options(root));
  await usageFlushed;
  const subset = (value) => ({
    success: value.success,
    output: value.output,
    result_present: value.result_present,
    empty_result: value.empty_result,
    files: value.files,
    grep_patterns: value.grep_patterns,
    error: value.error,
  });
  assert.deepEqual(subset(details), subset(direct));
});
