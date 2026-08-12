/**
 * 任务卡核心库（任务锚点 B 线 S1）。
 *
 * 解决宿主 agent 上下文压缩导致的目标漂移：把任务的 goal 与阶段验收
 * 固化到项目目录 `.yce/tasks/<id>.json`，压缩后可原文找回。
 *
 * 设计红线：
 * - goal 一经建卡不可变（不提供修改入口，重写时以磁盘原文为准）；
 * - 卡上只有 goal + 阶段验收，不做完整 todo，避免与宿主 todo 双清单；
 * - active 卡超过 7 天未更新自动归档；
 * - 与 MCP（Rust）共享同一目录与 JSON schema。
 */

const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");

const TASKS_DIR_SEGMENTS = [".yce", "tasks"];
const TASK_PREVIEW_MAX_CHARS = 500;
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const CARD_ID_PATTERN = /^t-\d{8}-[a-z0-9]{6}$/;

function tasksDir(cwd) {
  return path.join(cwd, ...TASKS_DIR_SEGMENTS);
}

function cardPath(cwd, id) {
  return path.join(tasksDir(cwd), `${id}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function generateCardId(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const suffix = randomBytes(4).readUInt32BE(0).toString(36).padStart(6, "0").slice(0, 6);
  return `t-${day}-${suffix}`;
}

function isValidCardId(id) {
  return typeof id === "string" && CARD_ID_PATTERN.test(id);
}

function normalizeStages(stages) {
  const normalized = [];
  for (const stage of Array.isArray(stages) ? stages : []) {
    if (!stage || typeof stage !== "object") continue;
    const title = typeof stage.title === "string" ? stage.title.trim() : "";
    const accept = (Array.isArray(stage.accept) ? stage.accept : [])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    if (!title && accept.length === 0) continue;
    normalized.push({
      n: normalized.length + 1,
      title,
      accept,
      done: stage.done === true,
      evidence: typeof stage.evidence === "string" && stage.evidence ? stage.evidence : null,
      checked_at: typeof stage.checked_at === "string" ? stage.checked_at : null,
    });
  }
  return normalized;
}

/** 原子写：先写临时文件再 rename，避免 CLI 与 MCP 并发写坏卡。 */
function writeCard(cwd, card) {
  const dir = tasksDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const target = cardPath(cwd, card.id);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(card, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return card;
}

function readCard(cwd, id) {
  if (!isValidCardId(id)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(cardPath(cwd, id), "utf8");
    const card = JSON.parse(raw);
    if (!card || typeof card.goal !== "string" || !card.goal) {
      return null;
    }
    return card;
  } catch {
    return null;
  }
}

/**
 * 建卡。goal 必填且从此不可变；stages 允许为空（手动卡可只有验收）。
 */
function createCard({ cwd, goal, stages, task, source }) {
  const trimmedGoal = typeof goal === "string" ? goal.trim() : "";
  if (!trimmedGoal) {
    throw new Error("goal 不能为空：任务卡必须有一句话总目标。");
  }
  const now = nowIso();
  const card = {
    id: generateCardId(),
    goal: trimmedGoal,
    task: typeof task === "string" ? task.slice(0, TASK_PREVIEW_MAX_CHARS) : "",
    stages: normalizeStages(stages),
    status: "active",
    source: source === "manual" ? "manual" : "enhance",
    created_at: now,
    updated_at: now,
    done_at: null,
  };
  return writeCard(cwd, card);
}

function listCards(cwd, { status } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(tasksDir(cwd));
  } catch {
    return [];
  }
  const cards = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const card = readCard(cwd, entry.slice(0, -5));
    if (!card) continue;
    if (status && card.status !== status) continue;
    cards.push(card);
  }
  cards.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return cards;
}

/** active 卡超过 7 天未更新自动归档；返回归档数量。 */
function archiveStaleCards(cwd, now = Date.now()) {
  let archived = 0;
  for (const card of listCards(cwd, { status: "active" })) {
    const updatedAt = Date.parse(card.updated_at);
    if (Number.isFinite(updatedAt) && now - updatedAt > ARCHIVE_AFTER_MS) {
      card.status = "archived";
      card.updated_at = nowIso();
      writeCard(cwd, card);
      archived += 1;
    }
  }
  return archived;
}

/** 最近活跃卡（压缩恢复的零配合入口）；顺带执行 7 天归档。 */
function latestActiveCard(cwd) {
  archiveStaleCards(cwd);
  const cards = listCards(cwd, { status: "active" });
  return cards.length > 0 ? cards[0] : null;
}

/** 解析卡引用：显式 id 优先，省略或 "-" 时回退最近活跃卡。 */
function resolveCard(cwd, id) {
  if (id && id !== "-") {
    return readCard(cwd, id);
  }
  return latestActiveCard(cwd);
}

/**
 * 勾掉一个阶段并记录证据。goal 与 stages 的 title/accept 保持磁盘原文。
 */
function checkStage(cwd, id, stageN, evidence) {
  const card = readCard(cwd, id);
  if (!card) {
    throw new Error(`任务卡不存在：${id}`);
  }
  if (card.status !== "active") {
    throw new Error(`任务卡状态为 ${card.status}，不能勾阶段。`);
  }
  const stage = (card.stages || []).find((item) => item.n === stageN);
  if (!stage) {
    throw new Error(`阶段 ${stageN} 不存在（共 ${card.stages.length} 个阶段）。`);
  }
  const trimmedEvidence = typeof evidence === "string" ? evidence.trim() : "";
  if (!trimmedEvidence) {
    throw new Error("勾掉阶段必须附证据（--evidence），说明验收判据如何满足。");
  }
  stage.done = true;
  stage.evidence = trimmedEvidence;
  stage.checked_at = nowIso();
  card.updated_at = nowIso();
  return writeCard(cwd, card);
}

/**
 * 完成任务卡：逐条对照验收。存在未勾阶段且未 force 时不落状态，
 * 返回 unmet 列表让 agent 对照补齐。
 */
function completeCard(cwd, id, { force = false } = {}) {
  const card = readCard(cwd, id);
  if (!card) {
    throw new Error(`任务卡不存在：${id}`);
  }
  if (card.status === "done") {
    return { ok: true, card, unmet: [] };
  }
  const unmet = (card.stages || []).filter((stage) => stage.done !== true);
  if (unmet.length > 0 && !force) {
    return { ok: false, card, unmet };
  }
  card.status = "done";
  card.done_at = nowIso();
  card.updated_at = card.done_at;
  writeCard(cwd, card);
  return { ok: true, card, unmet: [] };
}

/** 从增强返回的任务锚点（{goal, stages:[{n,title,accept}]}）建卡。 */
function createCardFromTaskPlan({ cwd, taskPlan, task }) {
  if (!taskPlan || typeof taskPlan.goal !== "string" || !taskPlan.goal.trim()) {
    return null;
  }
  return createCard({
    cwd,
    goal: taskPlan.goal,
    stages: taskPlan.stages,
    task,
    source: "enhance",
  });
}

module.exports = {
  ARCHIVE_AFTER_MS,
  archiveStaleCards,
  checkStage,
  completeCard,
  createCard,
  createCardFromTaskPlan,
  generateCardId,
  isValidCardId,
  latestActiveCard,
  listCards,
  readCard,
  resolveCard,
  tasksDir,
};
