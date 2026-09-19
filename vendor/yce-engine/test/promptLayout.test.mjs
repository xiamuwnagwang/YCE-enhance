import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { search, __test } from "../lib/core.mjs";
import { connectFrameDecode, extractStrings } from "../lib/protobuf.mjs";

const TEST_RELAY_STATE_FILE = join(tmpdir(), `yce-test-prompt-state-${process.pid}.json`);
__test.setRelayStateFile(TEST_RELAY_STATE_FILE);
process.on("exit", () => {
  try { rmSync(TEST_RELAY_STATE_FILE, { force: true }); } catch {}
});

const QUERY = "select upstream key from the lease pool";

function makeFixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "yce-prompt-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal"));
  writeFileSync(join(root, "internal", "lease_scheduler.go"), [
    "package internal",
    "",
    "// SelectUpstreamKey picks a key from the lease pool for the next request.",
    "func SelectUpstreamKey(pool []string) string { return pool[0] }",
  ].join("\n"));
  writeFileSync(join(root, "internal", "lease.go"), "package internal\nfunc LeaseKey() string { return \"key\" }\n");
  return root;
}

// The request goes out as a gzipped Connect frame wrapping protobuf, so the
// prompt has to be read back the same way the engine writes it.
function decodeSentStrings(body) {
  const frames = connectFrameDecode(Buffer.from(body));
  return frames.flatMap((frame) => extractStrings(frame));
}

async function captureFirstRequest(t, root) {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/CheckUserMessageRateLimit")) return new Response(Buffer.alloc(0), { status: 200 });
    if (target.endsWith("/GetDevstralStream")) {
      sent.push(decodeSentStrings(init.body));
      // A non-retryable status ends the search after exactly one request.
      return new Response("upstream refused", { status: 400 });
    }
    throw new Error(`unexpected URL in prompt layout test: ${target}`);
  };
  await search({
    query: QUERY,
    projectRoot: root,
    apiKey: "fixture-api-key-long-enough-for-metadata",
    jwt: "fixture-jwt",
    maxTurns: 1,
    maxResults: 5,
    timeoutMs: 1000,
    noJevScreen: true,
  });
  assert.equal(sent.length, 1, "the search did not issue exactly one remote request");
  return sent[0];
}

test("verified leads are stated before the repo map, not after it", async (t) => {
  const strings = await captureFirstRequest(t, makeFixtureRepo(t));
  const userContent = strings.find((value) => value.includes("Problem Statement:"));
  assert.ok(userContent, "the problem statement never reached the request");

  const leadsAt = userContent.indexOf("# Local Prerank Verification Leads");
  const repoMapAt = userContent.indexOf("Repo Map (tree -L");
  assert.ok(leadsAt >= 0, "the local prerank leads were not sent");
  assert.ok(repoMapAt >= 0, "the repo map was not sent");
  assert.ok(leadsAt < repoMapAt, "the leads must precede the repo map");
  assert.match(userContent, /internal\/lease_scheduler\.go \(L\d+-\d+\)/);
});

test("the candidate paths are sent once, not also as a BM25F path spine list", async (t) => {
  const strings = await captureFirstRequest(t, makeFixtureRepo(t));
  const userContent = strings.find((value) => value.includes("Problem Statement:"));
  assert.doesNotMatch(userContent, /Relevant File Paths \(from BM25F path spine extraction\)/);
  const occurrences = userContent.split("/codebase/internal/lease_scheduler.go").length - 1;
  assert.equal(occurrences, 1, "the same candidate path was listed twice in one prompt");
});

test("the system prompt tells the model to read the verified leads first", async (t) => {
  const strings = await captureFirstRequest(t, makeFixtureRepo(t));
  const systemPrompt = strings.find((value) => value.includes("# THINKING RULES"));
  assert.ok(systemPrompt, "the system prompt never reached the request");
  assert.match(systemPrompt, /# VERIFIED LEADS FIRST/);
  assert.match(systemPrompt, /READ THEM FIRST/);
  assert.ok(
    systemPrompt.indexOf("# VERIFIED LEADS FIRST") < systemPrompt.indexOf("# SOME EXAMPLES OF WORKFLOWS"),
    "the leads rule must come before the MAP/ANCHOR/TRACE workflow it overrides",
  );
});
