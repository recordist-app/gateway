import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SqliteReader } from "../src/data/sqlite.js";
import { createMcpServer, meetingUri, transcriptUri } from "../src/mcp.js";
import { TOOL_NAMES } from "../src/tools.js";
import { createFixtureDb, IDS, type FixtureDb } from "./helpers/db.js";

describe("MCP server (in-memory transport, SQLite backend)", () => {
  let fx: FixtureDb;
  let reader: SqliteReader;
  let client: Client;

  beforeAll(async () => {
    fx = createFixtureDb();
    reader = new SqliteReader({ dbPath: fx.dbPath });
    const server = createMcpServer(reader, { version: "test" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientT);
  });
  afterAll(async () => {
    await client.close();
    reader.close();
    fx.cleanup();
  });

  it("exposes exactly the contract tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_marker", "get_action_items", "get_meeting", "get_transcript", "list_meetings",
      "regenerate_notes", "search_meetings", "start_recording", "stop_recording",
    ]);
    const getT = tools.find((t) => t.name === "get_transcript")!;
    expect(getT.annotations?.readOnlyHint).toBe(true);
    expect((getT.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("format");
    expect(tools.find((t) => t.name === "start_recording")!.annotations?.readOnlyHint).toBe(false);
  });

  it("list_meetings returns text + structuredContent", async () => {
    const res = await client.callTool({ name: "list_meetings", arguments: { limit: 2 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { meetings: Array<{ id: string }>; count: number };
    expect(sc.count).toBe(2);
    expect(sc.meetings[1]!.id).toBe(IDS.weekly);
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Weekly sync");
  });

  it("list_meetings accepts ISO dates", async () => {
    const res = await client.callTool({ name: "list_meetings", arguments: { from: "2000-01-01", to: new Date().toISOString() } });
    expect((res.structuredContent as { count: number }).count).toBe(3);
  });

  it("get_meeting renders notes and action items", async () => {
    const res = await client.callTool({ name: "get_meeting", arguments: { meeting_id: IDS.weekly } });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("# Weekly sync");
    expect(text).toContain("## summary");
    expect(text).toContain("- [ ] Send pricing deck");
    expect(text).toContain("- [x] Book follow-up");
    expect(text).toContain("[00:00:02] pricing");
  });

  it("get_transcript supports every format", async () => {
    for (const format of ["json", "md", "srt", "vtt", "txt"] as const) {
      const res = await client.callTool({ name: "get_transcript", arguments: { meeting_id: IDS.weekly, format } });
      expect(res.isError).toBeFalsy();
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      const sc = res.structuredContent as { format: string; segment_count: number; segments?: unknown[]; content?: string };
      expect(sc.format).toBe(format);
      expect(sc.segment_count).toBe(4);
      if (format === "json") expect(sc.segments).toHaveLength(4);
      if (format === "srt") expect(text).toContain("00:00:02,200 --> 00:00:06,500\nAna: Sure.");
      if (format === "vtt") expect(text.startsWith("WEBVTT")).toBe(true);
      if (format === "md") expect(text).toContain("# Weekly sync");
      if (format === "txt") expect(text).toContain("[00:00:00] You: Hi all");
    }
  });

  it("search_meetings and get_action_items", async () => {
    const s = await client.callTool({ name: "search_meetings", arguments: { query: "budget" } });
    const hits = (s.structuredContent as { hits: Array<{ meeting_id: string }> }).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.meeting_id).toBe(IDS.design);

    const a = await client.callTool({ name: "get_action_items", arguments: { open_only: true } });
    const items = (a.structuredContent as { action_items: Array<{ id: string }> }).action_items;
    expect(items.map((i) => i.id)).toEqual(["a1", "a3"]);
  });

  it("returns isError for missing meetings and for actions without the app", async () => {
    const missing = await client.callTool({ name: "get_meeting", arguments: { meeting_id: "nope" } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0]!.text).toMatch(/not found/);

    for (const name of ["start_recording", "stop_recording", "add_marker"]) {
      const res = await client.callTool({ name, arguments: {} });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0]!.text).toContain("Recordist app is not running");
    }
    const regen = await client.callTool({ name: "regenerate_notes", arguments: { meeting_id: IDS.weekly } });
    expect(regen.isError).toBe(true);
  });

  it("rejects invalid arguments", async () => {
    const res = await client.callTool({ name: "get_transcript", arguments: { meeting_id: IDS.weekly, format: "pdf" } });
    expect(res.isError).toBe(true);
  });

  it("lists recent meetings as resources and reads both templates", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "recordist://meeting/{id}",
      "recordist://meeting/{id}/transcript",
    ]);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([meetingUri(IDS.live), meetingUri(IDS.weekly), meetingUri(IDS.design)]);
    expect(resources[1]!.name).toBe("Weekly sync");

    const m = await client.readResource({ uri: meetingUri(IDS.weekly) });
    const json = JSON.parse((m.contents[0] as { text: string }).text) as { title: string; notes: unknown[] };
    expect(json.title).toBe("Weekly sync");
    expect(json.notes).toHaveLength(2);

    const t = await client.readResource({ uri: transcriptUri(IDS.weekly) });
    expect(t.contents[0]!.mimeType).toBe("text/markdown");
    expect((t.contents[0] as { text: string }).text).toContain("**[00:00:02] Ana:**");

    await expect(client.readResource({ uri: "recordist://meeting/nope" })).rejects.toThrow(/not found/);
  });

  it("provides the three prompts with embedded context", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["draft_followup_email", "summarize_meeting", "weekly_review"]);

    const sum = await client.getPrompt({ name: "summarize_meeting", arguments: { meeting_id: IDS.weekly } });
    const sumText = (sum.messages[0]!.content as { text: string }).text;
    expect(sumText).toContain("# Weekly sync");
    expect(sumText).toContain("[00:00:02] Ana: Sure.");

    const mail = await client.getPrompt({ name: "draft_followup_email", arguments: { meeting_id: IDS.weekly, tone: "formal" } });
    const mailText = (mail.messages[0]!.content as { text: string }).text;
    expect(mailText).toContain("formal follow-up email to Ana, Ben");

    const week = await client.getPrompt({ name: "weekly_review", arguments: {} });
    const weekText = (week.messages[0]!.content as { text: string }).text;
    expect(weekText).toContain("### Weekly sync");
    expect(weekText).not.toContain("### Design review"); // 10 days old
    expect(weekText).toContain("- [ ] Send pricing deck");
  });
});
