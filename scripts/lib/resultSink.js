"use strict";

/**
 * Writes YCE results to disk and emits a small stdout receipt.
 *
 * Rationale: a full result on stdout can be silently truncated by the host
 * before the agent ever sees it, and the truncated text carries no way to tell.
 * The receipt is a few hundred bytes, so it cannot be truncated, and the file
 * carries a tail sentinel so any reader can prove it read the whole thing.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  attachSentinel,
  byteLength,
  sha256,
} = require("./resultGate");

const RECEIPT_SCHEMA = "yce-receipt/1";
const MAX_ERROR_MESSAGE = 300;
const MAX_ERRORS = 5;
const MAX_REASONS = 10;
const MAX_REASON_LENGTH = 200;
// The receipt's whole point is being too small to truncate, so cap it.
const MAX_RECEIPT_BYTES = 4096;
const STALE_RESULT_MS = 3 * 24 * 60 * 60 * 1000;

function defaultResultDir() {
  const configured = String(process.env.YCE_RESULT_DIR || "").trim();
  if (configured) return configured;
  return path.join(os.tmpdir(), "yce-results");
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function looksLikeDirectory(target) {
  if (target.endsWith(path.sep) || target.endsWith("/")) return true;
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {{ outArg?: string, mode?: string }} options
 * @returns {string} absolute file path to write
 */
function resolveResultPath(options = {}) {
  const outArg = String(options.outArg || "").trim();
  const mode = String(options.mode || "yce").toLowerCase();
  // Random suffix: pid + second-resolution timestamp collide when one process
  // writes twice in the same second.
  const unique = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const fileName = `yce-${mode}-${timestampSlug()}-${unique}.xml`;

  if (!outArg) {
    return path.join(defaultResultDir(), fileName);
  }
  const resolved = path.resolve(outArg);
  if (looksLikeDirectory(resolved)) {
    return path.join(resolved, fileName);
  }
  return resolved;
}

/** Best-effort pruning so the default temp dir cannot grow without bound. */
function pruneStaleResults(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_RESULT_MS;
  for (const entry of entries) {
    if (!/^yce-.*\.xml$/.test(entry)) continue;
    const target = path.join(dir, entry);
    try {
      if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
    } catch {}
  }
}

/**
 * Atomically write body + tail sentinel.
 * @returns {{ path: string, bytes: number, sha256: string }}
 */
function writeResultFile(body, filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const staging = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(staging, attachSentinel(body), { mode: 0o600 });
  fs.renameSync(staging, filePath);
  pruneStaleResults(dir);
  return { path: filePath, bytes: byteLength(body), sha256: sha256(body) };
}

function trimErrors(errors) {
  if (!Array.isArray(errors)) return [];
  const kept = errors.slice(0, MAX_ERRORS).map((item) => {
    const message = String((item && item.message) || "");
    return {
      source: (item && item.source) || null,
      code: (item && item.code) || null,
      message:
        message.length > MAX_ERROR_MESSAGE
          ? `${message.slice(0, MAX_ERROR_MESSAGE)}… (truncated in receipt; full text in result_file)`
          : message,
    };
  });
  if (errors.length > MAX_ERRORS) {
    kept.push({
      source: "receipt",
      code: "MORE_ERRORS",
      message: `${errors.length - MAX_ERRORS} more error(s) in result_file`,
    });
  }
  return kept;
}

function trimReasons(reasons) {
  if (!Array.isArray(reasons)) return [];
  const kept = reasons
    .slice(0, MAX_REASONS)
    .map((reason) =>
      String(reason).length > MAX_REASON_LENGTH
        ? `${String(reason).slice(0, MAX_REASON_LENGTH)}…`
        : String(reason),
    );
  if (reasons.length > MAX_REASONS) {
    kept.push(`… ${reasons.length - MAX_REASONS} more reason(s)`);
  }
  return kept;
}

function nextStepFor(summary, written) {
  if (!summary.complete) {
    return `Result file looks incomplete. Re-run YCE; do not use ${written.path}.`;
  }
  if (!summary.ok) {
    return "No usable primary result. Fix the errors below before touching code.";
  }
  return `Read ${written.path} in full (paged reads are fine); the LAST line of the file is the yce:eof sentinel — a sentinel seen mid-file is quoted result content, not the end. Re-check with: node ./scripts/validate-yce-result.mjs "${written.path}" --expect-sha256 ${written.sha256} --expect-bytes ${written.bytes}`;
}

/**
 * Build the stdout receipt. Deliberately small and free of result payload.
 */
function buildReceipt(summary, written, exitCode) {
  const receipt = {
    schema: RECEIPT_SCHEMA,
    ok: summary.ok,
    exit_code: exitCode,
    gate: summary.gate,
    mode: summary.mode,
    resolved_action: summary.resolved_action,
    required_result: summary.required_result,
    result_file: written.path,
    xml_bytes: written.bytes,
    xml_sha256: written.sha256,
    eof_sentinel: true,
    next_step: nextStepFor(summary, written),
    task_context: summary.task_context,
    errors: trimErrors(summary.errors),
    reasons: trimReasons(summary.reasons),
  };

  let text = `<yce-receipt>\n${JSON.stringify(receipt, null, 2)}\n</yce-receipt>`;
  if (byteLength(text) > MAX_RECEIPT_BYTES) {
    // Last resort: keep the gate and the pointer, drop the prose.
    receipt.errors = (receipt.errors || []).map((item) => ({
      source: item.source,
      code: item.code,
      message: "(omitted to keep the receipt small; see result_file)",
    }));
    receipt.reasons = [`${(summary.reasons || []).length} reason(s) omitted; see result_file`];
    text = `<yce-receipt>\n${JSON.stringify(receipt, null, 2)}\n</yce-receipt>`;
  }
  return text;
}

module.exports = {
  RECEIPT_SCHEMA,
  buildReceipt,
  defaultResultDir,
  pruneStaleResults,
  resolveResultPath,
  writeResultFile,
};
