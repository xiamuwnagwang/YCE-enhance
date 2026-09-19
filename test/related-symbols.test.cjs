"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const validator = join(repoRoot, "scripts", "validate-yce-result.mjs");
const {
  buildRelatedSymbols,
  extractCandidateSymbols,
} = require("../scripts/lib/codeContext");
const { runYceEngineSearch } = require("../scripts/lib/adapters/yceEngineSearch");

function mktemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(args, env) {
  return spawnSync(process.execPath, ["scripts/yce.js", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      YCE_DISABLE_UPDATE_CHECK: "1",
      YCE_RELAY_TOKEN: "",
      ...(env || {}),
    },
  });
}

function validateResult(resultPath) {
  const checked = spawnSync(process.execPath, [validator, resultPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  return JSON.parse(checked.stdout);
}

function writeFixtureEngine(dir, files) {
  const engine = join(dir, "fake-engine.js");
  writeFileSync(
    engine,
    [
      "const files = " + JSON.stringify(files) + ";",
      "const payload = { success: true, output: 'Found ' + files.length + ' relevant files.', result_present: true, empty_result: false, files, grep_patterns: [], diagnostics: {}, error: null };",
      "if (process.argv.includes('--json')) console.log(JSON.stringify(payload));",
      "else console.log(payload.output);",
    ].join("\n"),
  );
  return engine;
}

test("CLI: <related-symbols> surfaces referenced-but-not-shown declarations and excludes in-snippet definitions", () => {
  const fixtureDir = mktemp("yce-related-symbols-cli-");
  try {
    const helperPath = join(fixtureDir, "helper.js");
    writeFileSync(
      helperPath,
      "function helperFunction(x) {\n  return x + 1;\n}\nmodule.exports = { helperFunction };\n",
    );
    const targetPath = join(fixtureDir, "target.js");
    writeFileSync(
      targetPath,
      [
        "const { helperFunction } = require('./helper');",
        "",
        "function localDefined(x) {",
        "  return helperFunction(x) * 2;",
        "}",
        "",
        "function useLocalDefined(x) {",
        "  return localDefined(x) + helperFunction(x);",
        "}",
        "",
        "module.exports = { useLocalDefined };",
        "",
      ].join("\n"),
    );

    const engine = writeFixtureEngine(fixtureDir, [{ path: targetPath, ranges: [[1, 11]] }]);
    const resultPath = join(fixtureDir, "result.xml");
    const cli = runCli(
      ["Locate target", "--mode", "search", "--cwd", fixtureDir, "--out", resultPath],
      { YCE_ENGINE_SCRIPT: engine },
    );
    assert.equal(cli.status, 0, cli.stderr);
    validateResult(resultPath);
    const xml = readFileSync(resultPath, "utf8");

    assert.match(xml, /<related-symbols>/);
    assert.match(xml, /<symbol name="helperFunction" path="helper\.js" line="1" kind="function"\/>/);
    // Symbols already declared inside the shown snippet must never appear.
    assert.doesNotMatch(xml, /name="localDefined"/);
    assert.doesNotMatch(xml, /name="useLocalDefined"/);

    const noContextPath = join(fixtureDir, "no-context.xml");
    const noContext = runCli(
      ["Locate target", "--mode", "search", "--cwd", fixtureDir, "--out", noContextPath, "--no-context"],
      { YCE_ENGINE_SCRIPT: engine },
    );
    assert.equal(noContext.status, 0, noContext.stderr);
    validateResult(noContextPath);
    // No <code-context> means no snippet body to mine identifiers from.
    assert.doesNotMatch(readFileSync(noContextPath, "utf8"), /<related-symbols\b/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("extractCandidateSymbols: ranks by reference count, drops sub-4-char tokens and in-snippet definitions", () => {
  const codeContext = {
    files: [
      {
        path: "a.ts",
        content: [
          "function knownThing() {}",
          "abc abc abc",
          "widgetCount widgetCount widgetCount",
          "widgetCount",
          "gizmoTotal gizmoTotal",
          "knownThing knownThing",
        ].join("\n"),
      },
    ],
  };

  const candidates = extractCandidateSymbols(codeContext);
  const names = candidates.map((candidate) => candidate.name);

  assert.equal(names.includes("abc"), false, "3-char tokens are below the length-4 floor");
  assert.equal(names.includes("knownThing"), false, "declared inside the shown snippet, must be excluded");
  assert.deepEqual(names.slice(0, 2), ["widgetCount", "gizmoTotal"], "sorted by reference count descending");
});

test("buildRelatedSymbols: caps at 8 entries even when more candidates qualify", () => {
  const fixtureDir = mktemp("yce-related-symbols-cap-");
  try {
    const lines = [];
    for (let index = 0; index < 10; index += 1) {
      const declDir = join(fixtureDir, `decl${index}`);
      mkdirSync(declDir, { recursive: true });
      writeFileSync(join(declDir, "decl.js"), `function candidateSym${index}() {}\n`);
      // Higher index -> referenced fewer times, so sym0..sym7 must win the cap.
      const repeats = 10 - index;
      lines.push(Array.from({ length: repeats }, () => `candidateSym${index}`).join(" "));
    }
    const codeContext = { files: [{ path: "target.js", content: lines.join("\n") }] };

    const result = buildRelatedSymbols(codeContext, { projectRoot: fixtureDir });
    assert.ok(result);
    assert.ok(result.symbols.length <= 8, "must never exceed the 8-entry cap");
    const names = result.symbols.map((symbol) => symbol.name);
    assert.deepEqual(names, ["candidateSym0", "candidateSym1", "candidateSym2", "candidateSym3", "candidateSym4", "candidateSym5", "candidateSym6", "candidateSym7"]);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("buildRelatedSymbols: drops symbols declared in more than 15 files (generic-symbol fanout guard)", () => {
  const fixtureDir = mktemp("yce-related-symbols-fanout-");
  try {
    for (let index = 0; index < 16; index += 1) {
      const declDir = join(fixtureDir, `common${index}`);
      mkdirSync(declDir, { recursive: true });
      writeFileSync(join(declDir, "decl.js"), "function commonSymbolName() {}\n");
    }
    const rareDir = join(fixtureDir, "rare");
    mkdirSync(rareDir, { recursive: true });
    writeFileSync(join(rareDir, "decl.js"), "function rareSymbolName() {}\n");

    const codeContext = {
      files: [{
        path: "target.js",
        content: "commonSymbolName commonSymbolName rareSymbolName rareSymbolName",
      }],
    };

    const result = buildRelatedSymbols(codeContext, { projectRoot: fixtureDir });
    assert.ok(result);
    const names = result.symbols.map((symbol) => symbol.name);
    assert.equal(names.includes("commonSymbolName"), false, "declared in 16 files, must be dropped as too generic");
    assert.equal(names.includes("rareSymbolName"), true, "declared in exactly 1 file, must survive");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("buildRelatedSymbols: returns null when there is no snippet body to mine", () => {
  assert.equal(buildRelatedSymbols(null), null);
  assert.equal(buildRelatedSymbols({ files: [] }), null);
  assert.equal(buildRelatedSymbols({ files: [{ path: "a.js" }] }), null);
});

test("cache-hit parity: related-symbols extraction works identically on a cache-served code_context", async () => {
  const fixtureDir = mktemp("yce-related-symbols-cache-");
  const cacheDir = mktemp("yce-related-symbols-cache-dir-");
  try {
    const helperPath = join(fixtureDir, "helper.js");
    writeFileSync(
      helperPath,
      "function helperFunction(x) {\n  return x + 1;\n}\nmodule.exports = { helperFunction };\n",
    );
    const targetPath = join(fixtureDir, "target.js");
    writeFileSync(
      targetPath,
      "const { helperFunction } = require('./helper');\nmodule.exports = { call: () => helperFunction(1) };\n",
    );

    const engine = writeFixtureEngine(fixtureDir, [{ path: targetPath, ranges: [[1, 2]] }]);
    const args = {
      query: "locate target",
      cwd: fixtureDir,
      scriptPath: engine,
      timeoutMs: 5000,
      maxResults: 10,
      maxTurns: 3,
      bootstrapMode: "local",
      codeContextEnabled: true,
      codeContextMaxTokens: 2000,
      env: { YCE_SEARCH_CACHE_DIR: cacheDir },
    };

    const first = await runYceEngineSearch(args);
    assert.equal(first.search.diagnostics.cache_hit, false);
    const firstRelated = buildRelatedSymbols(first.search.code_context, { projectRoot: fixtureDir });
    assert.ok(firstRelated);
    assert.equal(firstRelated.symbols[0].name, "helperFunction");

    const second = await runYceEngineSearch(args);
    assert.equal(second.search.diagnostics.cache_hit, true, "second identical call must be served from cache");
    const secondRelated = buildRelatedSymbols(second.search.code_context, { projectRoot: fixtureDir });
    assert.ok(secondRelated, "related-symbols extraction must also work on a cache-served code_context");
    assert.deepEqual(secondRelated.symbols, firstRelated.symbols);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
