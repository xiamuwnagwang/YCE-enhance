#!/usr/bin/env node
/**
 * Deterministic YCE XML consumption gate.
 * Do not eyeball XML. Pipe or pass the saved stdout file to this script.
 *
 * Exit codes:
 *   0  XML complete and the required result-present gate passed
 *   1  usage / IO error
 *   2  XML incomplete, truncated, or unparseable
 *   3  XML complete but required result is missing
 */

import { readFileSync } from "node:fs";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_INCOMPLETE = 2;
const EXIT_MISSING_RESULT = 3;

const HOST_TRUNCATION_RE =
  /\[\s*truncated\s*\]|token limit|output (was )?truncated|truncated due to|response truncated|maximum (output|length|token)/i;

function usage(message) {
  const text = [
    message || "Missing input.",
    "Usage:",
    "  node ./scripts/validate-yce-result.mjs <file.xml>",
    "  node ./scripts/validate-yce-result.mjs -",
    "  ... | node ./scripts/validate-yce-result.mjs",
  ].join("\n");
  process.stderr.write(`${text}\n`);
}

function readInput(argv) {
  const target = argv[2];
  if (!target || target === "-") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(target, "utf8");
}

function isYceOpen(raw, index) {
  if (!raw.startsWith("<yce", index)) return false;
  const next = raw[index + 4];
  return next === undefined || /[\s>/]/.test(next);
}

function findRootOutsideCdata(raw) {
  let inCdata = false;
  let start = -1;
  for (let index = 0; index < raw.length; index += 1) {
    if (!inCdata && raw.startsWith("<![CDATA[", index)) {
      inCdata = true;
      index += 8;
      continue;
    }
    if (inCdata && raw.startsWith("]]>", index)) {
      inCdata = false;
      index += 2;
      continue;
    }
    if (inCdata) continue;
    if (start < 0 && isYceOpen(raw, index)) {
      start = index;
      continue;
    }
    if (start >= 0 && raw.startsWith("</yce>", index)) {
      return { start, end: index + 6 };
    }
  }
  return { start, end: -1 };
}

function cdataBalanced(raw) {
  let open = 0;
  let close = 0;
  let from = 0;
  while (from < raw.length) {
    const nextOpen = raw.indexOf("<![CDATA[", from);
    const nextClose = raw.indexOf("]]>", from);
    if (nextOpen < 0 && nextClose < 0) break;
    if (nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose)) {
      open += 1;
      from = nextOpen + 9;
    } else {
      close += 1;
      from = nextClose + 3;
    }
  }
  return open === close;
}

function splitConsume(raw) {
  const open = raw.indexOf("<yce-consume>");
  const close = raw.indexOf("</yce-consume>");
  if (open < 0 || close < 0 || close < open) {
    return { consume: null, body: raw };
  }
  let consume = null;
  try {
    consume = JSON.parse(raw.slice(open + "<yce-consume>".length, close).trim());
  } catch {
    consume = { parse_error: true };
  }
  let body = raw.slice(close + "</yce-consume>".length);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { consume, body };
}

function stripCdata(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "");
}

function attr(openTag, name) {
  const match = String(openTag || "").match(
    new RegExp(`(?:^|\\s)${name}="([^"]*)"`),
  );
  return match ? match[1] : null;
}

function boolAttr(openTag, name) {
  return attr(openTag, name) === "true";
}

function firstOpenTag(xml, tagName) {
  const match = xml.match(
    new RegExp(`<${tagName}(?=[\\s>/])([^>]*)(\\/?)>`, "i"),
  );
  if (!match) return null;
  return {
    raw: match[0],
    attrs: match[1] || "",
    selfClosing: match[2] === "/" || /\/\s*$/.test(match[1] || ""),
  };
}

function textOf(xml, tagName) {
  const match = xml.match(
    new RegExp(`<${tagName}(?=[\\s>])[^>]*>([\\s\\S]*?)</${tagName}>`, "i"),
  );
  return match ? stripCdata(match[1]).trim() : "";
}

function collectErrors(xml) {
  const errors = [];
  const block = xml.match(/<errors\b[^>]*>([\s\S]*?)<\/errors>/i);
  if (!block) return errors;
  const re = /<error\b([^>]*)>([\s\S]*?)<\/error>/gi;
  let match;
  while ((match = re.exec(block[1]))) {
    errors.push({
      source: attr(match[1], "source"),
      code: attr(match[1], "code"),
      message: stripCdata(match[2]).trim(),
    });
  }
  return errors;
}

function stageFromTag(xml, tagName) {
  const tag = firstOpenTag(xml, tagName);
  if (!tag) {
    return { executed: false, success: false, result_present: false, empty_result: false, present: false };
  }
  return {
    present: true,
    executed: boolAttr(tag.attrs, "executed"),
    success: boolAttr(tag.attrs, "success"),
    result_present: boolAttr(tag.attrs, "result-present"),
    empty_result: boolAttr(tag.attrs, "empty-result"),
  };
}

function requiredResult(resolvedAction) {
  const action = String(resolvedAction || "");
  if (!action) return { kind: "none", ok: false, reason: "missing resolved-action" };
  if (action === "enhance") return { kind: "enhance", ok: true };
  if (action === "network_search") return { kind: "network", ok: true };
  if (action.includes("plan")) return { kind: "plan", ok: true };
  if (action.includes("search")) return { kind: "search", ok: true };
  return { kind: "unknown", ok: false, reason: `unsupported resolved-action: ${action}` };
}

function taskContextSummary(xml) {
  const tag = firstOpenTag(xml, "task-context");
  if (!tag) {
    return { present: false, created_now: false, id: null };
  }
  const blockMatch = xml.match(/<task-context\b[\s\S]*?<\/task-context>/i);
  const block = blockMatch ? blockMatch[0] : tag.raw;
  return {
    present: attr(tag.attrs, "present") === "true",
    created_now: attr(tag.attrs, "created-now") === "true",
    id: textOf(block, "id") || null,
  };
}

function buildSummary(raw) {
  const { consume, body } = splitConsume(raw);
  const reasons = [];
  if (consume && consume.parse_error) {
    reasons.push("consume JSON parse failed");
  }
  if (consume && Number.isFinite(consume.xml_bytes)) {
    const received = Buffer.byteLength(body, "utf8");
    if (received !== consume.xml_bytes) {
      reasons.push(`consume xml_bytes mismatch (received ${received}, expected ${consume.xml_bytes})`);
    }
  }

  const root = findRootOutsideCdata(body);
  if (root.start < 0) reasons.push("missing <yce> root");
  else if (root.end < 0) reasons.push("missing </yce> closing tag");

  const xml = root.start >= 0 && root.end > root.start ? body.slice(root.start, root.end) : body;
  if (root.start >= 0 && root.end > root.start && !cdataBalanced(xml)) {
    reasons.push("unbalanced CDATA");
  }

  const prefix = root.start >= 0 ? body.slice(0, root.start) : body;
  const suffix = root.end > 0 ? body.slice(root.end) : "";
  let hostTruncation = HOST_TRUNCATION_RE.test(prefix) || HOST_TRUNCATION_RE.test(suffix);
  if (!hostTruncation && root.end < 0) {
    const rest = root.start >= 0 ? body.slice(root.start) : body;
    hostTruncation = HOST_TRUNCATION_RE.test(rest);
  }
  if (hostTruncation) {
    reasons.push("host truncation marker (truncated / token limit)");
  }

  const parseOk = reasons.length === 0 && root.start >= 0 && root.end > root.start;
  const resolvedAction = textOf(xml, "resolved-action");
  const success = textOf(xml, "success") === "true";
  const mode = textOf(xml, "mode");
  const search = stageFromTag(xml, "search");
  const network = stageFromTag(xml, "network-search");
  const plan = stageFromTag(xml, "y-plan");
  const enhanced = stageFromTag(xml, "enhanced");
  const errors = collectErrors(xml);
  const required = requiredResult(resolvedAction);

  let requiredPresent = false;
  if (required.kind === "search") requiredPresent = search.result_present === true;
  else if (required.kind === "network") requiredPresent = network.result_present === true;
  else if (required.kind === "plan") requiredPresent = plan.result_present === true;
  else if (required.kind === "enhance") requiredPresent = enhanced.executed === true;

  if (required.reason) reasons.push(required.reason);
  if (parseOk && required.ok && !requiredPresent) {
    reasons.push(`${required.kind} result-present is not true`);
  }

  const complete = parseOk;
  const ok = complete && required.ok && requiredPresent;
  return {
    ok,
    complete,
    parse_ok: parseOk,
    truncation_detected: hostTruncation || reasons.some((item) => item.includes("xml_bytes mismatch")),
    success,
    mode: mode || null,
    resolved_action: resolvedAction || null,
    required_result: required.kind,
    search: {
      executed: search.executed,
      success: search.success,
      result_present: search.result_present,
      empty_result: search.empty_result,
    },
    network: {
      executed: network.executed,
      success: network.success,
      result_present: network.result_present,
    },
    plan: {
      executed: plan.executed,
      success: plan.success,
      result_present: plan.result_present,
    },
    enhanced: {
      executed: enhanced.executed,
      success: enhanced.success,
    },
    errors,
    task_context: taskContextSummary(xml),
    gate: {
      may_analyze_or_edit_code: complete && search.result_present === true,
      may_use_network_facts: complete && network.result_present === true,
      may_present_plan: complete && plan.result_present === true,
    },
    reasons,
  };
}

function exitCodeFor(summary) {
  if (!summary.complete || !summary.parse_ok || summary.truncation_detected) {
    return EXIT_INCOMPLETE;
  }
  if (!summary.ok) return EXIT_MISSING_RESULT;
  return EXIT_OK;
}

function main() {
  let raw;
  try {
    raw = readInput(process.argv);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_USAGE);
  }

  if (!String(raw || "").trim()) {
    usage("Empty input.");
    process.exit(EXIT_USAGE);
  }

  const summary = buildSummary(raw);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(exitCodeFor(summary));
}

main();
