#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const CORE_PATH = join(SCRIPT_DIR, "lib", "core.mjs");

function usage() {
  return `Usage:
  yce-engine --query <query> [--project <path>] [options]
  yce-engine --check-key [--db-path <path>]
  yce-engine --print-key [--db-path <path>]
  yce-engine --key-env [--db-path <path>]

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
      --check-key                 Verify Windsurf key discovery without printing the full key
      --print-key                 Print the full discovered Windsurf key to stdout
      --key-env                   Print an export command for YCE_API_KEY
      --db-path <path>            Custom Windsurf state.vscdb path for key commands
      --help                      Show this help`;
}

function parseInteger(name, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
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
    printKey: false,
    keyEnv: false,
    dbPath: undefined,
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
      case "--print-key":
        opts.printKey = true;
        break;
      case "--key-env":
        opts.keyEnv = true;
        break;
      case "--db-path":
        opts.dbPath = takeValue(argv, i, arg);
        i++;
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
  if (opts.dbPath) opts.dbPath = resolve(opts.dbPath);
  opts.excludePaths = [...new Set(opts.excludePaths)];
  const keyCommandCount = [opts.checkKey, opts.printKey, opts.keyEnv].filter(Boolean).length;
  if (keyCommandCount > 1) {
    throw new Error("Choose only one key command: --check-key, --print-key, or --key-env");
  }
  return opts;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  return `${key.slice(0, 8)}...${key.slice(-6)}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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

async function main() {
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
    const { searchWithContent, extractKeyInfo } = await loadCore();

    if (opts.checkKey || opts.printKey || opts.keyEnv) {
      const result = await extractKeyInfo(opts.dbPath);
      if (result.error) {
        console.error(`Windsurf key discovery failed: ${result.error}`);
        if (result.hint) console.error(result.hint);
        if (result.db_path) console.error(`DB path: ${result.db_path}`);
        process.exit(1);
      }

      if (opts.printKey) {
        console.log(result.api_key);
        return;
      }

      if (opts.keyEnv) {
        console.log(`export YCE_API_KEY=${shellQuote(result.api_key)}`);
        return;
      }

      const { isUsableDiscoveredApiKey } = await import(
        pathToFileURL(join(SCRIPT_DIR, "lib", "extract-key.mjs")).href
      );
      if (!isUsableDiscoveredApiKey(result.api_key)) {
        console.error("Windsurf key found in state.vscdb but format is not usable for search.");
        console.error("Set YCE_API_KEY or WINDSURF_API_KEY, or re-login Windsurf desktop.");
        console.error(`Key prefix: ${maskKey(result.api_key)}`);
        console.error(`Source: ${result.db_path}`);
        process.exit(1);
      }

      console.log("Windsurf key discovered (search-ready).");
      console.log(`Key: ${maskKey(result.api_key)}`);
      console.log(`Source: ${result.db_path}`);
      return;
    }

    if (!opts.query) {
      console.error("Error: --query is required.\n");
      console.error(usage());
      process.exit(2);
    }

    const output = await searchWithContent({
      query: opts.query,
      projectRoot: opts.projectRoot,
      maxTurns: opts.maxTurns,
      maxCommands: opts.maxCommands,
      maxResults: opts.maxResults,
      treeDepth: opts.treeDepth,
      timeoutMs: opts.timeoutMs,
      excludePaths: opts.excludePaths,
      repoMapMode: opts.repoMapMode,
      bootstrapTreeDepth: opts.bootstrapTreeDepth,
      hotspotTopK: opts.hotspotTopK,
      hotspotTreeDepth: opts.hotspotTreeDepth,
      hotspotMaxBytes: opts.hotspotMaxBytes,
      bootstrapEnabled: opts.bootstrapEnabled,
      bootstrapMaxTurns: opts.bootstrapMaxTurns,
      bootstrapMaxCommands: opts.bootstrapMaxCommands,
    });

    console.log(output);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
