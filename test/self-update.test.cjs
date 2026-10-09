const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const {
  autoSelfUpdateEnabled,
  performSelfUpdate,
  resolveArchiveUrl,
} = require("../scripts/lib/selfUpdate");

const fixtureDir = mkdtempSync(join(tmpdir(), "yce-self-update-"));

function writeSkillTree(dir, version, { staleReference = false } = {}) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "references"), { recursive: true });
  mkdirSync(join(dir, "vendor", "yce-engine"), { recursive: true });
  mkdirSync(join(dir, "vendor", "yce-engine", "node_modules", "@vscode"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: yce\nversion: ${version}\n---\n# fixture\n`,
  );
  writeFileSync(join(dir, "scripts", "yce.js"), `// ${version}\n`);
  writeFileSync(join(dir, ".env"), "YCE_RELAY_TOKEN=fixture-token\n");
  mkdirSync(join(dir, "vendor", "yce-engine", "node_modules", "@vscode", "ripgrep-darwin-arm64"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "vendor", "yce-engine", "node_modules", "@vscode", "ripgrep-darwin-arm64", "rg"),
    "binary",
  );
  if (staleReference) {
    writeFileSync(join(dir, "references", "old.md"), "stale\n");
  }
}

// 构造与 codeload tag 包同形的压缩包：单一顶层目录 + SKILL.md。
function buildArchive(version) {
  const stage = join(fixtureDir, `stage-${version}`);
  const pkgName = `YCE-enhance-${version}`;
  const pkgDir = join(stage, pkgName);
  mkdirSync(join(pkgDir, "scripts"), { recursive: true });
  mkdirSync(join(pkgDir, "references"), { recursive: true });
  mkdirSync(join(pkgDir, "vendor", "yce-engine"), { recursive: true });
  writeFileSync(
    join(pkgDir, "SKILL.md"),
    `---\nname: yce\nversion: ${version}\n---\n# fixture\n`,
  );
  writeFileSync(join(pkgDir, "scripts", "yce.js"), `// ${version}\n`);
  writeFileSync(join(pkgDir, "references", "fresh.md"), "fresh\n");
  const archive = join(fixtureDir, `pkg-${version}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", stage, pkgName]);
  rmSync(stage, { recursive: true, force: true });
  return archive;
}

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("performSelfUpdate 成功路径：换版本、保 .env、保 node_modules、清旧文件", async () => {
  const rootDir = join(fixtureDir, "root-success");
  writeSkillTree(rootDir, "1.0.0", { staleReference: true });
  const archive = buildArchive("1.0.1");

  const outcome = await performSelfUpdate({
    rootDir,
    info: { remoteVersion: "1.0.1" },
    archivePath: archive,
    skipNpmRepair: true,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.fromVersion, "1.0.0");
  assert.equal(outcome.toVersion, "1.0.1");
  assert.match(readFileSync(join(rootDir, "SKILL.md"), "utf8"), /version: 1\.0\.1/);
  assert.match(readFileSync(join(rootDir, "scripts", "yce.js"), "utf8"), /1\.0\.1/);
  assert.equal(readFileSync(join(rootDir, ".env"), "utf8"), "YCE_RELAY_TOKEN=fixture-token\n");
  assert.equal(
    existsSync(join(rootDir, "vendor", "yce-engine", "node_modules", "@vscode", "ripgrep-darwin-arm64", "rg")),
    true,
  );
  assert.equal(existsSync(join(rootDir, "references", "old.md")), false);
  assert.equal(existsSync(join(rootDir, "references", "fresh.md")), true);
});

test("performSelfUpdate 版本不匹配时拒绝交换且不动原目录", async () => {
  const rootDir = join(fixtureDir, "root-mismatch");
  writeSkillTree(rootDir, "1.0.0", { staleReference: true });
  const archive = buildArchive("1.0.2");

  const outcome = await performSelfUpdate({
    rootDir,
    info: { remoteVersion: "1.0.1" },
    archivePath: archive,
    skipNpmRepair: true,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "version-mismatch");
  assert.match(readFileSync(join(rootDir, "SKILL.md"), "utf8"), /version: 1\.0\.0/);
  assert.equal(existsSync(join(rootDir, "references", "old.md")), true);
});

test("performSelfUpdate 并发锁：已有新锁时直接放弃", async () => {
  const rootDir = join(fixtureDir, "root-locked");
  writeSkillTree(rootDir, "1.0.0");
  const archive = buildArchive("1.0.1");

  // 模拟另一个进程已持锁：锁文件路径 = tmpdir 下 sha1(root) 前缀。
  const crypto = require("node:crypto");
  const hash = crypto
    .createHash("sha1")
    .update(resolve(rootDir))
    .digest("hex")
    .slice(0, 12);
  const lockFile = join(tmpdir(), `yce-selfupdate-${hash}.lock`);
  writeFileSync(lockFile, String(Date.now()));
  try {
    const outcome = await performSelfUpdate({
      rootDir,
      info: { remoteVersion: "1.0.1" },
      archivePath: archive,
      skipNpmRepair: true,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "locked");
    assert.match(readFileSync(join(rootDir, "SKILL.md"), "utf8"), /version: 1\.0\.0/);
  } finally {
    rmSync(lockFile, { force: true });
  }
});

test("resolveArchiveUrl：直链优先，主页兜底拼 codeload tag，非语义版本拒绝", () => {
  const direct = resolveArchiveUrl({
    downloadUrl: "https://example.com/yce-1.0.1.tar.gz",
    remoteVersion: "1.0.1",
  });
  assert.equal(direct, "https://example.com/yce-1.0.1.tar.gz");

  const page = resolveArchiveUrl({
    downloadUrl: "https://github.com/xiamuwnagwang/YCE-enhance",
    remoteVersion: "1.0.1",
  });
  assert.equal(page, "https://codeload.github.com/xiamuwnagwang/YCE-enhance/tar.gz/refs/tags/v1.0.1");

  assert.equal(resolveArchiveUrl({ remoteVersion: "latest" }), null);
  assert.equal(resolveArchiveUrl({}), null);
});

test("autoSelfUpdateEnabled：默认开，环境变量与防循环标记可关", () => {
  const saved = { ...process.env };
  try {
    delete process.env.YCE_AUTO_SELF_UPDATE;
    delete process.env.YCE_SELF_UPDATED;
    assert.equal(autoSelfUpdateEnabled(), true);

    for (const flag of ["0", "false", "no", "off"]) {
      process.env.YCE_AUTO_SELF_UPDATE = flag;
      assert.equal(autoSelfUpdateEnabled(), false, `YCE_AUTO_SELF_UPDATE=${flag}`);
    }

    process.env.YCE_AUTO_SELF_UPDATE = "1";
    process.env.YCE_SELF_UPDATED = "1";
    assert.equal(autoSelfUpdateEnabled(), false);

    delete process.env.YCE_SELF_UPDATED;
    assert.equal(autoSelfUpdateEnabled(), true);
  } finally {
    process.env = saved;
  }
});
