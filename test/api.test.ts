import { describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/data/api.js";
import { ApiError } from "../src/data/errors.js";

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (url: URL, init: RequestInit) => { status?: number; body?: unknown; text?: string } | Promise<never>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init: init ?? {} });
    const r = await handler(url, init ?? {});
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("ApiClient", () => {
  it("sends bearer token and query params", async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.pathname === "/v1/meetings") return { body: { meetings: [{ id: "x", title: "T", started_at: 1, tags: ["a"], starred: 1 }] } };
      return { status: 404, body: { error: { code: "not_found", message: "nope" } } };
    });
    const c = new ApiClient({ baseUrl: "http://127.0.0.1:47321/", token: "tok", fetch: fetchImpl });
    const list = await c.listMeetings({ q: "pricing", limit: 5, from: 123 });
    expect(list).toEqual([
      expect.objectContaining({ id: "x", title: "T", tags: ["a"], starred: true, attendees: [] }),
    ]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:47321/v1/meetings?q=pricing&limit=5&from=123");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("maps 404 to null and other errors to ApiError", async () => {
    const { fetchImpl } = mockFetch((url) => {
      if (url.pathname.endsWith("/missing")) return { status: 404, body: { error: { code: "not_found", message: "no such meeting" } } };
      return { status: 401, body: { error: { code: "unauthorized", message: "bad token" } } };
    });
    const c = new ApiClient({ baseUrl: "http://127.0.0.1:47321", token: null, fetch: fetchImpl });
    expect(await c.getMeeting("missing")).toBeNull();
    await expect(c.getMeeting("other")).rejects.toMatchObject({ status: 401, code: "unauthorized", message: "bad token" });
    await expect(c.getMeeting("other")).rejects.toBeInstanceOf(ApiError);
  });

  it("normalises meeting + transcript payloads", async () => {
    const { fetchImpl } = mockFetch((url) => {
      if (url.pathname === "/v1/meetings/m1") {
        return {
          body: {
            id: "m1", title: "Weekly", started_at: 1, status: "ready", starred: false,
            notes: [{ id: "n", kind: "summary", content_md: "S" }],
            action_items: [{ id: "a", text: "Do", owner: "You", done: 0 }],
            markers: [{ id: "k", at_ms: 5, label: "l" }],
          },
        };
      }
      if (url.pathname === "/v1/meetings/m1/transcript") {
        expect(url.searchParams.get("format")).toBe("json");
        return { body: { meeting_id: "m1", segments: [{ speaker: "You", channel: "mic", start_ms: 0, end_ms: 1, text: "hi" }] } };
      }
      return { status: 500, text: "boom" };
    });
    const c = new ApiClient({ baseUrl: "http://127.0.0.1:47321", token: "t", fetch: fetchImpl });
    const m = await c.getMeeting("m1");
    expect(m!.action_items[0]).toEqual({ id: "a", text: "Do", owner: "You", done: false, meeting_id: "m1" });
    expect(m!.markers).toHaveLength(1);
    const t = await c.getTranscript("m1");
    expect(t!.segments[0]!.text).toBe("hi");
    const items = await c.getActionItems({ meeting_id: "m1", open_only: true });
    expect(items).toEqual([expect.objectContaining({ id: "a", meeting_title: "Weekly" })]);
  });

  it("posts recording actions", async () => {
    const { fetchImpl, calls } = mockFetch((url, init) => {
      if (url.pathname === "/v1/recording/start") return { body: { meeting_id: "new1" } };
      if (url.pathname === "/v1/recording/stop") return { body: { meeting_id: "new1" } };
      if (url.pathname === "/v1/recording/marker") {
        expect(JSON.parse(String(init.body))).toEqual({ label: "pricing" });
        return { body: { marker: { id: "mk", at_ms: 10, label: "pricing" } } };
      }
      if (url.pathname === "/v1/meetings/m1/notes") return { body: { note: { id: "n2", kind: "summary", content_md: "New" } } };
      return { status: 500 };
    });
    const c = new ApiClient({ baseUrl: "http://127.0.0.1:47321", token: "t", fetch: fetchImpl });
    expect(await c.startRecording({ title: "X" })).toEqual({ ok: true, meeting_id: "new1" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ source_app: "manual", title: "X" });
    expect(await c.stopRecording()).toEqual({ ok: true, meeting_id: "new1" });
    expect((await c.addMarker("pricing")).marker).toMatchObject({ label: "pricing" });
    expect((await c.regenerateNotes({ meeting_id: "m1", kind: "summary" })).note).toMatchObject({ id: "n2" });
  });

  it("health respects the timeout and isReachable never throws", async () => {
    const slow = vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    ) as unknown as typeof fetch;
    const c = new ApiClient({ baseUrl: "http://127.0.0.1:47321", token: null, fetch: slow, healthTimeoutMs: 20 });
    await expect(c.health()).rejects.toThrow();
    expect(await c.isReachable()).toBe(false);

    const { fetchImpl } = mockFetch(() => ({ body: { ok: true, version: "1.2.3", recording: { active: false } } }));
    const ok = new ApiClient({ baseUrl: "http://127.0.0.1:47321", token: null, fetch: fetchImpl });
    expect(await ok.health()).toEqual({ ok: true, version: "1.2.3", recording: { active: false }, authenticated: true });
    expect(await ok.isReachable()).toBe(true);

    // Without an accepted token the app answers only { ok, version }: reachable, but not authenticated.
    const minimal = mockFetch(() => ({ body: { ok: true, version: "1.2.3" } })).fetchImpl;
    const anon = new ApiClient({ baseUrl: "http://127.0.0.1:47321", token: null, fetch: minimal });
    expect(await anon.health()).toEqual({ ok: true, version: "1.2.3", recording: { active: false }, authenticated: false });
  });
});
