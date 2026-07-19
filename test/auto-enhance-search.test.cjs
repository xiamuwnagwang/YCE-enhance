const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { runNetworkSearch } = require("../scripts/lib/adapters/networkSearch");
const { orchestrate } = require("../scripts/lib/orchestrator");
const { serializeForStdout } = require("../scripts/lib/utils");

const repoRoot = resolve(__dirname, "..");
const fixtureDir = mkdtempSync(join(tmpdir(), "yce-auto-enhance-search-"));
const engineScript = join(fixtureDir, "fake-yce-engine.js");
const successfulEnhancer = join(fixtureDir, "successful-enhancer.js");
const failingEnhancer = join(fixtureDir, "failing-enhancer.js");
const forbiddenEnhancer = join(fixtureDir, "forbidden-enhancer.js");

writeFileSync(
  engineScript,
  [
    "const queryIndex = process.argv.indexOf('--query');",
    "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
    "const value = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };",
    "const values = (name) => process.argv.flatMap((arg, index) => arg === name ? [process.argv[index + 1]] : []);",
    "const output = `Found 1 relevant files.\\n\\nfixture search query: ${query}`;",
    "if (process.argv.includes('--json')) {",
    "  console.log(JSON.stringify({",
    "    success: true,",
    "    output,",
    "    result_present: true,",
    "    empty_result: false,",
    "    files: [{ path: '/fixture/result.js', ranges: [[1, 5]] }],",
    "    grep_patterns: ['fixture'],",
    "    diagnostics: {",
    "      tree_depth: Number(value('--tree-depth')),",
    "      requested_tree_depth: Number(value('--tree-depth')),",
    "      tree_size_kb: 12.5,",
    "      max_turns: Number(value('--max-turns')),",
    "      max_commands: Number(value('--max-commands')),",
    "      max_results: Number(value('--max-results')),",
    "      repo_map_strategy: value('--repo-map-mode'),",
    "      bootstrap_enabled: !process.argv.includes('--no-bootstrap'),",
    "      bootstrap_tree_depth: Number(value('--bootstrap-tree-depth')),",
    "      hotspot_top_k: Number(value('--hotspot-top-k')),",
    "      hotspot_tree_depth: Number(value('--hotspot-tree-depth')),",
    "      hotspot_max_bytes: Number(value('--hotspot-max-bytes')),",
    "      bootstrap_max_turns: Number(value('--bootstrap-max-turns')),",
    "      bootstrap_max_commands: Number(value('--bootstrap-max-commands')),",
    "      hot_dirs: ['src', 'lib'],",
    "      exclude_paths: values('--exclude'),",
    "      context_trimmed: true",
    "    },",
    "    error: null",
    "  }));",
    "} else {",
    "  console.log(output);",
    "}",
  ].join("\n")
);

writeFileSync(
  successfulEnhancer,
  [
    "console.log('<enhanced>');",
    "console.log('增强提示词正文：');",
    "console.log('增强后的代码检索词');",
    "console.log('</enhanced>');",
  ].join("\n")
);

writeFileSync(
  failingEnhancer,
  [
    "console.error('fixture enhancement failed');",
    "process.exit(7);",
  ].join("\n")
);

writeFileSync(
  forbiddenEnhancer,
  [
    "console.error('enhance should not be called without YOUWEN token');",
    "process.exit(99);",
  ].join("\n")
);

after(() => rmSync(fixtureDir, { recursive: true, force: true }));

function baseEnv(overrides = {}) {
  const env = {
    ...process.env,
    YCE_DISABLE_UPDATE_CHECK: "1",
    YCE_ENGINE_SCRIPT: engineScript,
    ...overrides,
  };

  // Explicit empty string must win over vendor/yce/.env so no-token tests stay deterministic.
  // Do not delete the keys: loadRuntimeConfig merges `.env` first, then process.env.
  if (Object.prototype.hasOwnProperty.call(overrides, "YCE_YOUWEN_TOKEN")) {
    env.YCE_YOUWEN_TOKEN = overrides.YCE_YOUWEN_TOKEN == null ? "" : String(overrides.YCE_YOUWEN_TOKEN);
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "YOUWEN_TOKEN")) {
    env.YOUWEN_TOKEN = overrides.YOUWEN_TOKEN == null ? "" : String(overrides.YOUWEN_TOKEN);
  }
  return env;
}

function runCli({ mode, query, enhancerScript, envOverrides = {}, extraArgs = [] }) {
  return spawnSync(
    process.execPath,
    ["scripts/yce.js", query, "--mode", mode, "--cwd", repoRoot, "--xml-pretty", ...extraArgs],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: baseEnv({
        YCE_YOUWEN_SCRIPT: enhancerScript,
        YCE_YOUWEN_TOKEN: "fixture-youwen-token",
        ...envOverrides,
      }),
    }
  );
}

test("auto 在增强成功后使用增强提示词执行 search", () => {
  const result = runCli({
    mode: "auto",
    query: "整理需求：发布策略",
    enhancerScript: successfulEnhancer,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<resolved-action>enhance_then_search<\/resolved-action>/);
  assert.match(result.stdout, /<search executed="true" success="true" result-present="true"/);
  assert.match(result.stdout, /<query><!\[CDATA\[增强后的代码检索词\]\]><\/query>/);
});

test("auto 在增强失败后使用原始 query 执行 search", () => {
  const originalQuery = "整理需求：发布策略";
  const result = runCli({
    mode: "auto",
    query: originalQuery,
    enhancerScript: failingEnhancer,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<resolved-action>enhance_then_search<\/resolved-action>/);
  assert.match(result.stdout, /<search executed="true" success="true" result-present="true"/);
  assert.match(result.stdout, new RegExp(`<query><!\\[CDATA\\[${originalQuery}\\]\\]><\\/query>`));
  assert.match(result.stdout, /<error source="yw-enhance" code="EXEC_ERROR">/);
});

test("auto 在缺少 YOUWEN token 时跳过 enhance 并直接 search", () => {
  const originalQuery = "整理需求：发布策略";
  const result = runCli({
    mode: "auto",
    query: originalQuery,
    enhancerScript: forbiddenEnhancer,
    envOverrides: {
      YCE_YOUWEN_TOKEN: "",
      YOUWEN_TOKEN: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<resolved-action>search<\/resolved-action>/);
  assert.match(result.stdout, /<enhanced\/>/);
  assert.doesNotMatch(result.stdout, /enhance should not be called without YOUWEN token/);
  assert.match(result.stdout, /<search executed="true" success="true" result-present="true"/);
  assert.match(result.stdout, new RegExp(`<query><!\\[CDATA\\[${originalQuery}\\]\\]><\\/query>`));
  assert.doesNotMatch(result.stdout, /<error source="yw-enhance"/);
});

test("enhance 在缺少 YOUWEN token 时拒绝执行", () => {
  const result = runCli({
    mode: "enhance",
    query: "优化这个任务描述",
    enhancerScript: forbiddenEnhancer,
    envOverrides: {
      YCE_YOUWEN_TOKEN: "",
      YOUWEN_TOKEN: "",
    },
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /<resolved-action>enhance<\/resolved-action>/);
  assert.match(result.stdout, /<enhanced executed="false" success="false"/);
  assert.match(result.stdout, /code="AUTH_ERROR"/);
  assert.match(result.stdout, /YCE_YOUWEN_TOKEN/);
  assert.doesNotMatch(result.stdout, /enhance should not be called without YOUWEN token/);
});

test("search 参数完整透传到 engine 并输出结构化诊断", () => {
  const result = runCli({
    mode: "search",
    query: "定位参数透传",
    enhancerScript: forbiddenEnhancer,
    extraArgs: [
      "--max-turns", "4",
      "--max-commands", "12",
      "--max-results", "18",
      "--tree-depth", "2",
      "--exclude", "generated",
      "--exclude", "fixtures,tmp",
      "--repo-map-mode", "classic",
      "--bootstrap-tree-depth", "2",
      "--hotspot-top-k", "3",
      "--hotspot-tree-depth", "3",
      "--hotspot-max-bytes", "65536",
      "--bootstrap-max-turns", "2",
      "--bootstrap-max-commands", "7",
      "--no-bootstrap",
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<diagnostics>/);
  assert.match(result.stdout, /<tree-depth>2<\/tree-depth>/);
  assert.match(result.stdout, /<max-turns>4<\/max-turns>/);
  assert.match(result.stdout, /<max-commands>12<\/max-commands>/);
  assert.match(result.stdout, /<max-results>18<\/max-results>/);
  assert.match(result.stdout, /<repo-map-strategy>classic<\/repo-map-strategy>/);
  assert.match(result.stdout, /<bootstrap-enabled>false<\/bootstrap-enabled>/);
  assert.match(result.stdout, /<bootstrap-tree-depth>2<\/bootstrap-tree-depth>/);
  assert.match(result.stdout, /<hotspot-top-k>3<\/hotspot-top-k>/);
  assert.match(result.stdout, /<hotspot-tree-depth>3<\/hotspot-tree-depth>/);
  assert.match(result.stdout, /<hotspot-max-bytes>65536<\/hotspot-max-bytes>/);
  assert.match(result.stdout, /<bootstrap-max-turns>2<\/bootstrap-max-turns>/);
  assert.match(result.stdout, /<bootstrap-max-commands>7<\/bootstrap-max-commands>/);
  assert.match(result.stdout, /<hot-dir><!\[CDATA\[src\]\]><\/hot-dir>/);
  assert.match(result.stdout, /<exclude-path><!\[CDATA\[generated\]\]><\/exclude-path>/);
  assert.match(result.stdout, /<exclude-path><!\[CDATA\[fixtures\]\]><\/exclude-path>/);
  assert.match(result.stdout, /<context-trimmed>true<\/context-trimmed>/);
});

test("search 参数超出硬上限时返回 INVALID_ARGS", () => {
  const result = runCli({
    mode: "search",
    query: "拒绝无界搜索",
    enhancerScript: forbiddenEnhancer,
    extraArgs: ["--max-turns", "99"],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /code="INVALID_ARGS"/);
  assert.match(result.stdout, /max-turns/);
});

test("network adapter 使用 Bearer token 并返回独立用量", async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: "succeeded",
          classification: { kind: "fact" },
          evidence: [{ title: "官方文档", url: "https://example.com/doc" }],
          summaries: [{ text: "已验证事实" }],
          providerRuns: [{ provider: "fixture", status: "succeeded" }],
          failures: [],
          usage: {
            network_daily_count: 2,
            network_daily_limit: 10,
            code_monthly_count: 5,
            network_monthly_count: 3,
            shared_monthly_count: 8,
            shared_monthly_limit: 100,
          },
        };
      },
    };
  };
  try {
    const result = await runNetworkSearch({
      query: "验证联网事实",
      relayUrl: "https://relay.example/",
      relayToken: "fixture-relay-token",
      timeoutMs: 5000,
      profile: "balanced",
    });
    assert.equal(result.error, null);
    assert.equal(result.networkSearch.result_present, true);
    assert.equal(captured.url, "https://relay.example/yce/network-search");
    assert.equal(
      captured.options.headers.Authorization,
      "Bearer fixture-relay-token",
    );
    const xml = serializeForStdout(
      {
        success: true,
        mode: "network",
        resolved_action: "network_search",
        original_query: "验证联网事实",
        cwd: repoRoot,
        enhance: null,
        search: null,
        network_search: result.networkSearch,
        errors: [],
        meta: {
          durations_ms: { enhance: 0, search: 0, network: 1, total: 1 },
          dependency_paths: {},
          timestamp: new Date().toISOString(),
        },
      },
      true,
    );
    assert.match(xml, /<network-search executed="true" success="true" result-present="true">/);
    assert.match(xml, /<network-daily-count>2<\/network-daily-count>/);
    assert.match(xml, /<code-monthly-count>5<\/code-monthly-count>/);
    assert.match(xml, /<network-monthly-count>3<\/network-monthly-count>/);
    assert.match(xml, /<source><!\[CDATA\[/);
    assert.match(xml, /<provider-run><!\[CDATA\[/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("enhance 显式附加联网时即使缺少 Youwen token 也继续联网", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        status: "succeeded",
        evidence: [{ title: "联网证据", url: "https://example.com/fact" }],
        summaries: [],
        providerRuns: [{ provider: "fixture", status: "succeeded" }],
        failures: [],
        usage: {},
      };
    },
  });
  try {
    const result = await orchestrate({
      mode: "enhance",
      query: "缺少增强密钥时继续联网",
      cwd: repoRoot,
      history: "",
      noSearch: false,
      rawEvents: false,
      withNetwork: true,
      timeoutEnhanceMs: 5000,
      timeoutSearchMs: 5000,
      timeoutNetworkMs: 5000,
      networkOptions: { profile: "balanced", library: "", repo: "" },
      config: {
        hasYouwenToken: false,
        ywEnhanceEnv: {},
        yceRelayUrl: "https://relay.example",
        yceRelayToken: "fixture-relay-token",
        youwenScript: forbiddenEnhancer,
        yceEngineScript: engineScript,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.resolved_action, "enhance_with_network");
    assert.equal(result.network_search.result_present, true);
    assert.equal(
      result.errors.some(
        (error) => error.source === "yw-enhance" && error.code === "AUTH_ERROR",
      ),
      true,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
