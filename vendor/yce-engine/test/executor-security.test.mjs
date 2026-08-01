import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ToolExecutor,
  buildPowerShellProcessQueryScript,
  classifyPowerShellCommand,
  parseProcessFilterJson,
} from "../lib/executor.mjs";

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

test("Windows 动态 PID 命令只接受严格的官方过滤格式并保留旧命令", () => {
  const dynamic = 'Get-CimInstance Win32_Process -Filter "ProcessId = 8180 OR ProcessId = 24296"';
  const classified = classifyPowerShellCommand(dynamic);

  assert.equal(classified.ok, true);
  assert.equal(classified.kind, "dynamic_pid_filter");
  assert.deepEqual(classified.pids, [8180, 24296]);
  assert.equal(
    buildPowerShellProcessQueryScript(dynamic),
    `${dynamic} | ConvertTo-Json -Compress`,
  );

  const legacy = classifyPowerShellCommand("Get-CimInstance Win32_Process");
  assert.equal(legacy.ok, true);
  assert.equal(legacy.kind, "legacy_process_snapshot");
});

test("Windows PowerShell 命令拒绝管道、附加语句和近似的任意查询", async () => {
  const maliciousCommands = [
    'Get-CimInstance Win32_Process -Filter "ProcessId = 8180" | Stop-Process -Force',
    'Get-CimInstance Win32_Process -Filter "ProcessId = 8180"; Remove-Item * -Force',
    'Get-CimInstance Win32_Process -Filter "ProcessId = $(Get-Random)"',
    'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'"',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' }",
    'Get-CimInstance Win32_Process -Filter "ProcessId = 8180" -ErrorAction SilentlyContinue',
  ];

  for (const command of maliciousCommands) {
    const result = classifyPowerShellCommand(command);
    assert.equal(result.ok, false, command);
    assert.match(result.reason, /only|allowed|Filter|ProcessId/i, command);
    assert.throws(() => buildPowerShellProcessQueryScript(command), /PowerShell command rejected/);
  }

  const executor = new ToolExecutor(process.cwd());
  const blocked = await executor.execCommandAsync({
    type: "powershell",
    command: maliciousCommands[0],
  });
  assert.match(blocked, /^Error: PowerShell command rejected:/);
});

test("Windows PID 过滤结果按原生 JSON 严格解析并校验返回 PID", () => {
  const raw = JSON.stringify([
    { ProcessId: 8180, Name: "node.exe", CommandLine: "node app.js" },
    { ProcessId: 24296, Name: "node.exe", CommandLine: "node worker.js" },
  ]);

  assert.deepEqual(parseProcessFilterJson(raw, [8180, 24296]), JSON.parse(raw));
  assert.deepEqual(parseProcessFilterJson(JSON.stringify({ ProcessId: 8180 }), [8180]), [
    { ProcessId: 8180 },
  ]);
  assert.deepEqual(parseProcessFilterJson("null", [8180]), []);
  assert.deepEqual(parseProcessFilterJson("", [8180]), []);

  assert.throws(
    () => parseProcessFilterJson(JSON.stringify({ ProcessId: "8180" }), [8180]),
    /invalid numeric ProcessId/,
  );
  assert.throws(
    () => parseProcessFilterJson(JSON.stringify({ ProcessId: 9999 }), [8180]),
    /unexpected ProcessId/,
  );
  assert.throws(
    () => parseProcessFilterJson(JSON.stringify(["not-an-object"])),
    /JSON objects/,
  );
});
