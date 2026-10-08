#!/usr/bin/env node
/**
 * recordist-gateway CLI.
 *
 *   recordist-gateway            MCP over stdio (Claude Desktop / Claude Code / Cursor)
 *   recordist-gateway --http     MCP over Streamable HTTP on 127.0.0.1:47322/mcp
 *   recordist-gateway --a2a      A2A agent on 127.0.0.1:47323
 *   recordist-gateway --all      stdio + HTTP + A2A
 *   recordist-gateway --doctor   diagnose data dir / DB / token / app reachability
 *   recordist-gateway --version
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createA2AServer } from "./a2a.js";
import { DEFAULT_A2A_PORT, DEFAULT_MCP_HTTP_PORT, loadConfig, type GatewayConfig } from "./config.js";
import { ApiClient, createRecordistData, SqliteReader } from "./data/index.js";
import { createMcpHttpServer, listen } from "./http.js";
import { createMcpServer } from "./mcp.js";
import { packageVersion } from "./version.js";

export interface CliOptions {
  stdio: boolean;
  http: boolean;
  a2a: boolean;
  doctor: boolean;
  version: boolean;
  help: boolean;
  httpPort: number;
  a2aPort: number;
  host: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = {
    stdio: false,
    http: false,
    a2a: false,
    doctor: false,
    version: false,
    help: false,
    httpPort: DEFAULT_MCP_HTTP_PORT,
    a2aPort: DEFAULT_A2A_PORT,
    host: "127.0.0.1",
  };
  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.includes("=") ? (a.split("=", 2) as [string, string]) : [a, undefined];
    switch (flag) {
      case "--stdio": o.stdio = true; break;
      case "--http": o.http = true; break;
      case "--a2a": o.a2a = true; break;
      case "--all": o.stdio = o.http = o.a2a = true; break;
      case "--doctor": o.doctor = true; break;
      case "--version": case "-v": o.version = true; break;
      case "--help": case "-h": o.help = true; break;
      case "--http-port": o.httpPort = Number(inline ?? takeValue(i++, flag)); break;
      case "--a2a-port": o.a2aPort = Number(inline ?? takeValue(i++, flag)); break;
      case "--host": o.host = inline ?? takeValue(i++, flag); break;
      default:
        throw new Error(`Unknown option: ${a} (try --help)`);
    }
  }
  if (!o.http && !o.a2a && !o.doctor && !o.version && !o.help) o.stdio = true;
  if (!Number.isInteger(o.httpPort) || !Number.isInteger(o.a2aPort)) throw new Error("Ports must be integers");
  return o;
}

export const HELP = `@recordist/gateway v${packageVersion()}: MCP server + A2A agent for Recordist

Usage:
  npx -y @recordist/gateway                 MCP over stdio (default)
  npx -y @recordist/gateway --http          MCP over Streamable HTTP  http://127.0.0.1:${DEFAULT_MCP_HTTP_PORT}/mcp
  npx -y @recordist/gateway --a2a           A2A agent                 http://127.0.0.1:${DEFAULT_A2A_PORT}/
  npx -y @recordist/gateway --all           stdio + --http + --a2a
  npx -y @recordist/gateway --doctor        Print diagnostics and exit
  npx -y @recordist/gateway --version

With npx, always use the scoped name @recordist/gateway. After
npm i -g @recordist/gateway the same command is recordist-gateway.

Options:
  --http-port <n>   Streamable HTTP port (default ${DEFAULT_MCP_HTTP_PORT})
  --a2a-port <n>    A2A port (default ${DEFAULT_A2A_PORT})
  --host <addr>     Bind address for --http and --a2a (default 127.0.0.1). It exists
                    for containers; do not expose it on a network interface.

--http and --a2a answer only requests that carry "Authorization: Bearer <api_token>"
(the A2A Agent Card excepted); they will not start without a token, and neither
will --all (stdio included). Plain stdio needs no token.

Environment:
  RECORDIST_DATA_DIR    Override the data directory (contains recordist.db and api_token)
  RECORDIST_API_URL     Override the local API base URL (default http://127.0.0.1:47321)
  RECORDIST_API_TOKEN   Override the bearer token (default: read from <data>/api_token)
`;

const log = (msg: string): void => {
  process.stderr.write(`[recordist-gateway] ${msg}\n`);
};

export async function doctor(config: GatewayConfig = loadConfig()): Promise<{ text: string; ok: boolean }> {
  const lines: string[] = [];
  const dbExists = existsSync(config.dbPath);
  const tokenExists = existsSync(config.tokenPath);
  let tokenMode = "";
  if (tokenExists) {
    try {
      const mode = statSync(config.tokenPath).mode & 0o777;
      tokenMode = ` (mode ${mode.toString(8)}${mode & 0o077 ? " — consider chmod 600" : ""})`;
    } catch { /* ignore */ }
  }
  const api = new ApiClient({ baseUrl: config.apiUrl, token: config.apiToken });
  let reachable = false;
  let healthLine = "unreachable (app not running?)";
  try {
    const h = await api.health();
    reachable = h.ok && h.authenticated;
    healthLine = h.authenticated
      ? `ok — app v${h.version}, recording ${h.recording.active ? `active (${h.recording.meeting_id ?? "?"})` : "idle"}`
      : `app v${h.version} answers, but the token was not accepted — ${config.apiToken ? `it changed (Remove everything issues a new one): copy ${config.tokenPath} again or set RECORDIST_API_TOKEN` : `no token: pair from Recordist → Settings → Integrations (8-digit code) or copy ${config.tokenPath}`}`;
  } catch (err) {
    healthLine = `unreachable — ${err instanceof Error ? err.message : String(err)}`;
  }
  let dbLine = dbExists ? "found" : "missing";
  if (dbExists) {
    try {
      const r = new SqliteReader({ dbPath: config.dbPath });
      const n = (await r.listMeetings({ limit: 1 })).length;
      dbLine = `found — readable, FTS5 ${r.ftsAvailable ? "available" : "NOT available (LIKE fallback)"}, ${n ? "has meetings" : "no meetings yet"}`;
      r.close();
    } catch (err) {
      dbLine = `found — but failed to open: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // loadConfig ignores a blank RECORDIST_API_TOKEN and falls back to the file, so trim here as well.
  const tokenFromEnv = Boolean(process.env.RECORDIST_API_TOKEN?.trim());
  const tokenSource = tokenFromEnv ? "RECORDIST_API_TOKEN" : config.tokenPath;

  lines.push(`recordist-gateway v${packageVersion()}  (node ${process.version}, ${process.platform})`);
  lines.push(`data dir:    ${config.dataDir}${process.env.RECORDIST_DATA_DIR ? "  [RECORDIST_DATA_DIR]" : ""}`);
  lines.push(`database:    ${config.dbPath} — ${dbLine}`);
  lines.push(`api token:   ${config.apiToken ? (tokenFromEnv ? "present [RECORDIST_API_TOKEN]" : `present (${config.tokenPath})${tokenMode}`) : `missing (${config.tokenPath})`}`);
  lines.push(`local api:   ${config.apiUrl} — ${healthLine}`);
  lines.push(`mode:        ${reachable ? "api (full read/write)" : dbExists ? "sqlite fallback (read-only; recording controls unavailable)" : "NO DATA SOURCE"}`);
  // --http and --a2a check every caller against this same token and refuse to start without one.
  lines.push(`http / a2a:  ${config.apiToken
    ? `token required — callers must send "Authorization: Bearer <token>" with the token from ${tokenSource} (the A2A Agent Card stays public)`
    : "will not start — they require the api token and there is none; --all exits too, stdio included, so run with no flags for stdio, which needs no token"}`);
  return { text: lines.join("\n"), ok: reachable || dbExists };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) { process.stdout.write(HELP); return; }
  if (opts.version) { process.stdout.write(`${packageVersion()}\n`); return; }
  if (opts.doctor) {
    const d = await doctor();
    process.stdout.write(d.text + "\n");
    process.exitCode = d.ok ? 0 : 1;
    return;
  }

  const config = loadConfig();
  const token = config.apiToken;
  if ((opts.http || opts.a2a) && !token) {
    log(`--http and --a2a need the API token to check every caller, and there is none: ${config.tokenPath} is missing and RECORDIST_API_TOKEN is not set. Open Recordist once, then try again.${opts.stdio ? " Nothing was started, stdio included; run with no flags for stdio alone, which needs no token." : ""}`);
    process.exitCode = 1;
    return;
  }
  const data = createRecordistData(config);
  const version = packageVersion();
  const closers: Array<() => Promise<void> | void> = [() => data.close()];

  const reachable = await data.probe(true);
  log(`data dir ${config.dataDir}; app ${reachable ? "reachable" : "not reachable"} → ${data.mode} mode`);
  if (!reachable && !SqliteReader.exists(config.dbPath)) {
    log(`warning: ${config.dbPath} not found and app not running — reads will fail until either is available`);
  }

  if (opts.http) {
    const server = createMcpHttpServer({
      createServer: () => createMcpServer(data, { version }),
      token: token!,
      port: opts.httpPort,
      host: opts.host,
      log,
    });
    const { port } = await listen(server, opts.httpPort, opts.host);
    log(`MCP Streamable HTTP listening on http://${opts.host}:${port}/mcp (Authorization: Bearer <api_token> required)`);
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
  }

  if (opts.a2a) {
    const server = createA2AServer({ data, version, token: token!, port: opts.a2aPort, host: opts.host, log });
    const { port } = await listen(server, opts.a2aPort, opts.host);
    log(`A2A agent listening on http://${opts.host}:${port}/ (card: /.well-known/agent.json; Authorization: Bearer <api_token> required)`);
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
  }

  let stdioDone: Promise<void> | undefined;
  if (opts.stdio) {
    const server = createMcpServer(data, { version });
    const transport = new StdioServerTransport();
    stdioDone = new Promise<void>((resolve) => {
      transport.onclose = () => resolve();
    });
    await server.connect(transport);
    log("MCP stdio transport ready");
    closers.push(() => server.close());
  }

  const shutdown = async (signal: string) => {
    log(`${signal} received, shutting down`);
    for (const c of closers.reverse()) {
      try { await c(); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (stdioDone) {
    await stdioDone;
    await shutdown("stdin closed");
  }
}

const isDirectRun = (() => {
  try {
    // npm installs the command as a symlink (node_modules/.bin/recordist-gateway → dist/cli.js), so
    // resolve the real path before comparing; the old basename check failed through the shim and
    // the server silently did nothing when launched with `npx -y @recordist/gateway`.
    const entry = process.argv[1];
    if (!entry) return false;
    const self = fileURLToPath(import.meta.url);
    let real = entry;
    try { real = realpathSync(entry); } catch { /* keep as is */ }
    if (real === self) return true;
    return self.endsWith(entry.replace(/\\/g, "/").split("/").pop()!);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
