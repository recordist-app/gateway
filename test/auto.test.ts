import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/data/api.js";
import { AutoData, createRecordistData } from "../src/data/auto.js";
import { AppNotRunningError, NoDataSourceError } from "../src/data/errors.js";
import { SqliteReader } from "../src/data/sqlite.js";
import { createFixtureDb, IDS, type FixtureDb } from "./helpers/db.js";

function apiWith(reachable: boolean, calls: string[] = []): ApiClient {
  const fetchImpl = vi.fn(async (input: URL | string | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname);
    if (!reachable) throw new Error("ECONNREFUSED");
    if (url.pathname === "/v1/health") return Response.json({ ok: true, version: "9", recording: { active: false } });
    if (url.pathname === "/v1/meetings") return Response.json({ meetings: [{ id: "api-1", title: "From API", started_at: 1 }] });
    if (url.pathname === "/v1/recording/marker") return Response.json({ marker: { id: "k", at_ms: 1, label: "x" } });
    return Response.json({ error: { code: "not_found", message: "?" } }, { status: 404 });
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "http://127.0.0.1:47321", token: "t", fetch: fetchImpl, healthTimeoutMs: 100 });
}

describe("AutoData", () => {
  let fx: FixtureDb;
  beforeAll(() => { fx = createFixtureDb(); });
  afterAll(() => fx.cleanup());

  it("falls back to SQLite for reads and errors on actions when the app is down", async () => {
    const d = new AutoData({ api: apiWith(false), openSqlite: () => new SqliteReader({ dbPath: fx.dbPath }) });
    expect(await d.probe()).toBe(false);
    expect(d.mode).toBe("sqlite");
    const list = await d.listMeetings({ limit: 1 });
    expect(list[0]!.id).toBe(IDS.live);
    await expect(d.addMarker("x")).rejects.toBeInstanceOf(AppNotRunningError);
    await expect(d.startRecording()).rejects.toThrow("Recordist app is not running");
    d.close();
  });

  it("uses the API when reachable", async () => {
    const calls: string[] = [];
    const d = new AutoData({ api: apiWith(true, calls), openSqlite: () => { throw new Error("should not open db"); } });
    expect(await d.probe()).toBe(true);
    expect(d.mode).toBe("api");
    expect((await d.listMeetings())[0]!.title).toBe("From API");
    expect((await d.addMarker("x")).ok).toBe(true);
    expect(calls.filter((p) => p === "/v1/health")).toHaveLength(1); // probe cached
    d.close();
  });

  it("re-probes after the TTL", async () => {
    let now = 0;
    const calls: string[] = [];
    const d = new AutoData({ api: apiWith(true, calls), openSqlite: () => null, probeTtlMs: 1000, now: () => now });
    await d.listMeetings();
    await d.listMeetings();
    expect(calls.filter((p) => p === "/v1/health")).toHaveLength(1);
    now = 5000;
    await d.listMeetings();
    expect(calls.filter((p) => p === "/v1/health")).toHaveLength(2);
  });

  it("throws NoDataSourceError when nothing is available", async () => {
    const d = new AutoData({ api: apiWith(false), openSqlite: () => null });
    await expect(d.listMeetings()).rejects.toBeInstanceOf(NoDataSourceError);
  });

  it("createRecordistData wires config", async () => {
    const d = createRecordistData({
      dataDir: fx.dir,
      dbPath: fx.dbPath,
      tokenPath: `${fx.dir}/api_token`,
      apiUrl: "http://127.0.0.1:1",
      apiToken: null,
    });
    expect((await d.getMeeting(IDS.weekly))!.title).toBe("Weekly sync");
    expect(d.mode).toBe("sqlite");
    d.close();
  });
});
