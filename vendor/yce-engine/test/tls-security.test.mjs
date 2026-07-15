import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("YCE engine 不会自动关闭 TLS 证书校验", () => {
  const source = readFileSync(new URL("../lib/core.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0["']/);
  assert.doesNotMatch(source, /_applyTlsFallback/);
});
