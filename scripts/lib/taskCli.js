/**
 * `yce task` 子命令（任务锚点 B 线 S3 的命令面）。
 *
 * 双场景协议的落点：
 * - 压缩恢复：`task show`（无参 = 最近活跃卡，原文找回 goal + 验收）；
 * - 阶段推进：`task check <n> --evidence "..."`；
 * - 宣称完成前：`task done`（逐条对照验收，未过列 unmet）；
 * - 手动建卡：`task new --goal "..." --accept "..."`。
 */

const {
  checkStage,
  completeCard,
  createCard,
  listCards,
  readCard,
  resolveCard,
} = require("./taskCard");

function xmlEscapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlEscapeAttr(value) {
  return xmlEscapeText(value).replace(/"/g, "&quot;");
}

function xmlCdata(value) {
  return `<![CDATA[${String(value).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function pushCardXml(lines, card, { createdNow = false, level = 1 } = {}) {
  const indent = "  ".repeat(level);
  const inner = "  ".repeat(level + 1);
  const stageIndent = "  ".repeat(level + 2);
  const itemIndent = "  ".repeat(level + 3);
  lines.push(
    `${indent}<card present="true" created-now="${createdNow ? "true" : "false"}">`,
  );
  lines.push(`${inner}<id>${xmlEscapeText(card.id)}</id>`);
  lines.push(`${inner}<goal>${xmlCdata(card.goal)}</goal>`);
  if (card.task) {
    lines.push(`${inner}<task>${xmlCdata(card.task)}</task>`);
  }
  lines.push(`${inner}<status>${xmlEscapeText(card.status)}</status>`);
  lines.push(`${inner}<source>${xmlEscapeText(card.source || "enhance")}</source>`);
  lines.push(`${inner}<created-at>${xmlEscapeText(card.created_at)}</created-at>`);
  lines.push(`${inner}<updated-at>${xmlEscapeText(card.updated_at)}</updated-at>`);
  const stages = Array.isArray(card.stages) ? card.stages : [];
  if (stages.length > 0) {
    lines.push(`${inner}<stages>`);
    for (const stage of stages) {
      lines.push(
        `${stageIndent}<stage n="${xmlEscapeAttr(String(stage.n))}" done="${stage.done === true ? "true" : "false"}">`,
      );
      lines.push(`${itemIndent}<title>${xmlCdata(stage.title || "")}</title>`);
      if (Array.isArray(stage.accept) && stage.accept.length > 0) {
        lines.push(`${itemIndent}<accept>`);
        for (const item of stage.accept) {
          lines.push(`${itemIndent}  <item>${xmlCdata(item)}</item>`);
        }
        lines.push(`${itemIndent}</accept>`);
      }
      if (stage.evidence) {
        lines.push(`${itemIndent}<evidence>${xmlCdata(stage.evidence)}</evidence>`);
      }
      if (stage.checked_at) {
        lines.push(`${itemIndent}<checked-at>${xmlEscapeText(stage.checked_at)}</checked-at>`);
      }
      lines.push(`${stageIndent}</stage>`);
    }
    lines.push(`${inner}</stages>`);
  } else {
    lines.push(`${inner}<stages/>`);
  }
  lines.push(`${indent}</card>`);
}

function renderTaskResult({ success, action, card, createdNow, cards, unmet, error, hint }) {
  const lines = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<yce-task>`);
  lines.push(`  <success>${success ? "true" : "false"}</success>`);
  lines.push(`  <action>${xmlEscapeText(action)}</action>`);
  if (card) {
    pushCardXml(lines, card, { createdNow: createdNow === true });
  } else {
    lines.push(`  <card present="false"/>`);
  }
  if (Array.isArray(cards)) {
    lines.push(`  <cards count="${cards.length}">`);
    for (const item of cards) {
      const doneStages = (item.stages || []).filter((stage) => stage.done === true).length;
      lines.push(
        `    <card-summary id="${xmlEscapeAttr(item.id)}" status="${xmlEscapeAttr(item.status)}" stages-done="${doneStages}/${(item.stages || []).length}" updated-at="${xmlEscapeAttr(item.updated_at)}">${xmlCdata(item.goal)}</card-summary>`,
      );
    }
    lines.push(`  </cards>`);
  }
  if (Array.isArray(unmet) && unmet.length > 0) {
    lines.push(`  <unmet count="${unmet.length}">`);
    for (const stage of unmet) {
      lines.push(`    <stage n="${xmlEscapeAttr(String(stage.n))}">${xmlCdata(stage.title || "")}</stage>`);
    }
    lines.push(`  </unmet>`);
  }
  if (error) {
    lines.push(`  <errors><error source="task" code="${xmlEscapeAttr(error.code)}">${xmlCdata(error.message)}</error></errors>`);
  } else {
    lines.push(`  <errors/>`);
  }
  if (hint) {
    lines.push(`  <hint>${xmlCdata(hint)}</hint>`);
  }
  lines.push(`</yce-task>`);
  return lines.join("\n");
}

function collectAccept(args) {
  const raw = args.accept;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * 处理 `yce task <action>`。返回 {output, exitCode}。
 * 用法：
 *   task show [id]                              # 无 id = 最近活跃卡（压缩恢复入口）
 *   task list [--status active|done|archived]
 *   task check <stage-n> [--task <id>] --evidence "<text>"
 *   task done [--task <id>] [--force]
 *   task new --goal "..." [--accept "..." ...] [--title "<阶段标题>"]
 */
function runTaskCommand(args, cwd) {
  const action = String(args._[1] || "show").toLowerCase();
  const explicitId = typeof args.task === "string" ? args.task.trim() : "";

  try {
    switch (action) {
      case "show": {
        const positionalId = typeof args._[2] === "string" ? args._[2].trim() : "";
        const card = resolveCard(cwd, positionalId || explicitId);
        if (!card) {
          return {
            output: renderTaskResult({
              success: false,
              action,
              error: { code: "NOT_FOUND", message: "当前项目没有活跃任务卡。" },
              hint: "先通过 enhance/auto 自动建卡，或 task new --goal 手动建卡。",
            }),
            exitCode: 1,
          };
        }
        return {
          output: renderTaskResult({
            success: true,
            action,
            card,
            hint: "压缩后请以本卡 goal 与验收为准继续推进；阶段完成用 task check 记证据。",
          }),
          exitCode: 0,
        };
      }
      case "list": {
        const status = typeof args.status === "string" ? args.status.trim() : "";
        const cards = listCards(cwd, status ? { status } : {});
        return {
          output: renderTaskResult({ success: true, action, cards }),
          exitCode: 0,
        };
      }
      case "check": {
        const stageN = Number.parseInt(args._[2], 10);
        if (!Number.isInteger(stageN) || stageN <= 0) {
          throw Object.assign(new Error("用法：task check <stage-n> [--task <id>] --evidence \"<text>\""), { code: "INVALID_ARGS" });
        }
        const target = resolveCard(cwd, explicitId);
        if (!target) {
          throw Object.assign(new Error("找不到任务卡：请传 --task <id> 或先建卡。"), { code: "NOT_FOUND" });
        }
        const evidence = typeof args.evidence === "string" ? args.evidence : "";
        const card = checkStage(cwd, target.id, stageN, evidence);
        return {
          output: renderTaskResult({ success: true, action, card }),
          exitCode: 0,
        };
      }
      case "done": {
        const target = resolveCard(cwd, explicitId);
        if (!target) {
          throw Object.assign(new Error("找不到任务卡：请传 --task <id> 或先建卡。"), { code: "NOT_FOUND" });
        }
        const result = completeCard(cwd, target.id, { force: args.force === true });
        if (!result.ok) {
          return {
            output: renderTaskResult({
              success: false,
              action,
              card: result.card,
              unmet: result.unmet,
              error: {
                code: "ACCEPTANCE_UNMET",
                message: `还有 ${result.unmet.length} 个阶段未通过验收；逐条补齐证据后重试，或 --force 强制完成。`,
              },
            }),
            exitCode: 1,
          };
        }
        return {
          output: renderTaskResult({ success: true, action, card: result.card }),
          exitCode: 0,
        };
      }
      case "new": {
        const goal = typeof args.goal === "string" ? args.goal : "";
        const accept = collectAccept(args);
        const stages = accept.length > 0
          ? [{ title: typeof args.title === "string" && args.title.trim() ? args.title.trim() : "验收", accept }]
          : [];
        const card = createCard({ cwd, goal, stages, task: goal, source: "manual" });
        return {
          output: renderTaskResult({ success: true, action, card, createdNow: true }),
          exitCode: 0,
        };
      }
      default:
        throw Object.assign(
          new Error(`未知 task 子命令：${action}（支持 show|list|check|done|new）`),
          { code: "INVALID_ARGS" },
        );
    }
  } catch (error) {
    return {
      output: renderTaskResult({
        success: false,
        action,
        error: {
          code: error && error.code ? error.code : "EXEC_ERROR",
          message: error && error.message ? error.message : String(error),
        },
      }),
      exitCode: 1,
    };
  }
}

module.exports = { runTaskCommand, pushCardXml, renderTaskResult };
