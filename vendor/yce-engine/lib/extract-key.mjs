/**
 * YCE-compatible API key extraction from local installation.
 *
 * Cross-platform: macOS / Windows / Linux.
 * Uses sql.js (pure JS/WASM) to read state.vscdb — no native compilation needed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import initSqlJs from "sql.js";

/**
 * Get the platform-specific path to the local key database.
 * @returns {string}
 */
export function getDbPath() {
  const plat = platform();
  const home = homedir();

  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "Windsurf", "User", "globalStorage", "state.vscdb");
  } else if (plat === "win32") {
    const appdata = process.env.APPDATA || "";
    if (!appdata) throw new Error("Cannot determine APPDATA path");
    return join(appdata, "Windsurf", "User", "globalStorage", "state.vscdb");
  } else {
    // Linux
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    return join(config, "Windsurf", "User", "globalStorage", "state.vscdb");
  }
}

/**
 * Extract API key from the local key database.
 * @param {string} [dbPath]
 * @returns {Promise<{ api_key?: string, db_path: string, error?: string, hint?: string }>}
 */
export async function extractKey(dbPath) {
  if (!dbPath) {
    dbPath = getDbPath();
  }

  if (!existsSync(dbPath)) {
    return {
      error: `YCE local key database not found: ${dbPath}`,
      hint: "Configure YCE_RELAY_URL/YCE_RELAY_TOKEN or set YCE_API_KEY.",
      db_path: dbPath,
    };
  }

  let db;
  try {
    const SQL = await initSqlJs();
    const buf = readFileSync(dbPath);
    db = new SQL.Database(buf);
  } catch (e) {
    return { error: `Failed to open database: ${e.message}`, db_path: dbPath };
  }

  try {
    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'");
    if (!stmt.step()) {
      stmt.free();
      return {
        error: "windsurfAuthStatus record not found",
        hint: "Configure YCE_RELAY_URL/YCE_RELAY_TOKEN or set YCE_API_KEY.",
        db_path: dbPath,
      };
    }

    const row = stmt.getAsObject();
    stmt.free();

    let data;
    try {
      data = JSON.parse(row.value);
    } catch {
      return { error: "windsurfAuthStatus data parse failed", db_path: dbPath };
    }

    const apiKey = data.apiKey || "";
    if (!apiKey) {
      return { error: "apiKey field is empty", db_path: dbPath };
    }

    return { api_key: apiKey, db_path: dbPath };
  } catch (e) {
    return { error: `Extraction failed: ${e.message}`, db_path: dbPath };
  } finally {
    db.close();
  }
}

/**
 * Whether a key read from local storage can be used for YCE search auto-discovery.
 * YCE-compatible backends may store legacy `sk-ws-...` keys or newer `devin-session-token$...` session tokens.
 * @param {string} apiKey
 * @returns {boolean}
 */
export function isUsableDiscoveredApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return false;
  if (key.startsWith("sk-")) return true;
  if (key.startsWith("devin-session-token")) return true;
  return key.length >= 32;
}
