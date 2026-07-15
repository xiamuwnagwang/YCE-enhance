import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ToolExecutor } from "../lib/executor.mjs";

test("ToolExecutor 只允许项目根目录内的真实路径", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "yce-executor-security-"));
  const root = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, "inside.txt"), "inside-only");
  writeFileSync(join(outside, "secret.txt"), "outside-secret");
  symlinkSync(outside, join(root, "outside-link"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const executor = new ToolExecutor(root);
  assert.equal(executor._real("/codebase/inside.txt"), realpathSync(join(root, "inside.txt")));
  assert.throws(() => executor._real(join(outside, "secret.txt")), /outside project root/i);
  assert.throws(() => executor._real("/codebase/../outside/secret.txt"), /outside project root/i);
  assert.throws(() => executor._real("/codebaseevil/secret.txt"), /outside project root/i);
  assert.throws(() => executor._real("C:\\Windows\\system.ini"), /outside project root/i);
  assert.throws(() => executor._real("/codebase/outside-link/secret.txt"), /symbolic link|outside project root/i);

  const blocked = await executor.execCommandAsync({ type: "readfile", file: join(outside, "secret.txt") });
  assert.match(blocked, /^Error: path is outside project root/);
  assert.doesNotMatch(blocked, /outside-secret/);
});
