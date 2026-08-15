"use strict";

/**
 * Shared YCE result integrity + consumption gate.
 *
 * Single implementation used by both the CLI (writes results, emits the
 * receipt) and scripts/validate-yce-result.mjs (re-checks a saved file).
 *
 * Exit codes:
 *   0  complete and the required result-present gate passed
 *   1  usage / IO error
 *   2  incomplete, truncated, or unparseable
 *   3  complete but the required result is missing
 */

const { createHash } = require("node:crypto");

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_INCOMPLETE = 2;
const EXIT_MISSING_RESULT = 3;

const SENTINEL_VERSION = 1;
const SENTINEL_RE =
  /<!--\s*yce:eof\s+v=(\d+)\s+bytes=(\d+)\s+sha256=([0-9a-f]{64})\s*-->/g;

const HOST_TRUNCATION_RE =
  /\[\s*truncated\s*\]|token limit|output (was )?truncated|truncated due to|response truncated|maximum (output|length|token)|\d+\s+(lines|characters|bytes)\s+(truncated|omitted|elided)|\.\.\.\s*\[[^\]]*truncated[^\]]*\]/i;

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/** Build the tail sentinel that makes a saved result self-verifying. */
function buildSentinel(body) {
  return `<!-- yce:eof v=${SENTINEL_VERSION} bytes=${byteLength(body)} sha256=${sha256(body)} -->`;
}

/** Final on-disk shape: body, newline, sentinel, trailing newline. */
function attachSentinel(body) {
  return `${body}\n${buildSentinel(body)}\n`;
}

/**
 * Split a saved result into body + declared integrity.
 *
 * A result can legitimately quote a sentinel — searching this repo returns
 * resultGate.js itself — so a match only counts when it is the single match in
 * the file AND nothing but whitespace follows it. Anything else degrades to
 * "unverified" rather than trusting an embedded sentinel, which would otherwise
 * let a quoted sentinel vouch for a prefix of the real result.
 */
function parseSentinel(raw) {
  SENTINEL_RE.lastIndex = 0;
  const matches = [];
  let match = null;
  while ((match = SENTINEL_RE.exec(raw))) {
    matches.push(match);
  }
  if (matches.length === 0) {
    return { body: raw, sentinel: null, ambiguous: false, atEnd: false };
  }

  const last = matches[matches.length - 1];
  const atEnd = raw.slice(last.index + last[0].length).trim() === "";
  const ambiguous = matches.length > 1;

  // Strip a trailing sentinel line regardless of trust, so receipt comparison
  // sees the same bytes the CLI hashed even when the result quotes a sentinel.
  let body = raw;
  if (atEnd) {
    body = raw.slice(0, last.index);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    else if (body.endsWith("\n")) body = body.slice(0, -1);
  }

  return {
    body,
    sentinel:
      atEnd && !ambiguous
        ? {
            version: Number(last[1]),
            bytes: Number(last[2]),
            sha256: last[3],
          }
        : null,
    ambiguous,
    atEnd,
  };
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

/**
 * Walk the markup outside CDATA/comments and return the element-level text
 * plus any tag nesting defect. A host that elides a middle chunk leaves the
 * tag stack unbalanced even when <yce> and </yce> both survive, which is the
 * only structural signal that does not rely on a truncation marker.
 */
function scanMarkup(xml) {
  const stack = [];
  const defects = [];
  let markupOnly = "";
  let index = 0;

  while (index < xml.length) {
    if (xml.startsWith("<![CDATA[", index)) {
      const close = xml.indexOf("]]>", index + 9);
      if (close < 0) {
        defects.push("unterminated CDATA section");
        break;
      }
      index = close + 3;
      continue;
    }
    if (xml.startsWith("<!--", index)) {
      const close = xml.indexOf("-->", index + 4);
      if (close < 0) {
        defects.push("unterminated comment");
        break;
      }
      index = close + 3;
      continue;
    }
    if (xml[index] !== "<") {
      markupOnly += xml[index];
      index += 1;
      continue;
    }

    // Read one tag, honouring quoted attribute values that may contain ">".
    let cursor = index + 1;
    let quote = "";
    while (cursor < xml.length) {
      const char = xml[cursor];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      cursor += 1;
    }
    if (cursor >= xml.length) {
      defects.push("unterminated tag");
      break;
    }

    const inner = xml.slice(index + 1, cursor);
    index = cursor + 1;

    if (inner.startsWith("?") || inner.startsWith("!")) continue;
    if (inner.endsWith("/")) continue;

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      if (stack.length === 0) {
        defects.push(`unexpected closing tag </${name}>`);
        continue;
      }
      const open = stack.pop();
      if (open !== name) {
        defects.push(`tag mismatch: <${open}> closed by </${name}>`);
      }
      continue;
    }

    const name = inner.split(/[\s/]/, 1)[0];
    if (name) stack.push(name);
  }

  if (stack.length > 0) {
    defects.push(`unclosed tag${stack.length > 1 ? "s" : ""}: <${stack.join(">, <")}>`);
  }
  return { defects, markupOnly };
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

/**
 * @param {string} raw full text of a saved result (or piped stdout)
 * @param {{ expectSha256?: string, expectBytes?: number }} [expected]
 *   Values from the CLI receipt. The receipt never travels inside the result,
 *   so passing them makes the check immune to any self-consistent forgery.
 * @returns {object} consumption summary; feed to exitCodeFor()
 */
function buildSummary(raw, expected = {}) {
  const reasons = [];

  // Layer 1: tail sentinel. Present only for CLI-written files, and it is the
  // only check that catches a middle chunk being elided without a marker.
  const { body: afterSentinel, sentinel, ambiguous } = parseSentinel(raw);
  let integrity = "unverified";
  if (sentinel) {
    if (sentinel.version !== SENTINEL_VERSION) {
      integrity = "mismatch";
      reasons.push(`unsupported sentinel version ${sentinel.version}`);
    } else {
      const actualBytes = byteLength(afterSentinel);
      const actualSha = sha256(afterSentinel);
      if (actualBytes !== sentinel.bytes) {
        integrity = "mismatch";
        reasons.push(
          `sentinel byte mismatch (read ${actualBytes}, expected ${sentinel.bytes})`,
        );
      } else if (actualSha !== sentinel.sha256) {
        integrity = "mismatch";
        reasons.push("sentinel sha256 mismatch");
      } else {
        integrity = "verified";
      }
    }
  }
  // An ambiguous or mid-file sentinel is not a defect: a result that quotes a
  // sentinel is legitimate content. Withhold "verified" instead of failing the
  // document, and let the structural checks judge completeness.
  const sentinelAmbiguous = !sentinel && ambiguous;

  // Layer 0: receipt-supplied truth. Outranks the sentinel because it does not
  // come from the file.
  const expectSha = String(expected.expectSha256 || "").trim().toLowerCase();
  const expectBytes = Number.isFinite(expected.expectBytes)
    ? Number(expected.expectBytes)
    : null;
  if (expectSha || expectBytes !== null) {
    // afterSentinel already has a trailing sentinel line removed; the trimmed
    // variant covers piped stdout that has no sentinel at all.
    const candidates = [afterSentinel];
    const trimmed = afterSentinel.replace(/\s+$/, "");
    if (trimmed !== afterSentinel) candidates.push(trimmed);

    const bytesOk =
      expectBytes === null || candidates.some((text) => byteLength(text) === expectBytes);
    const shaOk = !expectSha || candidates.some((text) => sha256(text) === expectSha);

    if (!bytesOk) {
      integrity = "mismatch";
      reasons.push(
        `receipt byte mismatch (read ${byteLength(afterSentinel)}, receipt says ${expectBytes})`,
      );
    }
    if (!shaOk) {
      integrity = "mismatch";
      reasons.push("receipt sha256 mismatch");
    }
    if (bytesOk && shaOk && expectSha && integrity !== "mismatch") {
      integrity = "verified";
    }
  }

  const { consume, body } = splitConsume(afterSentinel);
  if (consume && consume.parse_error) {
    reasons.push("consume JSON parse failed");
  }
  if (consume && Number.isFinite(consume.xml_bytes)) {
    const received = byteLength(body);
    if (received !== consume.xml_bytes) {
      reasons.push(
        `consume xml_bytes mismatch (received ${received}, expected ${consume.xml_bytes})`,
      );
    }
  }

  const root = findRootOutsideCdata(body);
  if (root.start < 0) reasons.push("missing <yce> root");
  else if (root.end < 0) reasons.push("missing </yce> closing tag");

  const xml = root.start >= 0 && root.end > root.start ? body.slice(root.start, root.end) : body;
  const rootFound = root.start >= 0 && root.end > root.start;
  if (rootFound && !cdataBalanced(xml)) {
    reasons.push("unbalanced CDATA");
  }

  // Layer 2: structural. A host that keeps head+tail and drops the middle
  // leaves the tag stack unbalanced even though both <yce> and </yce> survive.
  let markupOnly = "";
  let structureBroken = false;
  if (rootFound) {
    const scan = scanMarkup(xml);
    markupOnly = scan.markupOnly;
    structureBroken = scan.defects.length > 0;
    for (const defect of scan.defects) {
      reasons.push(`structure: ${defect}`);
    }
  }

  // Layer 3: host truncation markers. Scanned outside the root and, within the
  // root, only outside CDATA — engine output legitimately says "(lines
  // truncated)" inside CDATA and must not be treated as host truncation.
  const prefix = root.start >= 0 ? body.slice(0, root.start) : body;
  const suffix = root.end > 0 ? body.slice(root.end) : "";
  let hostTruncation = HOST_TRUNCATION_RE.test(prefix) || HOST_TRUNCATION_RE.test(suffix);
  if (!hostTruncation && root.end < 0) {
    const rest = root.start >= 0 ? body.slice(root.start) : body;
    hostTruncation = HOST_TRUNCATION_RE.test(rest);
  }
  if (!hostTruncation && markupOnly && HOST_TRUNCATION_RE.test(markupOnly)) {
    hostTruncation = true;
  }
  if (hostTruncation) {
    reasons.push("host truncation marker (truncated / token limit)");
  }

  const parseOk = reasons.length === 0 && rootFound;
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
    integrity,
    sentinel_ambiguous: sentinelAmbiguous,
    // Broken nesting means content is missing even when no marker survived,
    // so it must read as "did not get the whole thing".
    truncation_detected:
      hostTruncation ||
      structureBroken ||
      integrity === "mismatch" ||
      reasons.some((item) => item.includes("xml_bytes mismatch")),
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

module.exports = {
  EXIT_OK,
  EXIT_USAGE,
  EXIT_INCOMPLETE,
  EXIT_MISSING_RESULT,
  SENTINEL_VERSION,
  attachSentinel,
  buildSentinel,
  buildSummary,
  exitCodeFor,
  parseSentinel,
  sha256,
  byteLength,
};
