import test from "node:test";
import assert from "node:assert/strict";

import { __test } from "../lib/core.mjs";
import { connectFrameEncode } from "../lib/protobuf.mjs";

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

test("HTTP 429 exits same-key retries so the outer layer can switch keys", async (t) => {
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

test("authentication and payload errors never cross keys", async () => {
  for (const code of ["AUTH_ERROR", "PAYLOAD_TOO_LARGE", "TIMEOUT", "NETWORK_ERROR"]) {
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
