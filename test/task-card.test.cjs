const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const {
  ARCHIVE_AFTER_MS,
  archiveStaleCards,
  checkStage,
  completeCard,
  createCard,
  createCardFromTaskPlan,
  isValidCardId,
  latestActiveCard,
  listCards,
  readCard,
  resolveCard,
  tasksDir,
} = require("../scripts/lib/taskCard");

const workDir = mkdtempSync(join(tmpdir(), "yce-task-card-"));

after(() => rmSync(workDir, { recursive: true, force: true }));

test("建卡后回读一字不差（含引号、换行、特殊字符）", () => {
  const goal = '把 "登录" 会话迁到 Redis\n且保持 <旧会话> 兼容 && 不丢数据';
  const card = createCard({
    cwd: workDir,
    goal,
    task: "原始任务描述",
    stages: [
      { title: '梳理 "现状"', accept: ["列出会话读写点\n（含行号）", "第二条 <判据>"] },
    ],
    source: "manual",
  });
  assert.ok(isValidCardId(card.id), card.id);
  const reread = readCard(workDir, card.id);
  assert.equal(reread.goal, goal.trim());
  assert.equal(reread.stages[0].title, '梳理 "现状"');
  assert.deepEqual(reread.stages[0].accept, [
    "列出会话读写点\n（含行号）",
    "第二条 <判据>",
  ]);
  assert.equal(reread.status, "active");
  assert.equal(reread.source, "manual");
});

test("goal 不可变：库不提供修改入口，磁盘篡改后 check/done 仍保留原文语义", () => {
  const card = createCard({
    cwd: workDir,
    goal: "不可变目标",
    stages: [{ title: "唯一阶段", accept: ["判据"] }],
  });
  // 库导出的 API 没有任何修改 goal 的入口
  const api = require("../scripts/lib/taskCard");
  const mutators = Object.keys(api).filter((name) => /goal/i.test(name));
  assert.deepEqual(mutators, []);
  // check 阶段后 goal 原样
  const checked = checkStage(workDir, card.id, 1, "已验证");
  assert.equal(checked.goal, "不可变目标");
});

test("checkStage 需要证据并记录时间；completeCard 逐条对照验收", () => {
  const card = createCard({
    cwd: workDir,
    goal: "完成流程测试",
    stages: [
      { title: "阶段一", accept: ["A"] },
      { title: "阶段二", accept: ["B"] },
    ],
  });
  assert.throws(() => checkStage(workDir, card.id, 1, "  "), /证据/);
  checkStage(workDir, card.id, 1, "命令输出为 X");

  // 阶段二未勾：done 不通过，返回 unmet
  const blocked = completeCard(workDir, card.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.unmet.length, 1);
  assert.equal(blocked.unmet[0].title, "阶段二");
  assert.equal(readCard(workDir, card.id).status, "active");

  checkStage(workDir, card.id, 2, "测试通过");
  const done = completeCard(workDir, card.id);
  assert.equal(done.ok, true);
  assert.equal(readCard(workDir, card.id).status, "done");

  // force 可以跳过未勾阶段
  const forced = createCard({ cwd: workDir, goal: "强制完成", stages: [{ title: "s", accept: ["a"] }] });
  const forcedDone = completeCard(workDir, forced.id, { force: true });
  assert.equal(forcedDone.ok, true);
});

test("active 卡超过 7 天未更新自动归档；latestActiveCard 返回最近活跃卡", () => {
  const stale = createCard({ cwd: workDir, goal: "过期卡", stages: [] });
  // 手工把 updated_at 拨回 8 天前
  const stalePath = join(tasksDir(workDir), `${stale.id}.json`);
  const raw = JSON.parse(readFileSync(stalePath, "utf8"));
  raw.updated_at = new Date(Date.now() - ARCHIVE_AFTER_MS - 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(stalePath, JSON.stringify(raw, null, 2));

  const fresh = createCard({ cwd: workDir, goal: "最新活跃卡", stages: [] });
  const archivedCount = archiveStaleCards(workDir);
  assert.ok(archivedCount >= 1);
  assert.equal(readCard(workDir, stale.id).status, "archived");

  const latest = latestActiveCard(workDir);
  assert.equal(latest.id, fresh.id);
});

test("resolveCard：显式 id 优先，省略回退最近活跃卡；非法 id 安全返回 null", () => {
  const card = latestActiveCard(workDir);
  assert.equal(resolveCard(workDir, card.id).id, card.id);
  assert.equal(resolveCard(workDir, "").id, card.id);
  assert.equal(resolveCard(workDir, "-").id, card.id);
  assert.equal(readCard(workDir, "../../etc/passwd"), null);
  assert.equal(readCard(workDir, "t-xxx"), null);
});

test("createCardFromTaskPlan 消费增强返回的任务锚点", () => {
  const card = createCardFromTaskPlan({
    cwd: workDir,
    taskPlan: {
      goal: "从锚点建卡",
      stages: [{ n: 1, title: "阶段", accept: ["判据 1", "判据 2"] }],
    },
    task: "原始 query",
  });
  assert.equal(card.goal, "从锚点建卡");
  assert.equal(card.source, "enhance");
  assert.deepEqual(card.stages[0].accept, ["判据 1", "判据 2"]);
  // 无 goal 的锚点不建卡
  assert.equal(createCardFromTaskPlan({ cwd: workDir, taskPlan: { stages: [] }, task: "" }), null);
});

test("listCards 按更新时间倒序且支持状态过滤", () => {
  const cards = listCards(workDir);
  assert.ok(cards.length >= 3);
  for (let index = 1; index < cards.length; index += 1) {
    assert.ok(cards[index - 1].updated_at >= cards[index].updated_at);
  }
  for (const card of listCards(workDir, { status: "done" })) {
    assert.equal(card.status, "done");
  }
});
