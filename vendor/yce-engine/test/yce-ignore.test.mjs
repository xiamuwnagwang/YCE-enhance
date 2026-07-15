import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadYceIgnore } from "../lib/yce-ignore.mjs";

test(".yceignore 读取简单 glob、忽略注释并去重", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-ignore-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".yceignore"), [
    "# project generated files",
    "generated",
    "**/*.snap",
    "generated",
    "",
    "fixtures/tmp",
  ].join("\n"));

  assert.deepEqual(loadYceIgnore(root), {
    path: join(root, ".yceignore"),
    patterns: ["generated", "**/*.snap", "fixtures/tmp"],
  });
});

test("缺少 .yceignore 时返回空规则", () => {
  const root = mkdtempSync(join(tmpdir(), "yce-ignore-empty-"));
  try {
    assert.deepEqual(loadYceIgnore(root), { path: null, patterns: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
