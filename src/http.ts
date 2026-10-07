/**
 * Streamable HTTP transport for the MCP server on 127.0.0.1:47322/mcp.
 * One McpServer + transport per session; sessions are tracked by the
 * `mcp-session-id` header the SDK issues on initialize. Every request must
 * carry `Authorization: Bearer <api_token>`.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { bearerAuth, sendUnauthorised } from "./auth.js";
import { DEFAULT_MCP_HTTP_PORT } from "./config.js";

export interface McpHttpOptions {
  createServer: () => McpServer;
  /** Bearer token every request must present (the app's api_token). */
  token: string;
  port?: number;
  host?: string;
  path?: string;
  log?: (msg: string) => void;
}

export async function readJsonBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return undefined;
  return JSON.parse(text);
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createMcpHttpServer(opts: McpHttpOptions): http.Server {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? DEFAULT_MCP_HTTP_PORT;
  const mcpPath = opts.path ?? "/mcp";
  const log = opts.log ?? (() => undefined);
  const authorised = bearerAuth(opts.token);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  /** Hosts accepted by the DNS-rebinding check, using the port actually bound (matters when port 0 is used). */
  const allowedHosts = (): string[] => {
    const addr = server.address();
    const bound = typeof addr === "object" && addr ? addr.port : port;
    return [host, "localhost", `${host}:${bound}`, `localhost:${bound}`];
  };

  const server: http.Server = http.createServer(async (req, res) => {
    if (!authorised(req)) {
      sendUnauthorised(res);
      return;
    }
    // Outside the try below: an unparsable target (`GET http://[`) would otherwise be an unhandled rejection that ends the process.
    let url: URL;
    try { url = new URL(req.url ?? "/", `http://${host}:${port}`); } catch { sendJson(res, 400, { error: { code: "bad_request", message: "Unparsable request path" } }); return; }
    if (url.pathname !== mcpPath) {
      if (url.pathname === "/" || url.pathname === "/health") {
        sendJson(res, 200, { ok: true, name: "recordist-gateway", mcp: mcpPath, sessions: sessions.size });
        return;
      }
      sendJson(res, 404, { error: { code: "not_found", message: `Use ${mcpPath}` } });
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"];
      const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (sid && sessions.has(sid)) {
          await sessions.get(sid)!.transport.handleRequest(req, res, body);
          return;
        }
        if (!sid && isInitializeRequest(body)) {
          const mcp = opts.createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: allowedHosts(),
            onsessioninitialized: (id) => {
              sessions.set(id, { transport, server: mcp });
              log(`session ${id} opened (${sessions.size} active)`);
            },
            onsessionclosed: (id) => {
              sessions.delete(id);
              log(`session ${id} closed (${sessions.size} active)`);
            },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id && sessions.has(id)) {
              sessions.delete(id);
              log(`session ${id} closed (${sessions.size} active)`);
            }
            void mcp.close().catch(() => undefined);
          };
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: sid ? "Unknown session id" : "Missing session id; send an initialize request first" },
          id: null,
        });
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (sid && sessions.has(sid)) {
          await sessions.get(sid)!.transport.handleRequest(req, res);
          return;
        }
        sendJson(res, sid ? 404 : 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: sid ? "Unknown session id" : "Missing mcp-session-id header" },
          id: null,
        });
        return;
      }

      res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
    } catch (err) {
      log(`request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      } else {
        res.end();
      }
    }
  });

  server.on("close", () => {
    for (const { transport } of sessions.values()) void transport.close().catch(() => undefined);
    sessions.clear();
  });

  return server;
}

export function listen(server: http.Server, port: number, host = "127.0.0.1"): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ port: actualPort, host });
    });
  });
}
