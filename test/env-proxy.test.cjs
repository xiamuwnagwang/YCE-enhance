const test = require("node:test");
const assert = require("node:assert/strict");

const { withNodeEnvProxy, envProxySourceEnv } = require("../scripts/lib/utils");

// node 只认 HTTP(S)_PROXY，且只在启动前带 --use-env-proxy 时才生效；低于 v24 时这个
// 开关不存在，相关断言只能跳过（CLI 在那种 node 上照旧直连，行为与改动前一致）。
const nodeMajor = Number(String(process.versions.node).split(".")[0]);
const supportsEnvProxy = nodeMajor >= 24;
const skipOnOldNode = supportsEnvProxy ? false : `node v${process.versions.node} 不支持 --use-env-proxy`;

// .env 回退只挑代理键：这组键名是它与「整份 .env 灌进子进程」的分界线，
// 写在用例里当契约，改 utils 里的名单会在这里失败。
const PROXY_KEY_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

test("没有代理变量时不注入开关，环境原样返回", () => {
  const { env, applied } = withNodeEnvProxy({ PATH: "/usr/bin" });
  assert.equal(applied, false);
  assert.deepEqual(Object.keys(env), ["PATH"]);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("有 HTTPS_PROXY 时注入 --use-env-proxy 并打上 re-exec 标记", { skip: skipOnOldNode }, () => {
  const { env, applied } = withNodeEnvProxy({ HTTPS_PROXY: "http://127.0.0.1:7890" });
  assert.equal(applied, true);
  assert.match(env.NODE_OPTIONS, /(^|\s)--use-env-proxy(\s|$)/);
  assert.equal(env.YCE_ENV_PROXY_REEXEC, "1");
});

test("已有的 NODE_OPTIONS 不会被覆盖，只前置开关", { skip: skipOnOldNode }, () => {
  const { env, applied } = withNodeEnvProxy({
    HTTPS_PROXY: "http://127.0.0.1:7890",
    NODE_OPTIONS: "--max-old-space-size=4096",
  });
  assert.equal(applied, true);
  assert.equal(env.NODE_OPTIONS, "--use-env-proxy --max-old-space-size=4096");
});

test("re-exec 标记已存在时不再注入，避免自我循环", { skip: skipOnOldNode }, () => {
  const { applied } = withNodeEnvProxy({
    HTTPS_PROXY: "http://127.0.0.1:7890",
    YCE_ENV_PROXY_REEXEC: "1",
  });
  assert.equal(applied, false);
});

test("NODE_OPTIONS 里已有开关时不重复注入", { skip: skipOnOldNode }, () => {
  const { applied } = withNodeEnvProxy({
    HTTPS_PROXY: "http://127.0.0.1:7890",
    NODE_OPTIONS: "--use-env-proxy",
  });
  assert.equal(applied, false);
});

test("YCE_USE_ENV_PROXY=0 时整体关掉，代理变量照旧留在环境里", { skip: skipOnOldNode }, () => {
  const { env, applied } = withNodeEnvProxy({
    HTTPS_PROXY: "http://127.0.0.1:7890",
    YCE_USE_ENV_PROXY: "0",
  });
  assert.equal(applied, false);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("http(s) 形态的 ALL_PROXY 镜像到 HTTP(S)_PROXY，socks 形态不动", () => {
  const mirrored = withNodeEnvProxy({ ALL_PROXY: "http://127.0.0.1:7890" }).env;
  assert.equal(mirrored.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(mirrored.HTTP_PROXY, "http://127.0.0.1:7890");

  const socks = withNodeEnvProxy({ ALL_PROXY: "socks5://127.0.0.1:7897" }).env;
  assert.equal(socks.HTTPS_PROXY, undefined);
  assert.equal(socks.HTTP_PROXY, undefined);
});

test("已经显式设过的代理变量不会被 ALL_PROXY 顶掉", () => {
  const env = withNodeEnvProxy({
    ALL_PROXY: "http://127.0.0.1:7890",
    https_proxy: "http://127.0.0.1:1080",
  }).env;
  assert.equal(env.HTTPS_PROXY, undefined, "小写已经设过就不该再补一份大写");
  assert.equal(env.https_proxy, "http://127.0.0.1:1080");
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
});

test(".env 回退只补代理键，且不覆盖调用方显式给的值", () => {
  const explicit = { HTTPS_PROXY: "http://explicit.example:1", KEEP_ME: "yes" };
  const merged = envProxySourceEnv(explicit);
  assert.equal(merged.HTTPS_PROXY, "http://explicit.example:1");
  assert.equal(merged.KEEP_ME, "yes");

  const added = Object.keys(merged).filter((key) => !(key in explicit));
  for (const key of added) {
    assert.ok(PROXY_KEY_NAMES.includes(key), `只应补代理键，却多出 ${key}`);
  }
  // .env 里其余键（YCE_RELAY_TOKEN 等）不得因为这条回退路径流进子进程。
  assert.equal("YCE_RELAY_TOKEN" in envProxySourceEnv({}), false);
});
