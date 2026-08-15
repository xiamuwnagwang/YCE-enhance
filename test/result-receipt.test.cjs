const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const validator = join(repoRoot, "scripts", "validate-yce-result.mjs");

/**
 * Fake yce-engine so these tests never hit the relay.
 * @param {{ resultPresent?: boolean, body?: string }} options
 */
function writeFakeEngine(dir, options = {}) {
  const resultPresent = options.resultPresent !== false;
  const body = options.body || "Found 1 relevant files.\\n\\nPath: src/auth.ts (L1-20)";
  const engine = join(dir, "fake-engine.js");
  writeFileSync(
    engine,
    [
      `const output = "${body}";`,
      "if (process.argv.includes('--json')) {",
      `  console.log(JSON.stringify({ success: true, output, result_present: ${resultPresent}, empty_result: ${!resultPresent}, files: [{ path: 'src/auth.ts', ranges: [[1, 20]] }], grep_patterns: [], diagnostics: {}, error: null }));`,
      "} else { console.log(output); }",
    ].join("\n"),
  );
  return engine;
}

function runCli(engine, extraArgs = []) {
  return spawnSync(
    process.execPath,
    ["scripts/yce.js", "Locate auth middleware", "--mode", "search", "--cwd", repoRoot, ...extraArgs],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        YCE_DISABLE_UPDATE_CHECK: "1",
        YCE_ENGINE_SCRIPT: engine,
        YCE_RELAY_TOKEN: "",
      },
    },
  );
}

function receiptOf(stdout) {
  const match = stdout.match(/<yce-receipt>\s*([\s\S]*?)\s*<\/yce-receipt>/);
  assert.ok(match, `receipt not found in stdout:\n${stdout}`);
  return JSON.parse(match[1]);
}

function validate(file) {
  const result = spawnSync(process.execPath, [validator, file], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: result.status, payload: JSON.parse(result.stdout) };
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yce-receipt-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("默认不再把完整 XML 打到 stdout：只回小收据", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    const cli = runCli(writeFakeEngine(dir), ["--out", out]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.doesNotMatch(cli.stdout, /<yce[\s>]/);

    const receipt = receiptOf(cli.stdout);
    assert.equal(receipt.schema, "yce-receipt/1");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.exit_code, 0);
    assert.equal(receipt.gate.may_analyze_or_edit_code, true);
    assert.equal(receipt.result_file, out);
    assert.equal(receipt.eof_sentinel, true);
    assert.ok(existsSync(out));

    // 收据必须小到主机不可能截断
    assert.ok(cli.stdout.length < 2048, `receipt too large: ${cli.stdout.length}`);

    const saved = readFileSync(out, "utf8");
    assert.equal(Buffer.byteLength(saved.split("<!-- yce:eof")[0].replace(/\n$/, ""), "utf8"), receipt.xml_bytes);
    assert.match(saved.trimEnd(), /<!-- yce:eof v=1 bytes=\d+ sha256=[0-9a-f]{64} -->$/);
  });
});

test("收据里的闸门与文件复核结论一致", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    const cli = runCli(writeFakeEngine(dir), ["--out", out]);
    const receipt = receiptOf(cli.stdout);
    const { status, payload } = validate(out);
    assert.equal(status, receipt.exit_code);
    assert.equal(payload.integrity, "verified");
    assert.deepEqual(payload.gate, receipt.gate);
  });
});

test("退出码本身就是闸门：无主结果时 CLI 直接退 3", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    const cli = runCli(writeFakeEngine(dir, { resultPresent: false }), ["--out", out]);
    assert.equal(cli.status, 3, cli.stdout);
    const receipt = receiptOf(cli.stdout);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.gate.may_analyze_or_edit_code, false);
    assert.equal(validate(out).status, 3);
  });
});

test("哨兵抓改动：落盘后改一个字节即判不完整", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    runCli(writeFakeEngine(dir), ["--out", out]);
    const saved = readFileSync(out, "utf8");
    writeFileSync(out, saved.replace("<success>true</success>", "<success>fals</success>"));
    const { status, payload } = validate(out);
    assert.equal(status, 2);
    assert.equal(payload.integrity, "mismatch");
    assert.equal(payload.truncation_detected, true);
    assert.equal(payload.gate.may_analyze_or_edit_code, false);
  });
});

test("中间省略型截断：带 truncated 标记必须失败", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    runCli(writeFakeEngine(dir), ["--out", out]);
    const saved = readFileSync(out, "utf8");
    const body = saved.split("\n<!-- yce:eof")[0];
    const mangled = join(dir, "mangled.xml");
    writeFileSync(
      mangled,
      `${body.slice(0, Math.floor(body.length / 3))}\n... [1234 lines truncated] ...\n${body.slice(-Math.floor(body.length / 3))}`,
    );
    const { status, payload } = validate(mangled);
    assert.equal(status, 2, JSON.stringify(payload, null, 2));
    assert.equal(payload.truncation_detected, true);
    assert.equal(payload.gate.may_analyze_or_edit_code, false);
  });
});

test("中间省略型截断：连标记都没有也必须失败（靠标签配对）", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    runCli(writeFakeEngine(dir), ["--out", out]);
    const saved = readFileSync(out, "utf8");
    const body = saved.split("\n<!-- yce:eof")[0];
    const mangled = join(dir, "silent.xml");
    writeFileSync(
      mangled,
      body.slice(0, Math.floor(body.length / 3)) + body.slice(-Math.floor(body.length / 3)),
    );
    const { status, payload } = validate(mangled);
    assert.equal(status, 2, JSON.stringify(payload, null, 2));
    assert.ok(
      payload.reasons.some((reason) => reason.startsWith("structure:")),
      JSON.stringify(payload.reasons),
    );
    assert.equal(payload.gate.may_analyze_or_edit_code, false);
  });
});

test("引擎自己的 (lines truncated) 在 CDATA 内，不算主机截断", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    const engine = writeFakeEngine(dir, {
      body: "Found 1 relevant files.\\n\\nPath: src/auth.ts (L1-20)\\n... (lines truncated) ...\\nmore",
    });
    const cli = runCli(engine, ["--out", out]);
    assert.equal(cli.status, 0, cli.stdout);
    const { status, payload } = validate(out);
    assert.equal(status, 0, JSON.stringify(payload, null, 2));
    assert.equal(payload.truncation_detected, false);
    assert.equal(payload.gate.may_analyze_or_edit_code, true);
  });
});

test("--stdout-xml 保留旧管道行为", () => {
  withTempDir((dir) => {
    const cli = runCli(writeFakeEngine(dir), ["--stdout-xml", "--xml-pretty"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /<yce[\s>]/);
    assert.doesNotMatch(cli.stdout, /<yce-receipt>/);
  });
});

test("--out 传目录时自动生成文件名", () => {
  withTempDir((dir) => {
    const cli = runCli(writeFakeEngine(dir), ["--out", dir]);
    assert.equal(cli.status, 0, cli.stderr);
    const receipt = receiptOf(cli.stdout);
    assert.ok(receipt.result_file.startsWith(dir), receipt.result_file);
    assert.ok(readdirSync(dir).some((name) => name.endsWith(".xml")));
    assert.equal(validate(receipt.result_file).status, 0);
    // 原子写不得留下临时文件
    assert.ok(!readdirSync(dir).some((name) => name.endsWith(".tmp")));
  });
});
