const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const repoRoot = resolve(__dirname, "..");
const validator = join(repoRoot, "scripts", "validate-yce-result.mjs");

function validate(xml) {
  const result = spawnSync(process.execPath, [validator, "-"], {
    cwd: repoRoot,
    encoding: "utf8",
    input: xml,
  });
  let payload = null;
  try {
    payload = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    payload = { parse_error: result.stdout };
  }
  return { status: result.status, stderr: result.stderr, payload };
}

function yce({
  action = "search",
  success = true,
  searchPresent = true,
  extraSearchAttrs = "",
  result = "Path: src/auth.ts (L1-8)",
  extra = "",
} = {}) {
  const searchAttrs = `executed="true" success="true" result-present="${searchPresent ? "true" : "false"}" empty-result="${searchPresent ? "false" : "true"}"${extraSearchAttrs}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<yce>
  <success>${success ? "true" : "false"}</success>
  <mode>search</mode>
  <resolved-action>${action}</resolved-action>
  <original-query><![CDATA[Locate auth]]></original-query>
  <enhanced/>
  <search ${searchAttrs}>
    <query><![CDATA[Locate auth]]></query>
    <result><![CDATA[${result}]]></result>
  </search>
  <network-search executed="false" success="false" result-present="false"/>
  <y-plan executed="false" success="false" result-present="false"/>
  ${extra}
  <errors/>
</yce>
`;
}

test("对抗：完整 XML 的 CDATA 含 token limit / [truncated] 不得误判为主机截断", () => {
  const xml = yce({
    result: "comment: raise token limit for the provider\n[truncated] marker in source\nPath: src/quota.ts",
  });
  const { status, payload } = validate(xml);
  assert.equal(status, 0, JSON.stringify(payload, null, 2));
  assert.equal(payload.truncation_detected, false);
  assert.equal(payload.ok, true);
  assert.equal(payload.gate.may_analyze_or_edit_code, true);
});

test("对抗：主机在完整 XML 后追加 [truncated] 必须失败", () => {
  const { status, payload } = validate(`${yce()}\n[truncated]\n`);
  assert.equal(status, 2);
  assert.equal(payload.complete, false);
  assert.equal(payload.truncation_detected, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
});

test("对抗：主机在 XML 前包裹 Output truncated 必须失败", () => {
  const { status, payload } = validate(`Output truncated due to length\n${yce()}`);
  assert.equal(status, 2);
  assert.equal(payload.truncation_detected, true);
  assert.equal(payload.ok, false);
});

test("对抗：缺少 </yce> 即使出现 result-present=true 也不得放行", () => {
  const xml = `<yce>
  <success>true</success>
  <resolved-action>search</resolved-action>
  <search executed="true" success="true" result-present="true">
    <result><![CDATA[Path: src/a.ts`;
  const { status, payload } = validate(xml);
  assert.equal(status, 2);
  assert.equal(payload.ok, false);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
});

test("对抗：CDATA 内伪造 </yce> 但文档未闭合必须失败", () => {
  const xml = `<yce>
  <success>true</success>
  <resolved-action>search</resolved-action>
  <search executed="true" success="true" result-present="true">
    <result><![CDATA[fake </yce> close]]></result>
  </search>
`;
  const { status, payload } = validate(xml);
  assert.equal(status, 2);
  assert.equal(payload.ok, false);
});

test("对抗：search-query-source 不得冒充 search 块", () => {
  const xml = yce({
    extra: `<degraded active="true">
    <search-query-source>original-query</search-query-source>
  </degraded>`,
  });
  const { status, payload } = validate(xml);
  assert.equal(status, 0);
  assert.equal(payload.search.result_present, true);
});

test("对抗：CDATA 里写 result-present=true 不能代替真实属性", () => {
  const xml = yce({
    searchPresent: false,
    result: 'result-present="true" <search result-present="true">',
  });
  const { status, payload } = validate(xml);
  assert.equal(status, 3);
  assert.equal(payload.success, true);
  assert.equal(payload.search.result_present, false);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
});

test("对抗：help / 空 resolved-action 不得放行", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<yce>
  <success>false</success>
  <mode/>
  <resolved-action/>
  <search/>
  <network-search executed="false" success="false" result-present="false"/>
  <y-plan executed="false" success="false" result-present="false"/>
  <errors>
    <error source="cli" code="INVALID_ARGS"><![CDATA[Usage]]></error>
  </errors>
</yce>
`;
  const { status, payload } = validate(xml);
  assert.equal(status, 3);
  assert.equal(payload.ok, false);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
});

test("对抗：network_search 不得因代码 search 缺失而误放行改代码", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<yce>
  <success>true</success>
  <mode>network</mode>
  <resolved-action>network_search</resolved-action>
  <search/>
  <network-search executed="true" success="true" result-present="true">
    <query><![CDATA[latest react docs]]></query>
  </network-search>
  <y-plan executed="false" success="false" result-present="false"/>
  <errors/>
</yce>
`;
  const { status, payload } = validate(xml);
  assert.equal(status, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.gate.may_use_network_facts, true);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
});

test("对抗：plan 成功仍禁止改代码", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<yce>
  <success>true</success>
  <mode>plan</mode>
  <resolved-action>plan</resolved-action>
  <search/>
  <network-search executed="false" success="false" result-present="false"/>
  <y-plan executed="true" success="true" result-present="true">
    <plan><![CDATA[# step 1]]></plan>
  </y-plan>
  <errors/>
</yce>
`;
  const { status, payload } = validate(xml);
  assert.equal(status, 0);
  assert.equal(payload.gate.may_present_plan, true);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
});

test("对抗：MCP consume 说 ok 但 XML 被截断必须失败", () => {
  const xml = yce();
  const consume = {
    ok: true,
    complete: true,
    truncation_detected: false,
    xml_bytes: Buffer.byteLength(xml),
    resolved_action: "search",
    search: { result_present: true },
    gate: { may_analyze_or_edit_code: true },
  };
  const truncatedXml = xml.slice(0, Math.max(40, xml.length - 80));
  const wrapped = `<yce-consume>\n${JSON.stringify(consume, null, 2)}\n</yce-consume>\n${truncatedXml}`;
  const { status, payload } = validate(wrapped);
  assert.equal(status, 2, JSON.stringify(payload, null, 2));
  assert.equal(payload.ok, false);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
});

test("对抗：MCP consume 完整信封应通过并保留闸门", () => {
  const xml = yce();
  const consume = {
    ok: true,
    complete: true,
    xml_bytes: Buffer.byteLength(xml, "utf8"),
  };
  const wrapped = `<yce-consume>\n${JSON.stringify(consume, null, 2)}\n</yce-consume>\n${xml}`;
  const { status, payload } = validate(wrapped);
  assert.equal(status, 0, JSON.stringify(payload, null, 2));
  assert.equal(payload.ok, true);
  assert.equal(payload.gate.may_analyze_or_edit_code, true);
});

test("对抗：task-context 的 id 不被前面的 <id> 冒充", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<yce>
  <success>true</success>
  <mode>search</mode>
  <resolved-action>search</resolved-action>
  <id>evil-id</id>
  <search executed="true" success="true" result-present="true" empty-result="false">
    <query><![CDATA[Locate auth]]></query>
    <result><![CDATA[Path: src/auth.ts]]></result>
  </search>
  <network-search executed="false" success="false" result-present="false"/>
  <y-plan executed="false" success="false" result-present="false"/>
  <task-context present="true" created-now="false">
    <id>t-real</id>
    <goal><![CDATA[real goal]]></goal>
  </task-context>
  <errors/>
</yce>
`;
  const { status, payload } = validate(xml);
  assert.equal(status, 0);
  assert.equal(payload.task_context.id, "t-real");
});

test("对抗：consume JSON 内的 token limit 字样不得误判", () => {
  const xml = yce();
  const consume = {
    ok: true,
    complete: true,
    xml_bytes: Buffer.byteLength(xml, "utf8"),
    reasons: ["host truncation marker (truncated / token limit)"],
  };
  const wrapped = `<yce-consume>\n${JSON.stringify(consume, null, 2)}\n</yce-consume>\n${xml}`;
  const { status, payload } = validate(wrapped);
  assert.equal(status, 0, JSON.stringify(payload, null, 2));
  assert.equal(payload.truncation_detected, false);
});

test("对抗：空输入退出 1", () => {
  const { status } = validate("   \n");
  assert.equal(status, 1);
});

test("对抗：CRLF 完整文档仍可通过", () => {
  const xml = yce().replace(/\n/g, "\r\n");
  const { status, payload } = validate(xml);
  assert.equal(status, 0, JSON.stringify(payload, null, 2));
  assert.equal(payload.ok, true);
});

test("对抗：真实 --help XML 不得放行", () => {
  const help = spawnSync(process.execPath, ["scripts/yce.js", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, YCE_DISABLE_UPDATE_CHECK: "1" },
  });
  assert.equal(help.status, 0, help.stderr);
  const { status, payload } = validate(help.stdout);
  assert.equal(status, 3, JSON.stringify(payload, null, 2));
  assert.equal(payload.ok, false);
  assert.equal(payload.gate.may_analyze_or_edit_code, false);
  assert.match(JSON.stringify(payload.errors), /INVALID_ARGS/);
});

test("对抗：CLI search 落盘后再校验，不得把 stdout 当肉眼结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "yce-adv-search-"));
  const engine = join(dir, "fake-engine.js");
  const out = join(dir, "yce-result.xml");
  writeFileSync(
    engine,
    [
      "const queryIndex = process.argv.indexOf('--query');",
      "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
      "const output = `Found 1 relevant files.\\n\\nPath: src/auth.ts (L1-20)\\nquery: ${query}`;",
      "if (process.argv.includes('--json')) {",
      "  console.log(JSON.stringify({ success: true, output, result_present: true, empty_result: false, files: [{ path: 'src/auth.ts', ranges: [[1, 20]] }], grep_patterns: [], diagnostics: {}, error: null }));",
      "} else { console.log(output); }",
    ].join("\n"),
  );
  try {
    const cli = spawnSync(
      process.execPath,
      [
        "scripts/yce.js",
        "Locate auth middleware",
        "--mode",
        "search",
        "--cwd",
        repoRoot,
        "--xml-pretty",
      ],
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
    assert.equal(cli.status, 0, cli.stderr);
    writeFileSync(out, cli.stdout);
    const checked = spawnSync(process.execPath, [validator, out], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const payload = JSON.parse(checked.stdout);
    assert.equal(checked.status, 0, JSON.stringify(payload, null, 2));
    assert.equal(payload.search.result_present, true);
    assert.equal(payload.gate.may_analyze_or_edit_code, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

