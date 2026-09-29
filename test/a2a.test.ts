import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createA2AServer } from "../src/a2a.js";
import { SqliteReader } from "../src/data/sqlite.js";
import { listen } from "../src/http.js";
import { TOOL_NAMES } from "../src/tools.js";
import { createFixtureDb, IDS, type FixtureDb } from "./helpers/db.js";

describe("A2A server", () => {
  let fx: FixtureDb;
  let reader: SqliteReader;
  let server: http.Server;
  let base: string;

  const rpc = async (method: string, params: unknown, id: number | string = 1) => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return { status: res.status, body: (await res.json()) as { result?: any; error?: { code: number; message: string } } };
  };

  beforeAll(async () => {
    fx = createFixtureDb();
    reader = new SqliteReader({ dbPath: fx.dbPath });
    server = createA2AServer({ data: reader, version: "1.2.3", port: 0 });
    const { port } = await listen(server, 0);
    base = `http://127.0.0.1:${port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    reader.close();
    fx.cleanup();
  });

  it("serves the agent card", async () => {
    const res = await fetch(`${base}.well-known/agent.json`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as any;
    expect(card.name).toBe("Recordist");
    expect(card.version).toBe("1.2.3");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(card.skills.map((s: any) => s.id).sort()).toEqual([...TOOL_NAMES].sort());
    for (const s of card.skills) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.examples.length).toBeGreaterThan(0);
    }
  });

  it("tasks/send routes natural language and returns text + data parts", async () => {
    const { status, body } = await rpc("tasks/send", {
      id: "t1",
      message: { role: "user", parts: [{ type: "text", text: "What are my open action items?" }] },
    });
    expect(status).toBe(200);
    const task = body.result;
    expect(task.id).toBe("t1");
    expect(task.status.state).toBe("completed");
    const parts = task.artifacts[0].parts;
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("Send pricing deck");
    expect(parts[1].type).toBe("data");
    expect(parts[1].data.skill).toBe("get_action_items");
    expect(parts[1].data.args).toEqual({ open_only: true });
    expect(parts[1].data.action_items.map((a: any) => a.id)).toEqual(["a1", "a3"]);
    expect(task.status.message.role).toBe("agent");
    expect(task.history).toHaveLength(2);
  });

  it("tasks/send honours an explicit data part", async () => {
    const { body } = await rpc("tasks/send", {
      message: {
        role: "user",
        parts: [{ type: "data", data: { skill: "get_transcript", args: { meeting_id: IDS.weekly, format: "srt" } } }],
      },
    });
    expect(body.result.status.state).toBe("completed");
    expect(body.result.artifacts[0].parts[0].text).toContain("-->");
    expect(body.result.artifacts[0].parts[1].data.format).toBe("srt");
  });

  it("tasks/get and tasks/cancel", async () => {
    const got = await rpc("tasks/get", { id: "t1" });
    expect(got.body.result.id).toBe("t1");
    expect(got.body.result.status.state).toBe("completed");

    const missing = await rpc("tasks/get", { id: "nope" });
    expect(missing.body.error?.code).toBe(-32001);

    const cancel = await rpc("tasks/cancel", { id: "t1" });
    expect(cancel.body.error?.code).toBe(-32002);
  });

  it("marks failed tasks when the action needs the app", async () => {
    const { body } = await rpc("tasks/send", {
      id: "t2",
      message: { role: "user", parts: [{ type: "text", text: "start recording" }] },
    });
    expect(body.result.status.state).toBe("failed");
    expect(body.result.status.message.parts[0].text).toContain("Recordist app is not running");
  });

  it("tasks/sendSubscribe streams SSE status + artifact events", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "tasks/sendSubscribe",
        params: { id: "t3", message: { role: "user", parts: [{ type: "text", text: `transcript of ${IDS.weekly} as txt` }] } },
      }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const raw = await res.text();
    const events = raw.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
    expect(events.every((e) => e.id === 7 && e.jsonrpc === "2.0")).toBe(true);
    expect(events[0].result.status.state).toBe("working");
    expect(events[0].result.final).toBe(false);
    expect(events[1].result.artifact.parts[0].text).toContain("[00:00:00] You: Hi all");
    expect(events[2].result.status.state).toBe("completed");
    expect(events[2].result.final).toBe(true);
  });

  it("rejects bad requests with JSON-RPC errors", async () => {
    const nf = await rpc("tasks/nope", {});
    expect(nf.body.error?.code).toBe(-32601);
    const bad = await rpc("tasks/send", { message: { role: "user" } });
    expect(bad.body.error?.code).toBe(-32602);
    const notJson = await fetch(base, { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as any).error.code).toBe(-32700);
    const notRpc = await fetch(base, { method: "POST", body: JSON.stringify({ hello: 1 }), headers: { "content-type": "application/json" } });
    expect(((await notRpc.json()) as any).error.code).toBe(-32600);
    const wrongPath = await fetch(`${base}whatever`);
    expect(wrongPath.status).toBe(404);
  });
  it("rejects a foreign Host, an unlisted Origin, and a non-JSON POST", async () => {
    const port = Number(new URL(base).port);
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "nope" } });
    const raw = (headers: Record<string, string>, body?: string, path = "/"): Promise<number> => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject); if (body !== undefined) req.write(body); req.end();
    });
    expect(await raw({ host: "evil.example", "content-type": "application/json" }, rpc)).toBe(403);
    expect(await raw({ host: `127.0.0.1:${port}`, origin: "https://evil.example", "content-type": "application/json" }, rpc)).toBe(403);
    expect(await raw({ host: `127.0.0.1:${port}`, "content-type": "text/plain" }, rpc)).toBe(415);
    expect(await raw({ host: "evil.example" }, undefined, "/.well-known/agent.json")).toBe(403);
    expect(await raw({ host: `localhost:${port}`, "content-type": "application/json" }, rpc)).toBe(200);
  });

});
