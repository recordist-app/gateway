import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SqliteReader } from "../src/data/sqlite.js";
import { createMcpHttpServer, listen } from "../src/http.js";
import { createMcpServer } from "../src/mcp.js";
import { createFixtureDb, IDS, type FixtureDb } from "./helpers/db.js";

const TOKEN = "a".repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe("MCP Streamable HTTP transport", () => {
  let fx: FixtureDb;
  let reader: SqliteReader;
  let server: http.Server;
  let port: number;

  const initialize = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auth-test", version: "0" } },
      }),
    });

  beforeAll(async () => {
    fx = createFixtureDb();
    reader = new SqliteReader({ dbPath: fx.dbPath });
    server = createMcpHttpServer({ createServer: () => createMcpServer(reader, { version: "t" }), token: TOKEN, port: 0 });
    ({ port } = await listen(server, 0));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    reader.close();
    fx.cleanup();
  });

  it("serves a session-based MCP endpoint at /mcp with the right token", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: AUTH },
    });
    const client = new Client({ name: "http-test", version: "0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_meetings");
    const res = await client.callTool({ name: "get_meeting", arguments: { meeting_id: IDS.design } });
    expect((res.structuredContent as any).meeting.title).toBe("Design review");
    await client.close();
  });

  it("rejects non-initialize requests without a session", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...AUTH },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
    const other = await fetch(`http://127.0.0.1:${port}/nope`, { headers: AUTH });
    expect(other.status).toBe(404);
    const health = await fetch(`http://127.0.0.1:${port}/`, { headers: AUTH });
    expect(((await health.json()) as any).ok).toBe(true);
  });

  it("answers 401 with WWW-Authenticate and no detail when the token is missing", async () => {
    const res = await initialize({});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: "unauthorised" });
    for (const path of ["/", "/health", "/nope"]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorised" });
    }
  });

  it("answers 401 to a wrong token", async () => {
    for (const authorization of [`Bearer ${"b".repeat(64)}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, "Bearer ", `Basic ${TOKEN}`, TOKEN]) {
      const res = await initialize({ authorization });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual({ error: "unauthorised" });
    }
  });

  it("does not let a session id stand in for the token", async () => {
    const ok = await initialize(AUTH);
    expect(ok.status).toBe(200);
    const sid = ok.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    await ok.body?.cancel();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    // The SSE stream and session teardown take the same check; the unauthorised DELETE must leave the session open.
    const stream = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { accept: "text/event-stream", "mcp-session-id": sid! } });
    expect(stream.status).toBe(401);
    expect(await stream.json()).toEqual({ error: "unauthorised" });
    const drop = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid! } });
    expect(drop.status).toBe(401);
    await drop.body?.cancel();
    const close = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid!, ...AUTH } });
    expect(close.status).toBe(200);
  });

  it("answers 400 to an unparsable request path and keeps serving", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "http://[", method: "GET", headers: AUTH }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.setTimeout(2000, () => req.destroy(new Error("no response")));
      req.on("error", reject); req.end();
    });
    expect(status).toBe(400);
    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: AUTH });
    expect(health.status).toBe(200);
  });

  it("keeps the Host check behind the token", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auth-test", version: "0" } },
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port, path: "/mcp", method: "POST",
        headers: { ...AUTH, host: "evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject); req.write(body); req.end();
    });
    expect(status).toBe(403);
  });

  it("will not start without a token", () => {
    expect(() => createMcpHttpServer({ createServer: () => createMcpServer(reader, { version: "t" }), token: "" })).toThrow(/token/);
    expect(() => createMcpHttpServer({ createServer: () => createMcpServer(reader, { version: "t" }), token: "  " })).toThrow(/token/);
  });
});
