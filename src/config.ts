/**
 * Resolves where Recordist keeps its data and how to reach the local API.
 *
 * Per CONTRACTS.md §1:
 *   macOS   ~/Library/Application Support/app.recordist.desktop/
 *   Windows %APPDATA%\app.recordist.desktop\
 *   Linux   ~/.local/share/app.recordist.desktop/
 *
 * Overrides (env): RECORDIST_DATA_DIR, RECORDIST_API_URL, RECORDIST_API_TOKEN.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const BUNDLE_ID = "app.recordist.desktop";
export const DEFAULT_API_URL = "http://127.0.0.1:47321";
export const DEFAULT_MCP_HTTP_PORT = 47322;
export const DEFAULT_A2A_PORT = 47323;
export const API_HEALTH_TIMEOUT_MS = 800;

export interface GatewayConfig {
  dataDir: string;
  dbPath: string;
  tokenPath: string;
  apiUrl: string;
  /** Token from env or disk; null when neither is available. */
  apiToken: string | null;
}

export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME && platform !== "win32" ? env.HOME : homedir();
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", BUNDLE_ID);
    case "win32": {
      const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
      return path.join(appData, BUNDLE_ID);
    }
    default: {
      const xdg = env.XDG_DATA_HOME;
      const base = xdg && xdg.length > 0 ? xdg : path.join(home, ".local", "share");
      return path.join(base, BUNDLE_ID);
    }
  }
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RECORDIST_DATA_DIR;
  if (override && override.trim().length > 0) return path.resolve(override);
  return defaultDataDir(process.platform, env);
}

export function readTokenFile(tokenPath: string): string | null {
  try {
    if (!existsSync(tokenPath)) return null;
    const raw = readFileSync(tokenPath, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const dataDir = resolveDataDir(env);
  const tokenPath = path.join(dataDir, "api_token");
  const envToken = env.RECORDIST_API_TOKEN?.trim();
  const apiToken = envToken && envToken.length > 0 ? envToken : readTokenFile(tokenPath);
  const apiUrlRaw = env.RECORDIST_API_URL?.trim();
  const apiUrl = (apiUrlRaw && apiUrlRaw.length > 0 ? apiUrlRaw : DEFAULT_API_URL).replace(
    /\/+$/,
    "",
  );
  return {
    dataDir,
    dbPath: path.join(dataDir, "recordist.db"),
    tokenPath,
    apiUrl,
    apiToken,
  };
}
