const { buildError, extractEnhancedBlock, extractTaskPlanBlock, isNonEmptyString, parseEnhancedContent, summarizeText } = require("../utils");
const {
  formatModelLabel,
  readJsonFile,
  resolveLocalModels,
  resolveYPlanConfigPath,
  resolveYPlanScript,
  runLocalModel,
} = require("./localModel");

function buildEnhancePrompt({ prompt, history, noSearch, language }) {
  const languageLine =
    language === "en-US"
      ? "Write the enhanced prompt in English."
      : "用中文写增强后的提示词正文。";
  const searchLine = noSearch
    ? "不要搜索或读取代码仓库。"
    : "如果需要理解任务，可以参考当前工作目录，但不要修改任何文件。";
  const historyBlock = isNonEmptyString(history)
    ? `\n对话历史：\n${String(history).trim()}\n`
    : "";
  return `你只做提示词增强，不执行任务，不改文件。
${languageLine}
${searchLine}

按下面格式输出，不要输出格式之外的解释：

<enhanced>
推荐技能：
- 技能名: 一句话理由

增强提示词正文：
把用户任务改写成更具体、可执行的提示词。保留用户给出的标识符、路径、命令和报错原文。
</enhanced>

用户任务：
${String(prompt || "").trim()}
${historyBlock}`;
}

function parseLocalEnhanceOutput(stdout) {
  const raw = String(stdout || "").trim();
  const block = extractEnhancedBlock(raw);
  if (block) {
    const parsed = parseEnhancedContent(block);
    return {
      prompt: parsed.prompt,
      recommended_skills: parsed.recommendedSkills,
      task_plan: extractTaskPlanBlock(raw),
    };
  }
  if (raw) {
    return {
      prompt: raw,
      recommended_skills: [],
      task_plan: extractTaskPlanBlock(raw),
    };
  }
  return { prompt: null, recommended_skills: [], task_plan: null };
}

async function runPromptEnhanceLocal({
  prompt,
  history,
  timeoutMs,
  noSearch,
  language,
  cwd,
  customProvider,
  cliPath,
  skillRoot,
  configPath,
}) {
  const enhance = {
    executed: true,
    success: false,
    prompt: null,
    recommended_skills: [],
    task_plan: null,
    raw_stdout: null,
    stderr_summary: [],
    used_history: isNonEmptyString(history),
    backend: "local",
    runtime: null,
  };

  const scriptPath = resolveYPlanScript({ cliPath, skillRoot });
  const resolvedConfigPath = resolveYPlanConfigPath({
    configPath,
    scriptPath,
  });
  const sourceConfig = readJsonFile(resolvedConfigPath);
  const resolved = resolveLocalModels({
    sourceConfig,
    customProvider,
  });
  if (resolved.error) {
    return {
      enhance,
      error: buildError("prompt-enhance", "DEPENDENCY_NOT_FOUND", resolved.error),
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const enhancePrompt = buildEnhancePrompt({
    prompt,
    history,
    noSearch,
    language,
  });
  const budgetMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300000;
  let lastError = "";
  for (const modelChoice of resolved.models) {
    enhance.runtime = formatModelLabel(modelChoice);
    const result = await runLocalModel(modelChoice, enhancePrompt, {
      cwd: cwd || process.cwd(),
      timeoutMs: budgetMs,
    });
    enhance.raw_stdout = result.stdout || null;
    enhance.stderr_summary = summarizeText(result.stderr);
    if (result.timedOut) {
      return {
        enhance,
        error: buildError(
          "prompt-enhance",
          "TIMEOUT",
          `本地提示词增强在 ${budgetMs}ms 后超时。`,
        ),
        durationMs: Date.now() - startedAt,
      };
    }
    if (result.code === 0 && isNonEmptyString(result.stdout)) {
      const parsed = parseLocalEnhanceOutput(result.stdout);
      if (isNonEmptyString(parsed.prompt)) {
        enhance.success = true;
        enhance.prompt = parsed.prompt;
        enhance.recommended_skills = parsed.recommended_skills;
        enhance.task_plan = parsed.task_plan;
        return {
          enhance,
          error: null,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    lastError = String(result.stderr || result.stdout || "").trim().slice(0, 800);
  }

  return {
    enhance,
    error: buildError(
      "prompt-enhance",
      "EXEC_ERROR",
      lastError || "本地提示词增强没有返回可用内容。",
    ),
    durationMs: Date.now() - startedAt,
  };
}

async function runStdio() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const result = await runPromptEnhanceLocal(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module && process.argv.includes("--stdio")) {
  runStdio().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({
        enhance: {
          executed: true,
          success: false,
          backend: "local",
        },
        error: {
          source: "prompt-enhance",
          code: "EXEC_ERROR",
          message: error && error.message ? error.message : String(error),
        },
        durationMs: 0,
      })}\n`,
    );
    process.exit(1);
  });
}

module.exports = { runPromptEnhanceLocal };
