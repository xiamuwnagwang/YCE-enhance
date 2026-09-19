"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdtempSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const validator = join(repoRoot, "scripts", "validate-yce-result.mjs");
const { runYceEngineSearch } = require("../scripts/lib/adapters/yceEngineSearch");
const {
  CACHE_REVISION,
  DEFAULT_TTL_MS,
  buildCacheKey,
  computeFingerprint,
  readCacheEntry,
  resolveCacheConfig,
  unquoteGitPath,
  writeCacheEntry,
} = require("../scripts/lib/searchCache");

function mktemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitInit(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function gitCommitAll(dir, message) {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

/**
 * A fake yce-engine that supports the same --json contract the real one
 * does, plus a few env-driven knobs the tests need: a call counter (proves
 * whether the cache actually skipped the spawn) and a switchable failure
 * mode (proves dirty results never get cached).
 */
function writeFakeEngine(dir) {
  const engine = join(dir, "fake-engine.js");
  writeFileSync(
    engine,
    [
      "const fs = require('fs');",
      "const mode = process.env.FAKE_ENGINE_MODE || 'success';",
      "const counterPath = process.env.FAKE_ENGINE_COUNTER;",
      "if (counterPath) {",
      "  let n = 0;",
      "  try { n = parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0; } catch {}",
      "  fs.writeFileSync(counterPath, String(n + 1));",
      "}",
      "if (mode === 'timeout') { setTimeout(() => {}, 60000); return; }",
      "if (mode === 'error') { process.stderr.write('Error: fake engine exploded\\n'); process.exit(2); }",
      "if (mode === 'empty') {",
      "  const payload = { success: true, output: 'Found 0 relevant files.', result_present: false, empty_result: true, files: [], grep_patterns: [], diagnostics: {}, error: null };",
      "  console.log(JSON.stringify(payload));",
      "  process.exit(0);",
      "}",
      "const files = JSON.parse(process.env.FAKE_ENGINE_FILES || '[]');",
      "const diagnostics = { source: 'fake' };",
      "if (process.env.FAKE_ENGINE_JEV === '1') {",
      "  diagnostics.jev_screen_attempted = true;",
      "  diagnostics.jev_screen_success = true;",
      "  diagnostics.jev_screen_elapsed_ms = 417;",
      "  diagnostics.jev_screen_input_tokens = 1200;",
      "  diagnostics.jev_screen_output_tokens = 34;",
      "  diagnostics.jev_screen_top_probability = 0.91;",
      "  diagnostics.jev_screen_skip_reason = null;",
      "  diagnostics.jev_key_source = 'pool';",
      "  diagnostics.jev_key_id = 'key-abc';",
      "  diagnostics.jev_screen_entitled = true;",
      "}",
      "const payload = { success: true, output: 'Found ' + files.length + ' relevant files.', result_present: true, empty_result: false, files, grep_patterns: ['needle'], diagnostics, error: null };",
      "if (process.argv.includes('--json')) console.log(JSON.stringify(payload));",
      "else console.log(payload.output);",
    ].join("\n"),
  );
  return engine;
}

function counterValue(counterPath) {
  try {
    return parseInt(readFileSync(counterPath, "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

function baseSearchArgs({ cwd, scriptPath, cacheDir, env, timeoutMs }) {
  return {
    query: "locate fixture",
    cwd,
    scriptPath,
    timeoutMs: timeoutMs || 5000,
    maxResults: 10,
    maxTurns: 3,
    bootstrapMode: "local",
    codeContextEnabled: true,
    codeContextMaxTokens: 2000,
    env: {
      YCE_SEARCH_CACHE_DIR: cacheDir,
      ...env,
    },
  };
}

test("cache hit: second identical call skips the engine, reuses files/grep_patterns, stays under 500ms", async () => {
  const fixtureDir = mktemp("yce-cache-hit-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    gitInit(fixtureDir);
    const sourcePath = join(fixtureDir, "target.js");
    writeFileSync(sourcePath, "const marker = 'v1';\n".repeat(5));
    gitCommitAll(fixtureDir, "init");

    // The engine and its side-channel files must live outside fixtureDir:
    // fixtureDir IS the fingerprinted workspace, so writing a counter file
    // into it between calls would itself invalidate the cache.
    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");
    const env = {
      FAKE_ENGINE_COUNTER: counterPath,
      FAKE_ENGINE_FILES: JSON.stringify([{ path: sourcePath, ranges: [[1, 3]] }]),
    };

    const first = await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env }));
    assert.equal(first.search.result_present, true);
    assert.equal(first.search.diagnostics.cache_hit, false);
    assert.equal(counterValue(counterPath), 1);

    const second = await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env }));
    assert.equal(counterValue(counterPath), 1, "engine must not be re-invoked on a cache hit");
    assert.equal(second.search.diagnostics.cache_hit, true);
    assert.ok(second.durationMs < 500, `expected <500ms, got ${second.durationMs}`);
    assert.deepEqual(second.search.files, first.search.files);
    assert.deepEqual(second.search.grep_patterns, first.search.grep_patterns);
    assert.equal(typeof second.search.diagnostics.cache_fingerprint, "string");
    assert.ok(second.search.diagnostics.cache_age_ms >= 0);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("invalidation: tracked-file edit, new untracked file, and untracked-file content edit each force a miss", async () => {
  const fixtureDir = mktemp("yce-cache-invalidate-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    gitInit(fixtureDir);
    const trackedPath = join(fixtureDir, "tracked.js");
    writeFileSync(trackedPath, "const tracked = 1;\n");
    const scratchPath = join(fixtureDir, "scratch.txt");
    writeFileSync(scratchPath, "scratch v1\n");
    gitCommitAll(fixtureDir, "init");
    // scratch.txt is deliberately left untracked (not added) so its "??"
    // porcelain line never changes text even when its content does.

    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");
    const env = {
      FAKE_ENGINE_COUNTER: counterPath,
      FAKE_ENGINE_FILES: JSON.stringify([{ path: trackedPath, ranges: [[1, 1]] }]),
    };
    const args = () => baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env });

    const r1 = await runYceEngineSearch(args());
    assert.equal(r1.search.diagnostics.cache_hit, false);
    assert.equal(counterValue(counterPath), 1);

    const r2 = await runYceEngineSearch(args());
    assert.equal(r2.search.diagnostics.cache_hit, true);
    assert.equal(counterValue(counterPath), 1);

    // (1) modify a tracked file's content -> miss
    writeFileSync(trackedPath, "const tracked = 2;\n");
    const r3 = await runYceEngineSearch(args());
    assert.equal(r3.search.diagnostics.cache_hit, false, "tracked-file edit must invalidate");
    assert.equal(counterValue(counterPath), 2);

    const r4 = await runYceEngineSearch(args());
    assert.equal(r4.search.diagnostics.cache_hit, true);
    assert.equal(counterValue(counterPath), 2);

    // (2) add a new untracked file -> miss
    writeFileSync(join(fixtureDir, "brand-new.txt"), "new\n");
    const r5 = await runYceEngineSearch(args());
    assert.equal(r5.search.diagnostics.cache_hit, false, "new untracked file must invalidate");
    assert.equal(counterValue(counterPath), 3);

    const r6 = await runYceEngineSearch(args());
    assert.equal(r6.search.diagnostics.cache_hit, true);
    assert.equal(counterValue(counterPath), 3);

    // (3) only edit the content of an already-untracked file -> miss.
    // git status's "??" line for scratch.txt is identical before and after;
    // only the (size, mtime) supplement catches this.
    writeFileSync(scratchPath, "scratch v2, much longer than before\n");
    const r7 = await runYceEngineSearch(args());
    assert.equal(r7.search.diagnostics.cache_hit, false, "untracked-file content edit must invalidate");
    assert.equal(counterValue(counterPath), 4);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("code-context stays fresh: a cache hit still re-reads disk instead of replaying stale content", async () => {
  const fixtureDir = mktemp("yce-cache-fresh-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    // No git init: this is the plain (non-git) fingerprint path, which
    // walks the tree using the same skip-dir rules as localFastSearch.
    // Files under vendor/ are skipped by design, so editing one doesn't
    // change the fingerprint - which is exactly what this test exploits
    // to force a hit-with-changed-content scenario.
    mkdirSync(join(fixtureDir, "vendor"), { recursive: true });
    const vendorFile = join(fixtureDir, "vendor", "target.js");
    writeFileSync(vendorFile, "line-1\nline-2 ORIGINAL\nline-3\n");

    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");
    const env = {
      FAKE_ENGINE_COUNTER: counterPath,
      FAKE_ENGINE_FILES: JSON.stringify([{ path: vendorFile, ranges: [[1, 3]] }]),
    };
    const args = () => baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env });

    const first = await runYceEngineSearch(args());
    assert.equal(first.search.diagnostics.cache_hit, false);
    assert.match(first.search.code_context.files[0].content, /ORIGINAL/);

    writeFileSync(vendorFile, "line-1\nline-2 UPDATED\nline-3\n");

    const second = await runYceEngineSearch(args());
    assert.equal(second.search.diagnostics.cache_hit, true, "vendor/ is outside the fingerprint scope");
    assert.equal(counterValue(counterPath), 1, "engine must not run again");
    assert.match(
      second.search.code_context.files[0].content,
      /UPDATED/,
      "cache hit must serve freshly-read content, not the content captured at cache-write time",
    );
    assert.doesNotMatch(second.search.code_context.files[0].content, /ORIGINAL/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("switches: --no-cache equivalent (YCE_SEARCH_CACHE=off) and tiny TTL both force misses", async () => {
  const fixtureDir = mktemp("yce-cache-switch-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    gitInit(fixtureDir);
    const sourcePath = join(fixtureDir, "target.js");
    writeFileSync(sourcePath, "const marker = 1;\n");
    gitCommitAll(fixtureDir, "init");

    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");
    const fixtureEnv = {
      FAKE_ENGINE_COUNTER: counterPath,
      FAKE_ENGINE_FILES: JSON.stringify([{ path: sourcePath, ranges: [[1, 1]] }]),
    };

    // YCE_SEARCH_CACHE=off: both calls must invoke the engine.
    const offEnv = { ...fixtureEnv, YCE_SEARCH_CACHE: "off" };
    const off1 = await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env: offEnv }));
    assert.equal((off1.search.diagnostics || {}).cache_hit, undefined, "cache diagnostics must not appear while disabled");
    assert.equal(counterValue(counterPath), 1);
    const off2 = await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env: offEnv }));
    assert.equal((off2.search.diagnostics || {}).cache_hit, undefined, "cache diagnostics must not appear while disabled");
    assert.equal(counterValue(counterPath), 2, "cache disabled: second call must still invoke the engine");

    // Tiny TTL: first call populates the cache dir, second call (after the
    // TTL elapses) must find the entry expired and re-invoke the engine.
    writeFileSync(counterPath, "0");
    const ttlCacheDir = mktemp("yce-cache-ttl-");
    const ttlEnv = { ...fixtureEnv, YCE_SEARCH_CACHE_TTL_MS: "40" };
    const ttl1 = await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir: ttlCacheDir, env: ttlEnv }));
    assert.equal(ttl1.search.diagnostics.cache_hit, false);
    assert.equal(counterValue(counterPath), 1);
    await new Promise((r) => setTimeout(r, 120));
    const ttl2 = await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir: ttlCacheDir, env: ttlEnv }));
    assert.equal(ttl2.search.diagnostics.cache_hit, false, "expired entry must not be served");
    assert.equal(counterValue(counterPath), 2, "expired entry: engine must run again");
    rmSync(ttlCacheDir, { recursive: true, force: true });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("dirty results are never cached: engine error, empty result, and timeout all re-run on the next call", async () => {
  const fixtureDir = mktemp("yce-cache-dirty-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    gitInit(fixtureDir);
    writeFileSync(join(fixtureDir, "target.js"), "const marker = 1;\n");
    gitCommitAll(fixtureDir, "init");

    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");

    // (1) engine reports an error (non-zero exit, no success payload).
    const errorEnv = { FAKE_ENGINE_COUNTER: counterPath, FAKE_ENGINE_MODE: "error" };
    await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env: errorEnv }));
    assert.equal(counterValue(counterPath), 1);
    const errorAgain = await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env: errorEnv }));
    assert.equal(counterValue(counterPath), 2, "error result must not have been cached");
    assert.notEqual(errorAgain.search.diagnostics && errorAgain.search.diagnostics.cache_hit, true);

    // (2) empty_result=true.
    writeFileSync(counterPath, "0");
    const emptyEnv = { FAKE_ENGINE_COUNTER: counterPath, FAKE_ENGINE_MODE: "empty" };
    await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env: emptyEnv }));
    assert.equal(counterValue(counterPath), 1);
    await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env: emptyEnv }));
    assert.equal(counterValue(counterPath), 2, "empty result must not have been cached");

    // (3) timeout: engine hangs past the timeout budget, killed with a partial run.
    writeFileSync(counterPath, "0");
    const timeoutEnv = { FAKE_ENGINE_COUNTER: counterPath, FAKE_ENGINE_MODE: "timeout" };
    await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env: timeoutEnv, timeoutMs: 200 }));
    assert.equal(counterValue(counterPath), 1);
    await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env: timeoutEnv, timeoutMs: 200 }));
    assert.equal(counterValue(counterPath), 2, "timed-out call must not have been cached");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bootstrap mode is part of the cache key: local and remote never collide", async () => {
  const fixtureDir = mktemp("yce-cache-bootstrap-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    gitInit(fixtureDir);
    const sourcePath = join(fixtureDir, "target.js");
    writeFileSync(sourcePath, "const marker = 1;\n");
    gitCommitAll(fixtureDir, "init");

    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");
    const env = {
      FAKE_ENGINE_COUNTER: counterPath,
      FAKE_ENGINE_FILES: JSON.stringify([{ path: sourcePath, ranges: [[1, 1]] }]),
    };

    const local1 = await runYceEngineSearch({ ...baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env }), bootstrapMode: "local" });
    assert.equal(local1.search.diagnostics.cache_hit, false);
    assert.equal(counterValue(counterPath), 1);

    const remote1 = await runYceEngineSearch({ ...baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env }), bootstrapMode: "remote" });
    assert.equal(remote1.search.diagnostics.cache_hit, false, "remote must not reuse local's cache entry");
    assert.equal(counterValue(counterPath), 2);

    const local2 = await runYceEngineSearch({ ...baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env }), bootstrapMode: "local" });
    assert.equal(local2.search.diagnostics.cache_hit, true);
    assert.equal(counterValue(counterPath), 2);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("retrieval params are part of the cache key: different --exclude sets never share an entry", async () => {
  const fixtureDir = mktemp("yce-cache-exclude-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    gitInit(fixtureDir);
    const sourcePath = join(fixtureDir, "target.js");
    writeFileSync(sourcePath, "const marker = 1;\n");
    gitCommitAll(fixtureDir, "init");

    // The fake engine ignores --exclude, so the call counter is the only
    // honest signal here: a hit means the key collapsed two different engine
    // invocations into one entry. Nothing may be written into fixtureDir
    // between calls or the fingerprint (not the key) would explain the miss.
    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");
    const env = {
      FAKE_ENGINE_COUNTER: counterPath,
      FAKE_ENGINE_FILES: JSON.stringify([{ path: sourcePath, ranges: [[1, 1]] }]),
    };
    const withExcludes = (excludePaths) => ({
      ...baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env }),
      excludePaths,
    });

    const a1 = await runYceEngineSearch(withExcludes(["vendor/**"]));
    assert.equal(a1.search.diagnostics.cache_hit, false);
    assert.equal(counterValue(counterPath), 1);

    const b1 = await runYceEngineSearch(withExcludes(["vendor/**", "dist/**"]));
    assert.equal(b1.search.diagnostics.cache_hit, false, "a wider exclude set must not reuse the narrower set's entry");
    assert.equal(counterValue(counterPath), 2);

    // Both entries survive side by side, and each re-hits on its own params.
    const a2 = await runYceEngineSearch(withExcludes(["vendor/**"]));
    assert.equal(a2.search.diagnostics.cache_hit, true, "the first exclude set must still hit");
    assert.equal(counterValue(counterPath), 2);

    const b2 = await runYceEngineSearch(withExcludes(["dist/**", "vendor/**"]));
    assert.equal(b2.search.diagnostics.cache_hit, true, "order must not matter: the key sorts the exclude set");
    assert.equal(counterValue(counterPath), 2);

    // --no-jev-screen changes what the engine does, so it changes the key too.
    const screened = await runYceEngineSearch({ ...withExcludes(["vendor/**"]), noJevScreen: true });
    assert.equal(screened.search.diagnostics.cache_hit, false, "--no-jev-screen must not reuse the screened entry");
    assert.equal(counterValue(counterPath), 3);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("cache hit never replays the cached run's jev screen as this run's behavior", async () => {
  const fixtureDir = mktemp("yce-cache-jev-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    gitInit(fixtureDir);
    const sourcePath = join(fixtureDir, "target.js");
    writeFileSync(sourcePath, "const marker = 1;\n");
    gitCommitAll(fixtureDir, "init");

    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");
    const env = {
      FAKE_ENGINE_COUNTER: counterPath,
      FAKE_ENGINE_JEV: "1",
      FAKE_ENGINE_FILES: JSON.stringify([{ path: sourcePath, ranges: [[1, 1]] }]),
    };
    const args = () => baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir, env });

    const miss = await runYceEngineSearch(args());
    assert.equal(miss.search.diagnostics.cache_hit, false);
    assert.equal(miss.search.diagnostics.jev_screen_attempted, true, "the real run does report its screen");
    assert.equal(miss.search.diagnostics.jev_screen_replayed, undefined, "a real run is not a replay");

    const hit = await runYceEngineSearch(args());
    assert.equal(hit.search.diagnostics.cache_hit, true);
    assert.equal(counterValue(counterPath), 1, "engine must not have run again");

    // No jev_* field may survive: this process ran no screen and made no
    // relay round trip, so it can assert neither behavior (attempted /
    // success / elapsed / tokens / skip-reason) nor observation
    // (key-source / key-id / entitled).
    const leaked = Object.keys(hit.search.diagnostics).filter(
      (key) => key.startsWith("jev_") && key !== "jev_screen_replayed",
    );
    assert.deepEqual(leaked, [], `cache hit leaked replayed jev fields: ${leaked.join(", ")}`);
    assert.equal(hit.search.diagnostics.jev_screen_replayed, true, "the hit must say the jev data came from an earlier run");
    // Non-jev diagnostics are still legitimately replayed.
    assert.equal(hit.search.diagnostics.source, "fake");

    // A cached run that never touched jev at all must not grow a replay marker.
    const plainCacheDir = mktemp("yce-cache-jev-plain-");
    const plainEnv = { ...env, FAKE_ENGINE_JEV: "0" };
    const plainArgs = () => baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir: plainCacheDir, env: plainEnv });
    await runYceEngineSearch(plainArgs());
    const plainHit = await runYceEngineSearch(plainArgs());
    assert.equal(plainHit.search.diagnostics.cache_hit, true);
    assert.equal(plainHit.search.diagnostics.jev_screen_replayed, undefined, "no jev data cached means no replay marker");
    rmSync(plainCacheDir, { recursive: true, force: true });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("searchCache module: fingerprint stability, key composition, and expiry sweep", () => {
  const gitDir = mktemp("yce-cache-fp-git-");
  const plainDir = mktemp("yce-cache-fp-plain-");
  const cacheDir = mktemp("yce-cache-dir-");
  try {
    gitInit(gitDir);
    writeFileSync(join(gitDir, "a.js"), "a\n");
    gitCommitAll(gitDir, "init");
    const fp1 = computeFingerprint(gitDir);
    const fp2 = computeFingerprint(gitDir);
    assert.equal(fp1.fingerprint, fp2.fingerprint);
    assert.equal(fp1.mode, "git");
    assert.ok(fp1.elapsedMs >= 0);

    writeFileSync(join(plainDir, "b.txt"), "b\n");
    const plainFp1 = computeFingerprint(plainDir);
    assert.equal(plainFp1.mode, "plain");
    writeFileSync(join(plainDir, "b.txt"), "b changed\n");
    const plainFp2 = computeFingerprint(plainDir);
    assert.notEqual(plainFp1.fingerprint, plainFp2.fingerprint);

    // resolveCacheConfig parsing.
    assert.equal(resolveCacheConfig({}).enabled, true);
    assert.equal(resolveCacheConfig({ YCE_SEARCH_CACHE: "off" }).enabled, false);
    assert.equal(resolveCacheConfig({ YCE_SEARCH_CACHE: "OFF" }).enabled, false);
    assert.equal(resolveCacheConfig({ YCE_SEARCH_CACHE_TTL_MS: "12345" }).ttlMs, 12345);

    // key composition: same params in, same key out; any engine-visible
    // param out, different key.
    const baseKeyArgs = {
      fingerprint: "fp", cwd: "/x", query: "q", maxResults: 10, maxTurns: 3, scriptPath: "/engine.mjs", bootstrapMode: "local",
    };
    const keyA = buildCacheKey(baseKeyArgs);
    const keyB = buildCacheKey({ ...baseKeyArgs, bootstrapMode: "remote" });
    const keyA2 = buildCacheKey({ ...baseKeyArgs });
    assert.notEqual(keyA, keyB);
    assert.equal(keyA, keyA2);

    // v2: the key covers every option the adapter turns into engine argv.
    // The key itself is a digest, so the revision is asserted through the
    // exported constant rather than by substring-matching the hash.
    assert.equal(CACHE_REVISION, "v2");
    const distinguishes = (patch, label) =>
      assert.notEqual(buildCacheKey({ ...baseKeyArgs, ...patch }), keyA, `${label} must change the key`);
    distinguishes({ excludePaths: ["vendor/**"] }, "excludePaths");
    distinguishes({ noJevScreen: true }, "noJevScreen");
    distinguishes({ maxCommands: 8 }, "maxCommands");
    distinguishes({ treeDepth: 2 }, "treeDepth");
    distinguishes({ repoMapMode: "bootstrap_hotspot" }, "repoMapMode");
    distinguishes({ bootstrapEnabled: false }, "bootstrapEnabled");
    distinguishes({ bootstrapTreeDepth: 2 }, "bootstrapTreeDepth");
    distinguishes({ hotspotTopK: 4 }, "hotspotTopK");
    distinguishes({ hotspotTreeDepth: 2 }, "hotspotTreeDepth");
    distinguishes({ hotspotMaxBytes: 65536 }, "hotspotMaxBytes");
    distinguishes({ bootstrapMaxTurns: 2 }, "bootstrapMaxTurns");
    distinguishes({ bootstrapMaxCommands: 9 }, "bootstrapMaxCommands");
    // 0 is a reachable argv value for both (min:0 in buildSearchOptions), so
    // it must not collapse into "unset" the way a truthiness test would.
    distinguishes({ treeDepth: 0 }, "treeDepth=0");
    distinguishes({ hotspotTopK: 0 }, "hotspotTopK=0");

    // Exclude sets are order- and duplicate-insensitive, but content-sensitive.
    const excludeKey = buildCacheKey({ ...baseKeyArgs, excludePaths: ["a/**", "b/**"] });
    assert.equal(excludeKey, buildCacheKey({ ...baseKeyArgs, excludePaths: ["b/**", "a/**", "a/**"] }));
    assert.notEqual(excludeKey, buildCacheKey({ ...baseKeyArgs, excludePaths: ["a/**"] }));

    // code-context knobs never reach the engine payload, so they stay out.
    assert.equal(keyA, buildCacheKey({ ...baseKeyArgs, codeContextEnabled: false, codeContextMaxTokens: 99 }));

    // TTL expiry on read: writeCacheEntry always stamps storedAt = now, so a
    // negative ttl is a reliable way to force "already expired" without
    // needing to fake the clock.
    writeCacheEntry(cacheDir, "stale-key", { files: [] }, 10000);
    const staleFile = join(cacheDir, "stale-key.json");
    assert.equal(readCacheEntry(cacheDir, "stale-key", -1), null, "expired entry must read as a miss");
    assert.equal(require("node:fs").existsSync(staleFile), false, "expired entry must be deleted on read");

    // Write-time sweep judges age by each file's mtime and each entry's own
    // recorded TTL, so backdating mtime with utimesSync is the right tool here.
    const past = Date.now() - 999999;
    writeCacheEntry(cacheDir, "stale-key-2", { files: [] }, 10000);
    const staleFile2 = join(cacheDir, "stale-key-2.json");
    require("node:fs").utimesSync(staleFile2, past / 1000, past / 1000);
    writeCacheEntry(cacheDir, "fresh-key", { files: [] }, 10000);
    assert.equal(require("node:fs").existsSync(staleFile2), false, "a write must sweep other expired entries too");
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("review regressions: non-ASCII paths invalidate, per-entry sweep TTL, TTL=0 fallback, staging residue", () => {
  const gitDir = mktemp("yce-cache-rev-git-");
  const cacheDir = mktemp("yce-cache-rev-dir-");
  try {
    gitInit(gitDir);
    // (P1-1) Quoted non-ASCII names must not defeat the fingerprint. The
    // tracked-modified case is the sneaky one: the porcelain line is
    // identical across content edits, so only the stat triple catches
    // the second edit.
    const cjkPath = join(gitDir, "文档.txt");
    writeFileSync(cjkPath, "v1\n");
    gitCommitAll(gitDir, "init");
    const fpClean = computeFingerprint(gitDir).fingerprint;
    writeFileSync(cjkPath, "v2\n");
    const fpEdit1 = computeFingerprint(gitDir).fingerprint;
    assert.notEqual(fpClean, fpEdit1, "first tracked non-ASCII edit must invalidate");
    writeFileSync(cjkPath, "v3, different length\n");
    assert.notEqual(
      fpEdit1,
      computeFingerprint(gitDir).fingerprint,
      "second tracked non-ASCII edit must invalidate too",
    );

    const cjkUntracked = join(gitDir, "未跟踪.txt");
    writeFileSync(cjkUntracked, "u1\n");
    const fpU1 = computeFingerprint(gitDir).fingerprint;
    writeFileSync(cjkUntracked, "u2\n");
    assert.notEqual(fpU1, computeFingerprint(gitDir).fingerprint, "untracked non-ASCII edit must invalidate");

    // (P1-1 defense) unquoteGitPath decodes octal UTF-8 byte runs into
    // real characters instead of leaving literal escapes behind.
    assert.equal(unquoteGitPath('"\\346\\226\\207.txt"'), "文.txt");
    assert.equal(unquoteGitPath("plain.txt"), "plain.txt");
    assert.equal(unquoteGitPath('"no\\tescapes\\nneeded"'), "no\tescapes\nneeded");

    // (P2-1) TTL=0 falls back to the default instead of meaning "expire
    // instantly and sweep everything written so far".
    assert.equal(resolveCacheConfig({ YCE_SEARCH_CACHE_TTL_MS: "0" }).ttlMs, DEFAULT_TTL_MS);
    assert.equal(resolveCacheConfig({ YCE_SEARCH_CACHE_TTL_MS: "-5" }).ttlMs, DEFAULT_TTL_MS);

    // (P2-2) A caller with a tiny TTL must not evict an entry written under
    // a long TTL; it still evicts its own expired entries.
    writeCacheEntry(cacheDir, "long-lived", { files: [1] }, DEFAULT_TTL_MS);
    writeCacheEntry(cacheDir, "short-lived", { files: [2] }, 1);
    const past = (Date.now() - 5000) / 1000;
    utimesSync(join(cacheDir, "short-lived.json"), past, past);
    writeCacheEntry(cacheDir, "trigger", { files: [3] }, 1); // sweeps with a 1ms caller TTL
    assert.equal(existsSync(join(cacheDir, "long-lived.json")), true, "long-TTL entry must survive a short-TTL caller's sweep");
    assert.equal(existsSync(join(cacheDir, "short-lived.json")), false, "expired short-TTL entry must be swept");

    // (P2-4) Staging residue from a crashed writer is swept by age (the
    // gate is 10 minutes so a live writer's in-flight staging file — which
    // lives for milliseconds — is never touched).
    const residue = join(cacheDir, ".stale.json.999.abcdef.tmp");
    writeFileSync(residue, "{}");
    const residueAge = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(residue, residueAge, residueAge);
    writeCacheEntry(cacheDir, "trigger-2", { files: [4] }, DEFAULT_TTL_MS);
    assert.equal(existsSync(residue), false, "old staging residue must be swept");
    assert.equal(existsSync(join(cacheDir, "long-lived.json")), true, "long-TTL entry must survive later sweeps too");
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("best-effort cache writes: an unwritable cache dir must not fail the search", async () => {
  const fixtureDir = mktemp("yce-cache-ro-fixture-");
  const roBase = mktemp("yce-cache-ro-base-");
  const stateDir = mktemp("yce-cache-ro-state-");
  try {
    gitInit(fixtureDir);
    const sourcePath = join(fixtureDir, "target.js");
    writeFileSync(sourcePath, "const marker = 1;\n");
    gitCommitAll(fixtureDir, "init");

    const engine = writeFakeEngine(stateDir);
    const counterPath = join(stateDir, "counter.txt");
    const roCacheDir = join(roBase, "cache");
    const env = {
      FAKE_ENGINE_COUNTER: counterPath,
      FAKE_ENGINE_FILES: JSON.stringify([{ path: sourcePath, ranges: [[1, 1]] }]),
      YCE_SEARCH_CACHE_DIR: roCacheDir,
    };
    chmodSync(roBase, 0o555); // mkdir inside will fail with EACCES
    try {
      // (P1-2) Module level: writing must swallow the error.
      writeCacheEntry(roCacheDir, "k", { files: [] }, 1000);

      // End to end: a successful search must still return its result.
      const result = await runYceEngineSearch(baseSearchArgs({ cwd: fixtureDir, scriptPath: engine, cacheDir: roCacheDir, env }));
      assert.equal(result.error, null);
      assert.equal(result.search.result_present, true, "the search itself must succeed");
      assert.equal(result.search.diagnostics.cache_hit, false);
      assert.equal(counterValue(counterPath), 1);
    } finally {
      chmodSync(roBase, 0o755);
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(roBase, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("CLI end-to-end: cache-hit/cache-age-ms/cache-fingerprint land in the XML and validate cleanly", () => {
  const fixtureDir = mktemp("yce-cache-cli-");
  const cacheDir = mktemp("yce-cache-dir-");
  const stateDir = mktemp("yce-cache-state-");
  try {
    gitInit(fixtureDir);
    const sourcePath = join(fixtureDir, "target.js");
    writeFileSync(sourcePath, "const marker = 1;\n");
    gitCommitAll(fixtureDir, "init");

    // Result files must land outside fixtureDir: fixtureDir is the
    // fingerprinted workspace, and --out would otherwise drop a new
    // untracked file into it after every run, invalidating the next one.
    const engine = writeFakeEngine(stateDir);
    const runCli = (extraArgs, extraEnv) =>
      spawnSync(
        process.execPath,
        ["scripts/yce.js", "locate fixture", "--mode", "search", "--cwd", fixtureDir, ...extraArgs],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            YCE_DISABLE_UPDATE_CHECK: "1",
            YCE_RELAY_TOKEN: "",
            YCE_ENGINE_SCRIPT: engine,
            YCE_SEARCH_CACHE_DIR: cacheDir,
            FAKE_ENGINE_JEV: "1",
            FAKE_ENGINE_FILES: JSON.stringify([{ path: sourcePath, ranges: [[1, 1]] }]),
            ...extraEnv,
          },
        },
      );
    const validate = (resultPath) => {
      const checked = spawnSync(process.execPath, [validator, resultPath], { cwd: repoRoot, encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    };
    const resultFileOf = (cli) => {
      const match = cli.stdout.match(/"result_file":\s*"([^"]+)"/);
      assert.ok(match, cli.stdout);
      return match[1];
    };

    const first = runCli(["--out", join(stateDir, "first.xml")]);
    assert.equal(first.status, 0, first.stderr);
    validate(resultFileOf(first));
    const firstXml = readFileSync(resultFileOf(first), "utf8");
    assert.match(firstXml, /<cache-hit>false<\/cache-hit>/);
    assert.match(firstXml, /<cache-fingerprint>[a-f0-9]{64}<\/cache-fingerprint>/);
    assert.match(firstXml, /<jev-screen-attempted>true<\/jev-screen-attempted>/, "a real run reports its own screen");

    const second = runCli(["--out", join(stateDir, "second.xml")]);
    assert.equal(second.status, 0, second.stderr);
    validate(resultFileOf(second));
    const secondXml = readFileSync(resultFileOf(second), "utf8");
    assert.match(secondXml, /<cache-hit>true<\/cache-hit>/);
    assert.match(secondXml, /<cache-age-ms>\d+<\/cache-age-ms>/);
    // The served XML must not let a reader think this run screened anything.
    assert.doesNotMatch(secondXml, /<jev-screen-attempted>/, "a hit must not replay the cached run's jev attempt");
    assert.doesNotMatch(secondXml, /<jev-key-source>/);
    assert.doesNotMatch(secondXml, /<jev-screen-entitled>/);
    assert.match(secondXml, /<jev-screen-replayed>true<\/jev-screen-replayed>/);
    const durationMatch = secondXml.match(/<durations-ms>[\s\S]*?<search>(\d+)<\/search>/);
    assert.ok(durationMatch, secondXml);
    assert.ok(Number(durationMatch[1]) < 500, `expected <500ms, got ${durationMatch[1]}`);

    const noCache = runCli(["--out", join(stateDir, "third.xml"), "--no-cache"]);
    assert.equal(noCache.status, 0, noCache.stderr);
    validate(resultFileOf(noCache));
    const noCacheXml = readFileSync(resultFileOf(noCache), "utf8");
    assert.doesNotMatch(noCacheXml, /<cache-hit>/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
