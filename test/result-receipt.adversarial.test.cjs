const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const validator = join(repoRoot, "scripts", "validate-yce-result.mjs");
const gate = require("../scripts/lib/resultGate.js");
const sink = require("../scripts/lib/resultSink.js");

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yce-adv-receipt-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validate(file, extra = []) {
  const result = spawnSync(process.execPath, [validator, file, ...extra], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = { stdout: result.stdout, stderr: result.stderr };
  }
  return { status: result.status, payload };
}

/** A minimal well-formed result whose CDATA body we control. */
function resultXml(cdata) {
  return [
    "<yce>",
    "  <success>true</success>",
    "  <mode>search</mode>",
    "  <resolved-action>search</resolved-action>",
    '  <search executed="true" success="true" result-present="true" empty-result="false">',
    `    <result><![CDATA[${cdata}]]></result>`,
    "  </search>",
    "</yce>",
  ].join("\n");
}

function writeFakeEngine(dir, output) {
  const engine = join(dir, "fake-engine.js");
  writeFileSync(
    engine,
    [
      `const output = ${JSON.stringify(output)};`,
      "if (process.argv.includes('--json')) {",
      "  console.log(JSON.stringify({ success: true, output, result_present: true, empty_result: false, files: [{ path: 'src/auth.ts', ranges: [[1, 20]] }], grep_patterns: [], diagnostics: {}, error: null }));",
      "} else { console.log(output); }",
    ].join("\n"),
  );
  return engine;
}

function runCli(engine, out) {
  return spawnSync(
    process.execPath,
    ["scripts/yce.js", "Locate auth", "--mode", "search", "--cwd", repoRoot, "--out", out],
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
  assert.ok(match, `receipt not found:\n${stdout}`);
  return JSON.parse(match[1]);
}

// ---------------------------------------------------------------------------
// 哨兵伪造：结果正文本身可以合法地引用一个哨兵（搜索本仓库就会搜到 resultGate.js）
// ---------------------------------------------------------------------------

test("对抗：正文引用哨兵不得让完整结果被判坏", () => {
  const quoted = `源码片段:\n<!-- yce:eof v=1 bytes=123 sha256=${"a".repeat(64)} -->\nconst x = 1;`;
  const file = gate.attachSentinel(resultXml(quoted));
  const summary = gate.buildSummary(file);
  assert.equal(gate.exitCodeFor(summary), 0, JSON.stringify(summary.reasons));
  assert.equal(summary.ok, true);
  // 出现多个哨兵时不再信任任何一个，但文档本身是完整的
  assert.equal(summary.integrity, "unverified");
  assert.equal(summary.sentinel_ambiguous, true);
});

test("对抗：为前缀量身定做的哨兵不得冒充文件结尾（需收据 sha256）", () => {
  withTempDir((dir) => {
    // 攻击者能算出“假哨兵之前的全部字节”，于是写入一个自洽的哨兵
    const spoofPrefix = resultXml("攻击者可控的前半段");
    const spoofSentinel = gate.buildSentinel(spoofPrefix);
    const realBody = [spoofPrefix, spoofSentinel, "<extra>本该被读到的其余内容</extra>"].join("\n");
    const realFile = gate.attachSentinel(realBody);

    const cut = join(dir, "cut.xml");
    const full = join(dir, "full.xml");
    writeFileSync(cut, `${realFile.slice(0, realFile.indexOf(spoofSentinel) + spoofSentinel.length)}\n`);
    writeFileSync(full, realFile);

    const receiptSha = gate.sha256(realBody);
    const receiptBytes = gate.byteLength(realBody);

    // 收据不来自文件，所以它能识破自洽的伪造
    const forged = validate(cut, ["--expect-sha256", receiptSha]);
    assert.equal(forged.status, 2, JSON.stringify(forged.payload));
    assert.equal(forged.payload.integrity, "mismatch");
    assert.equal(forged.payload.gate.may_analyze_or_edit_code, false);

    // 同一份收据必须放行真正完整的文件（即便正文里引用了哨兵）
    const genuine = validate(full, [
      "--expect-sha256",
      receiptSha,
      "--expect-bytes",
      String(receiptBytes),
    ]);
    assert.equal(genuine.status, 0, JSON.stringify(genuine.payload));
    assert.equal(genuine.payload.integrity, "verified");
  });
});

test("对抗：真实 CLI 下恶意内容只能落在 CDATA 里，截到假哨兵必然缺 </yce>", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    const spoof = `<!-- yce:eof v=1 bytes=10 sha256=${"b".repeat(64)} -->`;
    const cli = runCli(writeFakeEngine(dir, `命中内容\n${spoof}\n尾部`), out);
    assert.equal(cli.status, 0, cli.stderr);

    const saved = readFileSync(out, "utf8");
    // 结果内容在 </yce> 之前，所以截断到内容中的假哨兵处必然丢掉根闭合标签
    const cutAt = saved.indexOf(spoof) + spoof.length;
    assert.ok(saved.indexOf(spoof) < saved.indexOf("</yce>"));
    const cut = join(dir, "cut.xml");
    writeFileSync(cut, `${saved.slice(0, cutAt)}\n`);

    const { status, payload } = validate(cut);
    assert.equal(status, 2, JSON.stringify(payload));
    assert.ok(
      payload.reasons.some((reason) => reason.includes("</yce>")),
      JSON.stringify(payload.reasons),
    );
  });
});

test("对抗：哨兵之后被追加主机噪音，不得算 verified", () => {
  withTempDir((dir) => {
    const file = join(dir, "noisy.xml");
    writeFileSync(file, `${gate.attachSentinel(resultXml("hit"))}\n... [truncated]\n`);
    const { status, payload } = validate(file);
    assert.equal(status, 2, JSON.stringify(payload));
    assert.notEqual(payload.integrity, "verified");
    assert.equal(payload.truncation_detected, true);
  });
});

// ---------------------------------------------------------------------------
// 收据作为外部真相
// ---------------------------------------------------------------------------

test("对抗：哨兵丢失时收据 sha256 仍能抓住等长改写", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    const cli = runCli(writeFakeEngine(dir, "命中内容"), out);
    const receipt = receiptOf(cli.stdout);

    // 去掉哨兵行，模拟管道传递或哨兵被剥离：此时只剩收据这一层可依赖
    const body = readFileSync(out, "utf8").split("\n<!-- yce:eof")[0];
    assert.ok(body.includes("<mode>search</mode>"));

    const bare = join(dir, "bare.xml");
    writeFileSync(bare, body);
    const clean = validate(bare, ["--expect-sha256", receipt.xml_sha256]);
    assert.equal(clean.status, 0, JSON.stringify(clean.payload));
    assert.equal(clean.payload.integrity, "verified");

    // 等长替换：字节数不变，只有摘要能发现
    const tampered = join(dir, "tampered.xml");
    writeFileSync(tampered, body.replace("<mode>search</mode>", "<mode>searcg</mode>"));
    const caught = validate(tampered, ["--expect-sha256", receipt.xml_sha256]);
    assert.equal(caught.status, 2, JSON.stringify(caught.payload));
    assert.equal(caught.payload.integrity, "mismatch");
    assert.equal(caught.payload.gate.may_analyze_or_edit_code, false);
  });
});

test("对抗：哨兵本身也能抓住等长改写", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    runCli(writeFakeEngine(dir, "命中内容"), out);
    const tampered = join(dir, "tampered.xml");
    writeFileSync(
      tampered,
      readFileSync(out, "utf8").replace("<mode>search</mode>", "<mode>searcg</mode>"),
    );
    const { status, payload } = validate(tampered);
    assert.equal(status, 2, JSON.stringify(payload));
    assert.equal(payload.integrity, "mismatch");
    assert.ok(payload.reasons.some((reason) => reason.includes("sha256")));
  });
});

test("对抗：--expect-bytes 不符即失败", () => {
  withTempDir((dir) => {
    const file = join(dir, "result.xml");
    writeFileSync(file, gate.attachSentinel(resultXml("hit")));
    const { status, payload } = validate(file, ["--expect-bytes", "999999"]);
    assert.equal(status, 2, JSON.stringify(payload));
    assert.equal(payload.integrity, "mismatch");
  });
});

test("对抗：--expect-sha256 参数非法应报用法错误而不是放行", () => {
  withTempDir((dir) => {
    const file = join(dir, "result.xml");
    writeFileSync(file, gate.attachSentinel(resultXml("hit")));
    assert.equal(validate(file, ["--expect-sha256", "nope"]).status, 1);
    assert.equal(validate(file, ["--expect-bytes", "abc"]).status, 1);
  });
});

test("对抗：收据里的 sha256/bytes 与落盘文件真实一致", () => {
  withTempDir((dir) => {
    const out = join(dir, "result.xml");
    const cli = runCli(writeFakeEngine(dir, "命中内容 🔐 多字节"), out);
    const receipt = receiptOf(cli.stdout);
    const { status, payload } = validate(out, [
      "--expect-sha256",
      receipt.xml_sha256,
      "--expect-bytes",
      String(receipt.xml_bytes),
    ]);
    assert.equal(status, 0, JSON.stringify(payload));
    assert.equal(payload.integrity, "verified");
  });
});

// ---------------------------------------------------------------------------
// 误判防线：合法内容不得被当成损坏
// ---------------------------------------------------------------------------

test("对抗：CDATA 内未闭合的 HTML/JSX 不得触发结构告警", () => {
  const file = gate.attachSentinel(
    resultXml("<div class='a'><Foo bar={x}>\n</span></p><br>"),
  );
  const summary = gate.buildSummary(file);
  assert.equal(gate.exitCodeFor(summary), 0, JSON.stringify(summary.reasons));
  assert.equal(summary.integrity, "verified");
  assert.ok(!summary.reasons.some((reason) => reason.startsWith("structure:")));
});

test("对抗：属性值里含 > 不得打乱标签栈", () => {
  const body = [
    "<yce>",
    "  <success>true</success>",
    "  <mode>search</mode>",
    "  <resolved-action>search</resolved-action>",
    '  <search executed="true" success="true" result-present="true" empty-result="false" note="a > b">',
    "    <result><![CDATA[hit]]></result>",
    "  </search>",
    "</yce>",
  ].join("\n");
  const summary = gate.buildSummary(gate.attachSentinel(body));
  assert.equal(gate.exitCodeFor(summary), 0, JSON.stringify(summary.reasons));
});

test("对抗：多字节正文的字节数按 UTF-8 计算", () => {
  const body = resultXml("检索命中：用户鉴权模块 🔐 位于 src/auth.ts");
  const file = gate.attachSentinel(body);
  assert.equal(Number(file.match(/bytes=(\d+)/)[1]), Buffer.byteLength(body, "utf8"));
  assert.notEqual(Buffer.byteLength(body, "utf8"), body.length);
  const summary = gate.buildSummary(file);
  assert.equal(summary.integrity, "verified");
  assert.equal(gate.exitCodeFor(summary), 0);
});

test("对抗：CRLF 与正文自带尾换行都能往返", () => {
  const crlf = gate.attachSentinel(resultXml("a\nb").replace(/\n/g, "\r\n"));
  assert.equal(gate.buildSummary(crlf).integrity, "verified");
  const trailingNewline = gate.attachSentinel(`${resultXml("x")}\n`);
  assert.equal(gate.buildSummary(trailingNewline).integrity, "verified");
});

// ---------------------------------------------------------------------------
// 收据与落盘的运行时性质
// ---------------------------------------------------------------------------

test("对抗：错误再多也不能把收据撑到可被截断的大小", () => {
  const summary = {
    ok: false,
    complete: true,
    gate: { may_analyze_or_edit_code: false, may_use_network_facts: false, may_present_plan: false },
    mode: "search",
    resolved_action: "search",
    required_result: "search",
    errors: Array.from({ length: 40 }, (_, index) => ({
      source: "yce-engine",
      code: `E_${index}`,
      message: "x".repeat(8000),
    })),
    reasons: Array.from({ length: 50 }, (_, index) => `${"reason ".repeat(40)}${index}`),
    task_context: { present: false, created_now: false, id: null },
  };
  const receipt = sink.buildReceipt(summary, { path: "/tmp/x.xml", bytes: 10, sha256: "b".repeat(64) }, 3);
  assert.ok(Buffer.byteLength(receipt, "utf8") <= 4096, `receipt is ${Buffer.byteLength(receipt, "utf8")} bytes`);
  // 缩减后闸门和文件指针必须还在
  const parsed = JSON.parse(receipt.match(/<yce-receipt>\s*([\s\S]*?)\s*<\/yce-receipt>/)[1]);
  assert.equal(parsed.gate.may_analyze_or_edit_code, false);
  assert.equal(parsed.result_file, "/tmp/x.xml");
  assert.equal(parsed.exit_code, 3);
});

test("对抗：同一进程连续落盘不得重名覆盖", () => {
  const seen = new Set();
  for (let index = 0; index < 50; index += 1) {
    seen.add(sink.resolveResultPath({ mode: "search" }));
  }
  assert.equal(seen.size, 50);
});

test("对抗：--out 指向不可写路径时退回 stdout 并告警，不静默丢结果", () => {
  withTempDir((dir) => {
    const cli = runCli(writeFakeEngine(dir, "命中内容"), "/proc/definitely-not-writable/out.xml");
    assert.match(cli.stderr, /无法写入结果文件|回退到 stdout/);
    assert.match(cli.stdout, /<yce[\s>]/);
    assert.equal(cli.status, 0, cli.stderr);
  });
});

test("对抗：大结果校验保持线性开销且判定正确", () => {
  const file = gate.attachSentinel(resultXml("L".repeat(2 * 1024 * 1024)));
  const started = Date.now();
  const summary = gate.buildSummary(file);
  const elapsed = Date.now() - started;
  assert.equal(gate.exitCodeFor(summary), 0);
  assert.equal(summary.integrity, "verified");
  assert.ok(elapsed < 5000, `validation took ${elapsed}ms`);
});

test("对抗：只有哨兵没有正文不得放行", () => {
  withTempDir((dir) => {
    const file = join(dir, "empty.xml");
    writeFileSync(file, `${gate.buildSentinel("")}\n`);
    const { status, payload } = validate(file);
    assert.equal(status, 2, JSON.stringify(payload));
    assert.equal(payload.gate.may_analyze_or_edit_code, false);
  });
});

test("对抗：原子写不得留下可被误读的临时文件", () => {
  withTempDir((dir) => {
    const cli = runCli(writeFakeEngine(dir, "命中内容"), dir);
    assert.equal(cli.status, 0, cli.stderr);
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});
