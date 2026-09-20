"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const { runCommand } = require("../scripts/lib/utils");

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function writeFakeChild(dir, { tailMs = 0, banner = "", fail = false, markerPath = "", lateWrite = false } = {}) {
  const childPath = join(dir, `child-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(childPath, [
    'process.stdout.on("error", () => {});',
    banner ? `console.log(${JSON.stringify(banner)});` : "",
    fail ? 'console.error("fixture failed"); process.exit(2);' : 'console.log(JSON.stringify({ success: true, output: "x" }));',
    fail ? "" : `setTimeout(() => { ${lateWrite ? 'console.log("tail");' : ""} ${markerPath ? `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "done");` : ""} }, ${tailMs});`,
  ].filter(Boolean).join("\n"));
  return childPath;
}

test("resolveOnJsonLine resolves on the JSON line instead of waiting for the child to exit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yce-detach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = writeFakeChild(dir, { tailMs: 3000 });
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, [child], { resolveOnJsonLine: true });
  assert.ok(Date.now() - startedAt < 1500);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.detached, true);
  assert.equal(result.timedOut, false);
  assert.equal(JSON.parse(result.stdout).success, true);
});

test("without resolveOnJsonLine the caller still waits for close", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yce-detach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = writeFakeChild(dir, { tailMs: 300 });
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, [child]);
  assert.ok(Date.now() - startedAt >= 250);
  assert.equal(result.exitCode, 0);
  assert.equal(result.detached, false);
});

test("a non-JSON first line keeps the caller on the close path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yce-detach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = writeFakeChild(dir, { banner: "warming up" });
  const result = await runCommand(process.execPath, [child], { resolveOnJsonLine: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.detached, false);
  assert.match(result.stdout, /warming up/);
  assert.match(result.stdout, /"success":true/);
});

test("a child that dies before printing JSON behaves exactly as today", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yce-detach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = writeFakeChild(dir, { fail: true });
  const result = await runCommand(process.execPath, [child], { resolveOnJsonLine: true });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.detached, false);
  assert.match(result.stderr, /fixture failed/);
});

test("detaching clears the kill timer", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yce-detach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = writeFakeChild(dir, { tailMs: 3000 });
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, [child], { resolveOnJsonLine: true, timeoutMs: 800 });
  assert.equal(result.detached, true);
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 800);
  await sleep(1200);
});

test("the parent exits while the detached child is still working", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yce-detach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "marker");
  const child = writeFakeChild(dir, { tailMs: 1200, markerPath: marker, lateWrite: true });
  const parent = join(dir, "parent.cjs");
  const utilsPath = resolve(__dirname, "../scripts/lib/utils.js");
  writeFileSync(parent, [
    `const { runCommand } = require(${JSON.stringify(utilsPath)});`,
    `(async () => { await runCommand(process.execPath, [${JSON.stringify(child)}], { resolveOnJsonLine: true }); console.log("resolved"); })();`,
  ].join("\n"));

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [parent], { encoding: "utf-8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - startedAt < 1000, "the parent waited for the detached child");
  for (let attempt = 0; attempt < 40 && !existsSync(marker); attempt += 1) await sleep(100);
  assert.equal(existsSync(marker), true, "the detached child did not finish its tail work");
});
