import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SqliteReader } from "../src/data/sqlite.js";
import { createMcpHttpServer, listen } from "../src/http.js";
import { createMcpServer } from "../src/mcp.js";
import { createFixtureDb, IDS, type FixtureDb } from "./helpers/db.js";

describe("MCP Streamable HTTP transport", () => {
  let fx: FixtureDb;
  let reader: SqliteReader;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    fx = createFixtureDb();
    reader = new SqliteReader({ dbPath: fx.dbPath });
    server = createMcpHttpServer({ createServer: () => createMcpServer(reader, { version: "t" }), port: 0 });
    ({ port } = await listen(server, 0));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    reader.close();
    fx.cleanup();
  });

  it("serves a session-based MCP endpoint at /mcp", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
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
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
    const other = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(other.status).toBe(404);
    const health = await fetch(`http://127.0.0.1:${port}/`);
    expect(((await health.json()) as any).ok).toBe(true);
  });
});
