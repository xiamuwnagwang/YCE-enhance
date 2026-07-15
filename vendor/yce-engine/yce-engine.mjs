#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadYceIgnore } from "./lib/yce-ignore.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// yce-engine lives at <yce-skill>/vendor/yce-engine — skill root is two levels up.
// .env must be loaded from the YCE skill root, never from this package directory.
const ROOT_DIR = resolveYceSkillRoot(SCRIPT_DIR);
const CORE_PATH = join(SCRIPT_DIR, "lib", "core.mjs");

function resolveYceSkillRoot(scriptDir) {
  const candidates = [
    resolve(scriptDir, "..", ".."), // normal: skill/vendor/yce-engine
    resolve(scriptDir, ".."), // fallback: skill/yce-engine
  ];
  for (const dir of candidates) {
    if (
      existsSync(join(dir, "SKILL.md")) ||
      existsSync(join(dir, "scripts", "yce.js")) ||
      existsSync(join(dir, "install.sh"))
    ) {
      return dir;
    }
  }
  // Default layout: skill/vendor/yce-engine -> skill root
  return resolve(scriptDir, "..", "..");
}

function usage() {
  return `Usage:
  yce-engine --query <query> [--project <path>] [options]
  yce-engine --check-key

Options:
  -q, --query <text>              Natural-language search query
  -p, --project <path>            Project root (default: current directory)
      --project-path <path>       Alias for --project
      --max-results <n>           Max files to return (default: 10)
      --max-turns <n>             Search rounds (default: 3)
      --max-commands <n>          Local commands per round (default: 8)
      --tree-depth <n>            Repo tree depth, 0 for auto (default: 0)
      --timeout-ms <n>            Request timeout (default: 30000)
      --exclude <patterns>        Comma-separated excludes; may be repeated
      --repo-map-mode <mode>      classic or bootstrap_hotspot
      --bootstrap-tree-depth <n>  Bootstrap tree depth
      --hotspot-top-k <n>         Hotspot directory count
      --hotspot-tree-depth <n>    Hotspot subtree depth
      --hotspot-max-bytes <n>     Hotspot repo-map byte budget
      --bootstrap-enabled         Enable bootstrap phase
      --no-bootstrap              Disable bootstrap phase
      --bootstrap-max-turns <n>   Bootstrap phase turns
      --bootstrap-max-commands <n> Bootstrap commands per turn
      --json                      Emit structured JSON for programmatic callers
      --check-key                 Verify relay / YCE_API_KEY without printing the full key
      --help                      Show this help

Project exclusions are also loaded from <project>/.yceignore (one simple glob per line).`;
}

function parseInteger(name, value) {
  const normalized = String(value).trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be an integer, received: ${value}`);
  }
  return parsed;
}

function takeValue(args, index, name) {
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function pushExclude(target, raw) {
  for (const item of String(raw).split(",")) {
    const trimmed = item.trim();
    if (trimmed) target.push(trimmed);
  }
}

function parseArgs(argv) {
  const opts = {
    projectRoot: process.cwd(),
    maxResults: 10,
    maxTurns: 3,
    maxCommands: 8,
    treeDepth: 0,
    timeoutMs: 30000,
    excludePaths: [],
    repoMapMode: "bootstrap_hotspot",
    bootstrapEnabled: true,
    bootstrapTreeDepth: 1,
    hotspotTopK: 4,
    hotspotTreeDepth: 2,
    hotspotMaxBytes: 120 * 1024,
    bootstrapMaxTurns: 2,
    bootstrapMaxCommands: 6,
    checkKey: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-q":
      case "--query":
        opts.query = takeValue(argv, i, arg);
        i++;
        break;
      case "-p":
      case "--project":
      case "--project-path":
        opts.projectRoot = takeValue(argv, i, arg);
        i++;
        break;
      case "--max-results":
        opts.maxResults = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--max-turns":
        opts.maxTurns = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--max-commands":
        opts.maxCommands = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--tree-depth":
        opts.treeDepth = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--timeout-ms":
        opts.timeoutMs = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--exclude":
        pushExclude(opts.excludePaths, takeValue(argv, i, arg));
        i++;
        break;
      case "--repo-map-mode":
        opts.repoMapMode = takeValue(argv, i, arg);
        i++;
        break;
      case "--bootstrap-tree-depth":
        opts.bootstrapTreeDepth = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--hotspot-top-k":
        opts.hotspotTopK = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--hotspot-tree-depth":
        opts.hotspotTreeDepth = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--hotspot-max-bytes":
        opts.hotspotMaxBytes = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--bootstrap-enabled":
        opts.bootstrapEnabled = true;
        break;
      case "--no-bootstrap":
        opts.bootstrapEnabled = false;
        break;
      case "--bootstrap-max-turns":
        opts.bootstrapMaxTurns = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--bootstrap-max-commands":
        opts.bootstrapMaxCommands = parseInteger(arg, takeValue(argv, i, arg));
        i++;
        break;
      case "--check-key":
        opts.checkKey = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  opts.projectRoot = resolve(opts.projectRoot);
  opts.excludePaths = [...new Set(opts.excludePaths)];
  validateOptions(opts);
  return opts;
}

function validateRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, received: ${value}`);
  }
}

function validateOptions(opts) {
  validateRange("--max-results", opts.maxResults, 1, 30);
  validateRange("--max-turns", opts.maxTurns, 1, 5);
  validateRange("--max-commands", opts.maxCommands, 1, 20);
  validateRange("--tree-depth", opts.treeDepth, 0, 6);
  validateRange("--timeout-ms", opts.timeoutMs, 1000, 300000);
  validateRange("--bootstrap-tree-depth", opts.bootstrapTreeDepth, 1, 3);
  validateRange("--hotspot-top-k", opts.hotspotTopK, 0, 8);
  validateRange("--hotspot-tree-depth", opts.hotspotTreeDepth, 1, 4);
  validateRange("--hotspot-max-bytes", opts.hotspotMaxBytes, 16 * 1024, 250 * 1024);
  validateRange("--bootstrap-max-turns", opts.bootstrapMaxTurns, 1, 5);
  validateRange("--bootstrap-max-commands", opts.bootstrapMaxCommands, 1, 20);
  if (!new Set(["classic", "bootstrap_hotspot"]).has(opts.repoMapMode)) {
    throw new Error(`--repo-map-mode must be classic or bootstrap_hotspot, received: ${opts.repoMapMode}`);
  }
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  return `${key.slice(0, 8)}...${key.slice(-6)}`;
}

async function loadCore() {
  if (!existsSync(CORE_PATH)) {
    throw new Error(
      `yce-engine vendored core is missing at ${CORE_PATH}\n` +
        `Reinstall or repair the yce skill.`
    );
  }
  return import(pathToFileURL(CORE_PATH).href);
}

function applyEnvFile(envPath) {
  if (!existsSync(envPath)) return false;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key] || !String(process.env[key]).trim()) {
      process.env[key] = value;
    }
  }
  return true;
}

function loadRuntimeDotEnv() {
  const skillEnvPath = join(ROOT_DIR, ".env");
  const wrongEngineEnvPath = join(SCRIPT_DIR, ".env");

  const loadedSkill = applyEnvFile(skillEnvPath);

  // Compatibility only: if someone wrongly put .env next to yce-engine.mjs, still load it
  // after skill-root values (skill root already applied wins for set keys).
  if (!loadedSkill && existsSync(wrongEngineEnvPath)) {
    applyEnvFile(wrongEngineEnvPath);
    console.error(
      `Warning: .env found at ${wrongEngineEnvPath}; expected YCE skill root: ${skillEnvPath}`
    );
  }

  if (!process.env.YCE_RELAY_URL) {
    process.env.YCE_RELAY_URL = "https://yce.aigy.de";
  }
}

async function main() {
  loadRuntimeDotEnv();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    console.error(usage());
    process.exit(2);
  }

  if (opts.help) {
    console.log(usage());
    return;
  }

  try {
    const { searchWithContent, searchWithDetails, extractKeyInfo } = await loadCore();

    if (opts.checkKey) {
      const result = await extractKeyInfo();
      if (result.error) {
        console.error(`YCE key discovery failed: ${result.error}`);
        if (result.hint) console.error(result.hint);
        if (result.detail) console.error(result.detail);
        if (result.db_path) console.error(`Relay: ${result.db_path}`);
        process.exit(1);
      }

      console.log("YCE key ready (search-ready).");
      console.log(`Key: ${maskKey(result.api_key)}`);
      console.log(`Source: ${result.db_path}`);
      return;
    }

    if (!opts.query) {
      console.error("Error: --query is required.\n");
      console.error(usage());
      process.exit(2);
    }

    const ignore = loadYceIgnore(opts.projectRoot);
    const excludePaths = [...new Set([...ignore.patterns, ...opts.excludePaths])];
    const searchOptions = {
      query: opts.query,
      projectRoot: opts.projectRoot,
      maxTurns: opts.maxTurns,
      maxCommands: opts.maxCommands,
      maxResults: opts.maxResults,
      treeDepth: opts.treeDepth,
      timeoutMs: opts.timeoutMs,
      excludePaths,
      repoMapMode: opts.repoMapMode,
      bootstrapTreeDepth: opts.bootstrapTreeDepth,
      hotspotTopK: opts.hotspotTopK,
      hotspotTreeDepth: opts.hotspotTreeDepth,
      hotspotMaxBytes: opts.hotspotMaxBytes,
      bootstrapEnabled: opts.bootstrapEnabled,
      bootstrapMaxTurns: opts.bootstrapMaxTurns,
      bootstrapMaxCommands: opts.bootstrapMaxCommands,
    };

    if (opts.json) {
      const details = await searchWithDetails(searchOptions);
      details.diagnostics.ignore_file = ignore.path;
      details.diagnostics.ignore_patterns = ignore.patterns;
      console.log(JSON.stringify(details));
      return;
    }

    console.log(await searchWithContent(searchOptions));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
