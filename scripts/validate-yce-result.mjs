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
