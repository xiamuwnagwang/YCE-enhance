/**
 * Strict validation and JSON handling for the small Windows process-query
 * command exposed by the restricted executor.
 *
 * This module deliberately does not parse general PowerShell. The command is
 * treated as a protocol value, not as a shell script: only the two supported
 * command shapes below can reach powershell.exe.
 */

const MAX_PROCESS_IDS = 64;
const MAX_PROCESS_RECORDS = 256;
const MAX_UINT32 = 0xffffffff;

/**
 * The command accepted by older Windows integrations.
 *
 * It is intentionally an exact command. A broad "contains Get-CimInstance"
 * check would turn this compatibility path into arbitrary PowerShell access.
 */
export const LEGACY_PROCESS_QUERY_COMMAND = "Get-CimInstance Win32_Process";

const DYNAMIC_FILTER_COMMAND_RE =
  /^Get-CimInstance[ \t]+Win32_Process[ \t]+-Filter[ \t]+"([^"\r\n]*)"[ \t]*$/i;
const DYNAMIC_FILTER_EXPRESSION_RE =
  /^ProcessId[ \t]*=[ \t]*([1-9]\d*)(?:[ \t]+OR[ \t]+ProcessId[ \t]*=[ \t]*([1-9]\d*))*$/i;
const PROCESS_ID_TOKEN_RE = /ProcessId[ \t]*=[ \t]*([1-9]\d*)/gi;

function invalid(reason) {
  return { ok: false, reason };
}

function parsePid(rawPid) {
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_UINT32) {
    return null;
  }
  return pid;
}

function extractPids(filterExpression) {
  if (!DYNAMIC_FILTER_EXPRESSION_RE.test(filterExpression)) {
    return null;
  }

  const pids = [];
  for (const match of filterExpression.matchAll(PROCESS_ID_TOKEN_RE)) {
    const pid = parsePid(match[1]);
    if (pid === null) return null;
    pids.push(pid);
  }

  if (pids.length === 0 || pids.length > MAX_PROCESS_IDS) return null;
  if (new Set(pids).size !== pids.length) return null;
  return pids;
}

/**
 * Classify a PowerShell command without executing it.
 *
 * @param {unknown} command
 * @returns {{ok: true, kind: string, command: string, pids: number[]|null}|{ok: false, reason: string}}
 */
export function classifyPowerShellCommand(command) {
  if (typeof command !== "string") {
    return invalid("command must be a string");
  }
  if (/[\r\n\0]/.test(command)) {
    return invalid("newlines and NUL bytes are not allowed");
  }

  const normalized = command.trim();
  if (!normalized) return invalid("command must not be empty");

  if (normalized === LEGACY_PROCESS_QUERY_COMMAND) {
    return {
      ok: true,
      kind: "legacy_process_snapshot",
      command: normalized,
      pids: null,
    };
  }

  const match = normalized.match(DYNAMIC_FILTER_COMMAND_RE);
  if (!match) {
    return invalid(
      "only the exact Get-CimInstance Win32_Process command or the strict ProcessId filter form is allowed",
    );
  }

  const pids = extractPids(match[1]);
  if (!pids) {
    return invalid("the -Filter expression must contain unique positive ProcessId values joined only by OR");
  }

  return {
    ok: true,
    kind: "dynamic_pid_filter",
    command: normalized,
    pids,
  };
}

/**
 * Add the fixed JSON serializer after an already validated query.
 *
 * The caller must pass the returned string as one argv value to execFile;
 * this function never creates a shell command line.
 *
 * @param {unknown} command
 * @returns {string}
 */
export function buildPowerShellProcessQueryScript(command) {
  const classification = classifyPowerShellCommand(command);
  if (!classification.ok) {
    throw new Error(`PowerShell command rejected: ${classification.reason}`);
  }
  return `${classification.command} | ConvertTo-Json -Compress`;
}

function normalizeExpectedPids(expectedPids) {
  if (expectedPids == null) return null;
  if (!Array.isArray(expectedPids) || expectedPids.length === 0) {
    throw new Error("expected ProcessId values must be a non-empty array");
  }
  const normalized = expectedPids.map(parsePid);
  if (normalized.some((pid) => pid === null)) {
    throw new Error("expected ProcessId values must be positive 32-bit integers");
  }
  return new Set(normalized);
}

/**
 * Parse ConvertTo-Json output from the supported process query.
 * PowerShell emits an object for one result and an array for multiple results;
 * callers always receive an array. ProcessId must remain a JSON number.
 *
 * @param {unknown} rawJson
 * @param {number[]|null} [expectedPids]
 * @returns {Array<Record<string, unknown>>}
 */
export function parseProcessFilterJson(rawJson, expectedPids = null) {
  if (typeof rawJson !== "string") {
    throw new Error("PowerShell process output must be a JSON string");
  }

  const text = rawJson.replace(/^\uFEFF/, "").trim();
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("PowerShell process output is not valid JSON");
  }

  if (parsed === null) return [];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length > MAX_PROCESS_RECORDS) {
    throw new Error(`PowerShell process output contains more than ${MAX_PROCESS_RECORDS} records`);
  }

  const expected = normalizeExpectedPids(expectedPids);
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("PowerShell process output must contain JSON objects");
    }

    const pid = record.ProcessId;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > MAX_UINT32) {
      throw new Error("PowerShell process output contains an invalid numeric ProcessId");
    }
    if (expected && !expected.has(pid)) {
      throw new Error(`PowerShell process output contains unexpected ProcessId ${pid}`);
    }
  }

  return records;
}
