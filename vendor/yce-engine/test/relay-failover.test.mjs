import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { __test } from "../lib/core.mjs";
import { connectFrameEncode } from "../lib/protobuf.mjs";

// Isolate persisted relay backoff state from the developer's real cache file.
const TEST_RELAY_STATE_FILE = join(tmpdir(), `yce-test-relay-state-${process.pid}.json`);
__test.setRelayStateFile(TEST_RELAY_STATE_FILE);
process.on("exit", () => {
  try { rmSync(TEST_RELAY_STATE_FILE, { force: true }); } catch {}
});

test("stream error frames classify resource exhaustion as transient capacity", () => {
  const frame = connectFrameEncode(
    Buffer.from(JSON.stringify({
      error: { code: "resource_exhausted", message: "quota temporarily exhausted" },
    })),
  );
  const parsed = __test.extractStreamError(frame);
  assert.equal(parsed?.code, "resource_exhausted");
  assert.equal(parsed?.transientCapacity, true);
});

test("HTTP 200 stream capacity errors throw a structured retryable outcome", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const frame = connectFrameEncode(
    Buffer.from(JSON.stringify({
      error: { code: "resource_exhausted", message: "temporarily unavailable" },
    })),
  );
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(frame, { status: 200 });
  };
  await assert.rejects(
    __test.streamingRequest(Buffer.from("request"), 1000, 2, null),
    (error) => error?.code === "TRANSIENT_CAPACITY" && error?.details?.upstreamCode === "resource_exhausted",
  );
  assert.equal(fetchCalls, 1, "stream capacity error retried the same key");
});

test("HTTP 429 exits same-key retries and is not retried on another key", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("busy", { status: 429 });
  };
  await assert.rejects(
    __test.streamingRequest(Buffer.from("request"), 1000, 2, null),
    (error) => error?.code === "RATE_LIMITED",
  );
  assert.equal(fetchCalls, 1, "HTTP 429 retried the same key");
});

test("same logical call retries once on an alternate relay key and rebuilds credentials", async () => {
  const state = {
    relayManaged: true,
    apiKey: "key-one-secret-value-that-is-long-enough",
    jwt: "jwt-one",
    usageContext: {
      keyId: "key-1",
      leaseId: "lease-1",
      relayUrl: "https://relay.invalid",
      relayToken: "token",
    },
  };
  const leaseCalls = [];
  const built = [];
  let requests = 0;
  const result = await __test.streamingRequestWithRelayFailover({
    credentialState: state,
    buildProto(apiKey, jwt) {
      built.push({ apiKey, jwt });
      return Buffer.from(`${apiKey}:${jwt}`);
    },
    leaseCredential: async (options) => {
      leaseCalls.push(options);
      return {
        apiKey: "key-two-secret-value-that-is-long-enough",
        keyId: "key-2",
        leaseId: "lease-2",
        relayUrl: "https://relay.invalid",
        relayToken: "token",
      };
    },
    getJwt: async (apiKey) => `jwt-for-${apiKey}`,
    request: async () => {
      requests += 1;
      if (requests === 1) {
        throw new __test.YceEngineError("resource_exhausted", "TRANSIENT_CAPACITY");
      }
      return Buffer.from("ok");
    },
    sleep: async () => {},
    random: () => 0,
  });

  assert.equal(result.toString(), "ok");
  assert.equal(requests, 2);
  assert.equal(leaseCalls.length, 1);
  assert.deepEqual(leaseCalls[0].excludeKeyIds, ["key-1"]);
  assert.equal(leaseCalls[0].retryAttempt, 1);
  assert.equal(built[0].apiKey, "key-one-secret-value-that-is-long-enough");
  assert.equal(built[1].apiKey, "key-two-secret-value-that-is-long-enough");
  assert.equal(built[1].jwt, "jwt-for-key-two-secret-value-that-is-long-enough");
  assert.equal(state.apiKey, null);
  assert.equal(state.usageContext, null);
});

test("authentication, payload, network and rate-limit errors never cross keys", async () => {
  for (const code of ["AUTH_ERROR", "PAYLOAD_TOO_LARGE", "TIMEOUT", "NETWORK_ERROR", "RATE_LIMITED"]) {
    const state = {
      relayManaged: true,
      apiKey: "key-one-secret-value-that-is-long-enough",
      jwt: "jwt-one",
      usageContext: {
        keyId: "key-1",
        leaseId: `lease-${code}`,
        relayUrl: "https://relay.invalid",
        relayToken: "token",
      },
    };
    let leaseCalls = 0;
    await assert.rejects(
      __test.streamingRequestWithRelayFailover({
        credentialState: state,
        buildProto: () => Buffer.from("request"),
        leaseCredential: async () => {
          leaseCalls += 1;
          throw new Error("must not lease alternate");
        },
        request: async () => {
          throw new __test.YceEngineError(code, code);
        },
      }),
      (error) => error?.code === code,
    );
    assert.equal(leaseCalls, 0, `${code} unexpectedly leased an alternate key`);
  }
});

test("alternate failure is bounded and never walks the key pool", async () => {
  const state = {
    relayManaged: true,
    apiKey: "key-one-secret-value-that-is-long-enough",
    jwt: "jwt-one",
    usageContext: {
      keyId: "key-1",
      leaseId: "lease-1",
      relayUrl: "https://relay.invalid",
      relayToken: "token",
    },
  };
  let leaseCalls = 0;
  let requests = 0;
  await assert.rejects(
    __test.streamingRequestWithRelayFailover({
      credentialState: state,
      buildProto: () => Buffer.from("request"),
      leaseCredential: async () => {
        leaseCalls += 1;
        return {
          apiKey: "key-two-secret-value-that-is-long-enough",
          keyId: "key-2",
          leaseId: "lease-2",
          relayUrl: "https://relay.invalid",
          relayToken: "token",
        };
      },
      getJwt: async () => "jwt-two",
      request: async () => {
        requests += 1;
        throw new __test.YceEngineError("resource_exhausted", "TRANSIENT_CAPACITY");
      },
      sleep: async () => {},
      random: () => 0,
    }),
    (error) => error?.code === "TRANSIENT_CAPACITY",
  );
  assert.equal(requests, 2);
  assert.equal(leaseCalls, 1);
});

test("relay retry lease sends exclusion and retry metadata", async (t) => {
  __test.resetRelayState();
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.YCE_RELAY_URL;
  const previousToken = process.env.YCE_RELAY_TOKEN;
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
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      api_key: "key-two-secret-value-that-is-long-enough",
      key_id: "key-2",
      lease_id: "lease-2",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const leased = await __test.leaseApiKeyFromRelay({
    excludeKeyIds: [" key-1 ", "key-1"],
    retryAttempt: 1,
    forceNew: true,
  });
  assert.equal(leased, "key-two-secret-value-that-is-long-enough");
  assert.deepEqual(capturedBody, {
    exclude_key_ids: ["key-1"],
    retry_attempt: 1,
  });
});

test("relay quota failure is structured and cached until reset", async (t) => {
  __test.resetRelayState();
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.YCE_RELAY_URL;
  const previousToken = process.env.YCE_RELAY_TOKEN;
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
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      error: "user request quota reached",
      code: "QUOTA_EXCEEDED",
      retryable: false,
      scope: "user",
      reset_at: resetAt,
      retry_after_seconds: 60,
      used: 200,
      limit: 200,
    }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "60" },
    });
  };

  const run = () => __test.streamingRequestWithRelayFailover({
    credentialState: { relayManaged: true, apiKey: null, jwt: null, usageContext: null },
    buildProto: () => Buffer.from("request"),
    sleep: async () => {},
  });
  await assert.rejects(
    run(),
    (error) => error?.code === "QUOTA_EXCEEDED" &&
      error?.details?.retryable === false &&
      error?.details?.resetAt === resetAt &&
      error?.details?.used === 200 &&
      error?.details?.limit === 200,
  );
  await assert.rejects(run(), (error) => error?.code === "QUOTA_EXCEEDED");
  assert.equal(fetchCalls, 1, "cached quota failure called lease endpoint again");
});

test("relay upstream backoff waits once and retries the lease request", async (t) => {
  __test.resetRelayState();
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.YCE_RELAY_URL;
  const previousToken = process.env.YCE_RELAY_TOKEN;
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
  let fetchCalls = 0;
  const waits = [];
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        error: "upstream capacity is temporarily unavailable",
        code: "UPSTREAM_CAPACITY_BACKOFF",
        retryable: true,
        scope: "upstream",
        retry_after_seconds: 5,
      }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      });
    }
    return new Response(JSON.stringify({
      api_key: "key-after-backoff-secret-value-that-is-long-enough",
      key_id: "key-after-backoff",
      lease_id: "lease-after-backoff",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const leased = await __test.leaseApiKeyFromRelay({
    forceNew: true,
    sleep: async (delayMs) => waits.push(delayMs),
    random: () => 0,
  });
  assert.equal(leased, "key-after-backoff-secret-value-that-is-long-enough");
  assert.equal(fetchCalls, 2);
  assert.deepEqual(waits, [5000]);
});

test("classifyError preserves undici cause codes for diagnostics and retry decisions", () => {
  const reset = new TypeError("fetch failed");
  reset.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const classifiedReset = __test.classifyError(reset);
  assert.equal(classifiedReset.code, "NETWORK_ERROR");
  assert.equal(classifiedReset.details.cause, "ECONNRESET");
  assert.match(classifiedReset.message, /ECONNRESET/);

  const connectTimeout = new TypeError("fetch failed");
  connectTimeout.cause = Object.assign(new Error("connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  const classifiedTimeout = __test.classifyError(connectTimeout);
  assert.equal(classifiedTimeout.code, "TIMEOUT");
  assert.equal(classifiedTimeout.details.cause, "UND_ERR_CONNECT_TIMEOUT");
});

test("unary requests retry once on transient network errors but never on 4xx", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    if (networkCalls === 1) {
      const err = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      throw err;
    }
    return new Response(Buffer.from("ok"), { status: 200 });
  };
  const data = await __test.unaryRequest("https://relay.invalid/yce/auth/GetUserJwt", Buffer.from("req"), false, null);
  assert.equal(data.toString(), "ok");
  assert.equal(networkCalls, 2, "transient network error was not retried");

  let authCalls = 0;
  globalThis.fetch = async () => {
    authCalls += 1;
    return new Response("denied", { status: 401 });
  };
  await assert.rejects(
    __test.unaryRequest("https://relay.invalid/yce/auth/GetUserJwt", Buffer.from("req"), false, null),
    (error) => error?.code === "AUTH_ERROR",
  );
  assert.equal(authCalls, 1, "4xx must not retry");
});

test("persisted quota backoff blocks a fresh process until reset", async (t) => {
  __test.resetRelayState();
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.YCE_RELAY_URL;
  const previousToken = process.env.YCE_RELAY_TOKEN;
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
  const resetAt = new Date(Date.now() + 120_000).toISOString();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      error: "quota reached",
      code: "QUOTA_EXCEEDED",
      retryable: false,
      reset_at: resetAt,
    }), { status: 429, headers: { "content-type": "application/json" } });
  };

  const first = await __test.leaseApiKeyFromRelay({ forceNew: true, sleep: async () => {} });
  assert.equal(first, null);
  assert.equal(fetchCalls, 1);

  // Simulate a fresh CLI process: in-memory windows cleared, state file kept.
  __test.setRelayStateFile(TEST_RELAY_STATE_FILE);
  const second = await __test.leaseApiKeyFromRelay({ forceNew: true, sleep: async () => {} });
  assert.equal(second, null, "persisted quota window should block without a network call");
  assert.equal(fetchCalls, 1, "fresh process re-hit the relay despite persisted quota window");
});

test("lease reuse is server-capability opt-in with env overrides, call budget and expiry", (t) => {
  const previous = process.env.YCE_LEASE_REUSE;
  t.after(() => {
    if (previous === undefined) delete process.env.YCE_LEASE_REUSE;
    else process.env.YCE_LEASE_REUSE = previous;
  });
  const future = new Date(Date.now() + 120_000).toISOString();
  const nearExpiry = new Date(Date.now() + 5_000).toISOString();

  delete process.env.YCE_LEASE_REUSE;
  assert.equal(
    __test.leaseReusable({ leaseExpiresAt: future }),
    false,
    "no server capability field → reuse must stay OFF (old/production servers bill per lease)",
  );
  assert.equal(
    __test.leaseReusable({ leaseExpiresAt: future, serverAllowsReuse: true }),
    true,
    "server lease_reusable:true enables reuse",
  );
  assert.equal(__test.leaseReusable({ leaseExpiresAt: nearExpiry, serverAllowsReuse: true }), false);
  assert.equal(__test.leaseReusable({ leaseExpiresAt: "", serverAllowsReuse: true }), false, "unknown expiry must not be reused");
  assert.equal(__test.leaseReusable({ serverAllowsReuse: true }), false);
  assert.equal(
    __test.leaseReusable({ leaseExpiresAt: future, serverAllowsReuse: false }),
    false,
    "server veto must disable reuse",
  );
  // Budget uses max(success calls, attempts) against server limit minus retry headroom.
  assert.equal(
    __test.leaseReusable({ leaseExpiresAt: future, serverAllowsReuse: true, maxStreamCalls: 6, usageStats: { calls: 2 } }),
    false,
    "per-lease call budget (limit-headroom) must stop reuse",
  );
  assert.equal(
    __test.leaseReusable({ leaseExpiresAt: future, serverAllowsReuse: true, maxStreamCalls: 6, usageStats: { calls: 1 } }),
    true,
  );
  assert.equal(
    __test.leaseReusable({ leaseExpiresAt: future, serverAllowsReuse: true, maxStreamCalls: 6, usageStats: { calls: 1 }, attempts: 2 }),
    false,
    "attempts (retries included) count against the budget like the server does",
  );

  process.env.YCE_LEASE_REUSE = "1";
  assert.equal(
    __test.leaseReusable({ leaseExpiresAt: future }),
    true,
    "YCE_LEASE_REUSE=1 forces reuse for testing",
  );

  process.env.YCE_LEASE_REUSE = "0";
  assert.equal(
    __test.leaseReusable({ leaseExpiresAt: future, serverAllowsReuse: true }),
    false,
    "kill switch must restore lease-per-call",
  );
});

test("successful call keeps a reusable lease so the next turn skips re-leasing", async (t) => {
  const previous = process.env.YCE_LEASE_REUSE;
  delete process.env.YCE_LEASE_REUSE;
  t.after(() => {
    if (previous === undefined) delete process.env.YCE_LEASE_REUSE;
    else process.env.YCE_LEASE_REUSE = previous;
  });
  const state = {
    relayManaged: true,
    apiKey: null,
    jwt: null,
    usageContext: null,
  };
  let leaseCalls = 0;
  const leaseCredential = async () => {
    leaseCalls += 1;
    return {
      apiKey: "key-one-secret-value-that-is-long-enough",
      keyId: "key-1",
      leaseId: "lease-1",
      relayUrl: "https://relay.invalid",
      relayToken: "token",
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      leaseReusable: true,
    };
  };
  const run = () => __test.streamingRequestWithRelayFailover({
    credentialState: state,
    buildProto: () => Buffer.from("request"),
    leaseCredential,
    getJwt: async () => "jwt-one",
    request: async () => Buffer.from("ok"),
    sleep: async () => {},
    random: () => 0,
  });

  await run();
  assert.equal(leaseCalls, 1);
  assert.equal(state.usageContext?.leaseId, "lease-1", "reusable lease was cleared");

  await run();
  assert.equal(leaseCalls, 1, "second call re-leased despite valid lease");
});

test("usage is a lease-scoped receipt: accumulated calls report once on release", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const reports = [];
  globalThis.fetch = async (_url, init) => {
    reports.push({ body: JSON.parse(String(init?.body || "{}")) });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const usageContext = {
    keyId: "key-1",
    leaseId: "lease-1",
    relayUrl: "https://relay.invalid",
    relayToken: "token",
  };
  __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 1200 });
  __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 800 });
  __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 500 });
  assert.equal(reports.length, 0, "accumulation must not send any network report");

  const state = { relayManaged: true, apiKey: "k", jwt: "j", usageContext };
  __test.clearRelayCredentialState(state);
  await __test.flushUsageReports();

  assert.equal(reports.length, 1, "release must send exactly one receipt per lease");
  assert.equal(reports[0].body.lease_id, "lease-1");
  assert.equal(reports[0].body.status_code, 200);
  assert.equal(reports[0].body.duration_ms, 2500);

  // Releasing again must not double-report.
  __test.releaseLeaseUsage(usageContext);
  await __test.flushUsageReports();
  assert.equal(reports.length, 1, "double release sent a second receipt");
});

test("error-path receipt marks the lease so release does not double-report", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const reports = [];
  globalThis.fetch = async (_url, init) => {
    reports.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const usageContext = {
    keyId: "key-1",
    leaseId: "lease-err",
    relayUrl: "https://relay.invalid",
    relayToken: "token",
  };
  __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 300 });
  await __test.reportLeaseFailure(usageContext, { statusCode: 503, errorMessage: "boom" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status_code, 503);

  __test.releaseLeaseUsage(usageContext);
  await __test.flushUsageReports();
  assert.equal(reports.length, 1, "release after failure receipt double-reported");
});

test("a lease that served no calls sends no receipt on release", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let reportCalls = 0;
  globalThis.fetch = async () => {
    reportCalls += 1;
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const usageContext = {
    keyId: "key-1",
    leaseId: "lease-unused",
    relayUrl: "https://relay.invalid",
    relayToken: "token",
  };
  __test.releaseLeaseUsage(usageContext);
  await __test.flushUsageReports();
  assert.equal(reportCalls, 0, "unused lease should not emit a usage receipt");
});

test("structured relay 401 is preserved in per-call usage instead of blaming the upstream key", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const reports = [];
  let streamCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/yce/usage")) {
      reports.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    streamCalls += 1;
    return new Response(JSON.stringify({
      error: "lease stream call limit reached; acquire a new lease",
      code: "LEASE_CALL_LIMIT",
      source: "relay",
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  const usageContext = {
    keyId: "key-1",
    leaseId: "lease-1",
    relayUrl: "https://relay.invalid",
    relayToken: "token",
    usageMode: "per_call_v1",
  };

  await assert.rejects(
    __test.streamingRequest(Buffer.from("request"), 1000, 0, usageContext),
    (error) => error?.code === "AUTH_ERROR" &&
      error?.details?.relayCode === "LEASE_CALL_LIMIT" &&
      error?.details?.errorSource === "relay",
  );
  assert.equal(streamCalls, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].event, "code_search_call");
  assert.equal(reports[0].call_seq, 1);
  assert.equal(reports[0].error_code, "LEASE_CALL_LIMIT");
  assert.equal(reports[0].error_source, "relay");
});

test("usage requires a 2xx acknowledgement and retries transient 5xx responses", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return new Response(JSON.stringify({ error: "temporary failure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const usageContext = {
    keyId: "key-1",
    leaseId: "lease-retry",
    relayUrl: "https://relay.invalid",
    relayToken: "token",
  };
  __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 100 });
  __test.releaseLeaseUsage(usageContext);
  await __test.flushUsageReports();
  assert.equal(calls, 3);
  assert.equal(usageContext.usageReported, true);
  assert.equal(usageContext.lastUsageError, "");
});

test("per-call mode keeps mixed outcomes and releases the lease separately", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const reports = [];
  globalThis.fetch = async (_url, init) => {
    reports.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const usageContext = {
    keyId: "key-1",
    leaseId: "lease-mixed",
    relayUrl: "https://relay.invalid",
    relayToken: "token",
    usageMode: "per_call_v1",
  };
  __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 300 });
  __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 400 });
  await __test.reportLeaseFailure(usageContext, {
    statusCode: 503,
    errorMessage: "upstream unavailable",
    durationMs: 500,
  });
  const state = { relayManaged: true, apiKey: "k", jwt: "j", usageContext };
  __test.clearRelayCredentialState(state);
  await __test.flushUsageReports();

  assert.deepEqual(reports.map((report) => report.event), [
    "code_search_call",
    "code_search_call",
    "code_search_call",
    "lease_release",
  ]);
  assert.deepEqual(reports.slice(0, 3).map((report) => report.call_seq), [1, 2, 3]);
  assert.deepEqual(reports.slice(0, 3).map((report) => report.status_code), [200, 200, 503]);
  assert.equal(usageContext.usageStats.successCalls, 2);
  assert.equal(usageContext.usageStats.failureCalls, 1);
  assert.equal(usageContext.usageStats.totalDurationMs, 1200);
});

test("stale reused lease heals via one re-lease instead of failing the search", async (t) => {
  const previous = process.env.YCE_LEASE_REUSE;
  delete process.env.YCE_LEASE_REUSE;
  t.after(() => {
    if (previous === undefined) delete process.env.YCE_LEASE_REUSE;
    else process.env.YCE_LEASE_REUSE = previous;
  });

  const state = { relayManaged: true, apiKey: null, jwt: null, usageContext: null };
  let leaseCalls = 0;
  const leaseCredential = async () => {
    leaseCalls += 1;
    return {
      apiKey: `key-${leaseCalls}-secret-value-that-is-long-enough`,
      keyId: `key-${leaseCalls}`,
      leaseId: `lease-${leaseCalls}`,
      relayUrl: "https://relay.invalid",
      relayToken: "token",
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      leaseReusable: true,
    };
  };
  let requests = 0;
  const request = async (_proto, _timeout, _retries, usageContext) => {
    requests += 1;
    // Simulate server-side lease revocation on the second call of lease-1.
    if (usageContext.leaseId === "lease-1" && (usageContext.usageStats?.calls || 0) > 0) {
      throw new __test.YceEngineError("lease stream call limit reached", "AUTH_ERROR", {
        status: 401,
        relayCode: "LEASE_CALL_LIMIT",
        errorSource: "relay",
      });
    }
    __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 100 });
    return Buffer.from("ok");
  };
  const run = () => __test.streamingRequestWithRelayFailover({
    credentialState: state,
    buildProto: () => Buffer.from("request"),
    leaseCredential,
    getJwt: async () => "jwt",
    request,
    sleep: async () => {},
    random: () => 0,
  });

  await run(); // lease-1, call 1 ok, lease kept
  assert.equal(state.usageContext?.leaseId, "lease-1");
  const second = await run(); // lease-1 revoked → heal with lease-2
  assert.equal(second.toString(), "ok");
  assert.equal(leaseCalls, 2, "stale lease should trigger exactly one re-lease");
  assert.equal(state.usageContext?.leaseId, "lease-2", "healed lease should be kept for the next turn");
});

test("structured relay lease error heals once even before the first stream succeeds", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  t.after(async () => {
    await __test.flushUsageReports();
    globalThis.fetch = previousFetch;
  });
  const state = { relayManaged: true, apiKey: null, jwt: null, usageContext: null };
  let leaseCalls = 0;
  const leaseCredential = async () => {
    leaseCalls += 1;
    return {
      apiKey: `key-${leaseCalls}-secret-value-that-is-long-enough`,
      keyId: `key-${leaseCalls}`,
      leaseId: `lease-${leaseCalls}`,
      relayUrl: "https://relay.invalid",
      relayToken: "token",
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      leaseReusable: true,
      usageMode: "per_call_v1",
    };
  };
  const result = await __test.streamingRequestWithRelayFailover({
    credentialState: state,
    buildProto: () => Buffer.from("request"),
    leaseCredential,
    getJwt: async () => "jwt",
    request: async (_proto, _timeout, _retries, usageContext) => {
      if (usageContext.leaseId === "lease-1") {
        throw new __test.YceEngineError("invalid or expired lease", "AUTH_ERROR", {
          status: 401,
          relayCode: "LEASE_INVALID",
          errorSource: "relay",
        });
      }
      __test.accumulateLeaseUsage(usageContext, { statusCode: 200, durationMs: 100 });
      return Buffer.from("ok");
    },
    sleep: async () => {},
    random: () => 0,
  });
  assert.equal(result.toString(), "ok");
  assert.equal(leaseCalls, 2);
  assert.equal(state.usageContext?.leaseId, "lease-2");
});

test("first-call AUTH_ERROR on a fresh lease still fails fast (no heal loop)", async (t) => {
  const previous = process.env.YCE_LEASE_REUSE;
  delete process.env.YCE_LEASE_REUSE;
  t.after(() => {
    if (previous === undefined) delete process.env.YCE_LEASE_REUSE;
    else process.env.YCE_LEASE_REUSE = previous;
  });
  const state = { relayManaged: true, apiKey: null, jwt: null, usageContext: null };
  let leaseCalls = 0;
  await assert.rejects(
    __test.streamingRequestWithRelayFailover({
      credentialState: state,
      buildProto: () => Buffer.from("request"),
      leaseCredential: async () => {
        leaseCalls += 1;
        return {
          apiKey: "key-secret-value-that-is-long-enough",
          keyId: "key-1",
          leaseId: "lease-1",
          relayUrl: "https://relay.invalid",
          relayToken: "token",
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        };
      },
      getJwt: async () => "jwt",
      request: async () => {
        throw new __test.YceEngineError("HTTP 401", "AUTH_ERROR", { status: 401 });
      },
      sleep: async () => {},
      random: () => 0,
    }),
    (error) => error?.code === "AUTH_ERROR",
  );
  assert.equal(leaseCalls, 1, "fresh-lease auth failure must not re-lease");
});

test("concurrent relay leases retain their own key metadata", async (t) => {
  __test.resetRelayState();
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.YCE_RELAY_URL;
  const previousToken = process.env.YCE_RELAY_TOKEN;
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
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const current = call;
    if (current === 1) await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response(JSON.stringify({
      api_key: `key-${current}-secret-value-that-is-long-enough`,
      key_id: `key-${current}`,
      lease_id: `lease-${current}`,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const [first, second] = await Promise.all([
    __test.leaseRelayCredential({ retryAttempt: 0 }),
    __test.leaseRelayCredential({ retryAttempt: 0 }),
  ]);
  assert.equal(first.keyId, "key-1");
  assert.equal(first.leaseId, "lease-1");
  assert.equal(second.keyId, "key-2");
  assert.equal(second.leaseId, "lease-2");
});
