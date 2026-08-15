#!/usr/bin/env node
/**
 * Deterministic YCE XML consumption gate.
 * Do not eyeball XML. Pass the saved result file (or pipe it) to this script.
 *
 * The checks live in scripts/lib/resultGate.js so the CLI receipt and this
 * re-check can never disagree.
 *
 * Exit codes:
 *   0  complete and the required result-present gate passed
 *   1  usage / IO error
 *   2  incomplete, truncated, or unparseable
 *   3  complete but the required result is missing
 */

import { readFileSync } from "node:fs";
import gate from "./lib/resultGate.js";

const { buildSummary, exitCodeFor, EXIT_USAGE } = gate;

function usage(message) {
  const text = [
    message || "Missing input.",
    "Usage:",
    "  node ./scripts/validate-yce-result.mjs <file.xml>",
    "  node ./scripts/validate-yce-result.mjs <file.xml> --expect-sha256 <hex> [--expect-bytes <n>]",
    "  node ./scripts/validate-yce-result.mjs -",
    "  ... | node ./scripts/validate-yce-result.mjs",
    "",
    "Pass the receipt's xml_sha256 / xml_bytes to check against a value that",
    "does not come from the file itself.",
  ].join("\n");
  process.stderr.write(`${text}\n`);
}

function parseFlags(argv) {
  const positional = [];
  const expected = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--expect-sha256") {
      expected.expectSha256 = argv[index + 1];
      index += 1;
    } else if (arg === "--expect-bytes") {
      expected.expectBytes = Number(argv[index + 1]);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { target: positional[0], expected };
}

function readInput(target) {
  if (!target || target === "-") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(target, "utf8");
}

function main() {
  const { target, expected } = parseFlags(process.argv);
  if (expected.expectBytes !== undefined && !Number.isFinite(expected.expectBytes)) {
    usage("--expect-bytes needs a number.");
    process.exit(EXIT_USAGE);
  }
  if (expected.expectSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(String(expected.expectSha256 || ""))) {
    usage("--expect-sha256 needs a 64-char hex digest.");
    process.exit(EXIT_USAGE);
  }

  let raw;
  try {
    raw = readInput(target);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_USAGE);
  }

  if (!String(raw || "").trim()) {
    usage("Empty input.");
    process.exit(EXIT_USAGE);
  }

  const summary = buildSummary(raw, expected);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(exitCodeFor(summary));
}

main();
