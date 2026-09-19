const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const validator = join(repoRoot, "scripts", "validate-yce-result.mjs");
const { buildCodeContext } = require("../scripts/lib/codeContext");

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

function writeFixtureEngine(dir, targetPath) {
  const engine = join(dir, "fake-engine.js");
  writeFileSync(
    engine,
    [
      "const target = " + JSON.stringify(targetPath) + ";",
      "const payload = { success: true, output: 'Found 1 relevant files.', result_present: true, empty_result: false, files: [{ path: target, ranges: [[2, 2], [5, 5], [15, 15], [25, 25], [29, 29]] }], grep_patterns: [], diagnostics: {}, error: null };",
      "if (process.argv.includes('--json')) console.log(JSON.stringify(payload));",
      "else console.log(payload.output);",
    ].join("\n"),
  );
  return engine;
}

function validateResult(resultPath) {
  const checked = spawnSync(process.execPath, [validator, resultPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  return JSON.parse(checked.stdout);
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

test("code context curates ranges, enforces budget, survives CDATA, and supports fallbacks", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "yce-code-context-"));
  try {
    const sourcePath = join(fixtureDir, "fixture.js");
    const lines = Array.from({ length: 30 }, (_, index) => "line-" + (index + 1));
    lines[1] = 'const marker = "]]>";';
    const source = lines.join("\n") + "\n";
    writeFileSync(sourcePath, source);

    const context = buildCodeContext(
      { files: [{ path: sourcePath, ranges: [[2, 2], [5, 5], [15, 15], [25, 25], [29, 29]] }] },
      { budgetTokens: 1000, projectRoot: fixtureDir },
    );
    assert.equal(context.budgetTokens, 1000);
    assert.deepEqual(
      context.files.map(({ startLine, endLine }) => [startLine, endLine]),
      [[1, 8], [12, 18], [22, 30]],
    );
    assert.equal(context.files[0].content, lines.slice(0, 8).join("\n") + "\n");
    assert.ok(context.usedTokens <= context.budgetTokens);

    const budgeted = buildCodeContext(
      { files: [{ path: sourcePath, ranges: [[2, 2], [15, 15], [25, 25]] }] },
      { budgetTokens: 15, projectRoot: fixtureDir },
    );
    assert.ok(budgeted.usedTokens <= 15);
    assert.ok(budgeted.files[0].content);
    assert.equal(budgeted.files.slice(1).some((file) => file.content !== undefined), false);

    const engine = writeFixtureEngine(fixtureDir, sourcePath);
    const resultPath = join(fixtureDir, "result.xml");
    const cli = runCli(
      ["Locate fixture", "--mode", "search", "--cwd", fixtureDir, "--out", resultPath],
      { YCE_ENGINE_SCRIPT: engine },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const result = validateResult(resultPath);
    assert.equal(result.search.result_present, true);
    const xml = readFileSync(resultPath, "utf8");
    assert.match(xml, /<code-context budget-tokens="6400" used-tokens="\d+">/);
    assert.match(
      xml,
      new RegExp(
        "<file path=\"" + escapeRegExp(sourcePath) + "\" start-line=\"1\" end-line=\"8\">",
      ),
    );
    assert.match(xml, /\]\]\]\]><!\[CDATA\[>/);

    const noContextPath = join(fixtureDir, "no-context.xml");
    const noContext = runCli(
      ["Locate fixture", "--mode", "search", "--cwd", fixtureDir, "--out", noContextPath, "--no-context"],
      { YCE_ENGINE_SCRIPT: engine },
    );
    assert.equal(noContext.status, 0, noContext.stderr);
    validateResult(noContextPath);
    assert.doesNotMatch(readFileSync(noContextPath, "utf8"), /<code-context\b/);

    const fallbackSource = join(fixtureDir, "fallback.js");
    writeFileSync(fallbackSource, "const needle = true;\n");
    const fallbackPath = join(fixtureDir, "fallback.xml");
    const fallback = runCli(
      ["needle", "--mode", "search", "--cwd", fixtureDir, "--out", fallbackPath],
      {
        YCE_ENGINE_SCRIPT: join(fixtureDir, "missing-engine.mjs"),
        YCE_LOCAL_FALLBACK: "true",
      },
    );
    assert.equal(fallback.status, 0, fallback.stderr);
    validateResult(fallbackPath);
    assert.match(readFileSync(fallbackPath, "utf8"), /<code-context\b/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
