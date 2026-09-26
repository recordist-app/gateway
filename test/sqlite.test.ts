import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppNotRunningError } from "../src/data/errors.js";
import { likeSnippet, SqliteReader, toFtsQuery } from "../src/data/sqlite.js";
import { createFixtureDb, IDS, NOW, type FixtureDb } from "./helpers/db.js";

const DAY = 24 * 60 * 60 * 1000;

describe.each([{ fts: true }, { fts: false }])("SqliteReader (fts=$fts)", ({ fts }) => {
  let fx: FixtureDb;
  let r: SqliteReader;
  beforeAll(() => {
    fx = createFixtureDb({ fts });
    r = new SqliteReader({ dbPath: fx.dbPath });
  });
  afterAll(() => {
    r.close();
    fx.cleanup();
  });

  it("detects FTS availability", () => {
    expect(r.ftsAvailable).toBe(fts);
    expect(r.mode).toBe("sqlite");
  });

  it("lists meetings newest first with parsed JSON columns", async () => {
    const all = await r.listMeetings();
    expect(all.map((m) => m.id)).toEqual([IDS.live, IDS.weekly, IDS.design]);
    const weekly = all[1]!;
    expect(weekly.attendees).toEqual([{ name: "Ana" }, { name: "Ben", email: "ben@example.com" }]);
    expect(weekly.tags).toEqual(["sales"]);
    expect(weekly.starred).toBe(true);
    expect(all[0]!.attendees).toEqual([]);
  });

  it("supports limit/offset and date range", async () => {
    expect((await r.listMeetings({ limit: 1 })).map((m) => m.id)).toEqual([IDS.live]);
    expect((await r.listMeetings({ limit: 1, offset: 1 })).map((m) => m.id)).toEqual([IDS.weekly]);
    const lastWeek = await r.listMeetings({ from: NOW - 7 * DAY });
    expect(lastWeek.map((m) => m.id)).toEqual([IDS.live, IDS.weekly]);
    const older = await r.listMeetings({ to: NOW - 7 * DAY });
    expect(older.map((m) => m.id)).toEqual([IDS.design]);
  });

  it("filters with q across title, transcript and notes", async () => {
    expect((await r.listMeetings({ q: "pricing" })).map((m) => m.id)).toEqual([IDS.weekly]);
    expect((await r.listMeetings({ q: "Design" })).map((m) => m.id)).toEqual([IDS.design]);
    expect((await r.listMeetings({ q: "finance" })).map((m) => m.id)).toEqual([IDS.design]);
    expect(await r.listMeetings({ q: "zzzz-nothing" })).toEqual([]);
  });

  it("gets a meeting with notes, action items and markers", async () => {
    const m = await r.getMeeting(IDS.weekly);
    expect(m).not.toBeNull();
    expect(m!.title).toBe("Weekly sync");
    expect(m!.notes.map((n) => n.kind)).toEqual(["summary", "decisions"]);
    expect(m!.notes[0]!.content_json).toEqual({ bullets: 1 });
    expect(m!.action_items.map((a) => [a.text, a.done])).toEqual([
      ["Send pricing deck", false],
      ["Book follow-up", true],
    ]);
    expect(m!.markers).toEqual([{ id: "m1", at_ms: 2200, label: "pricing", created_at: expect.any(Number) }]);
    expect(await r.getMeeting("nope")).toBeNull();
  });

  it("returns transcripts ordered by start_ms", async () => {
    const t = await r.getTranscript(IDS.weekly);
    expect(t!.meeting_id).toBe(IDS.weekly);
    expect(t!.segments.map((s) => s.start_ms)).toEqual([0, 2200, 6600, 3_601_000]);
    expect(t!.segments[1]).toMatchObject({ speaker: "Ana", channel: "sys", text: "Sure. The pricing deck needs a refresh before Friday." });
    expect((await r.getTranscript(IDS.live))!.segments).toEqual([]);
    expect(await r.getTranscript("nope")).toBeNull();
  });

  it("searches segments and notes with snippets", async () => {
    const hits = await r.search("pricing");
    const seg = hits.filter((h) => h.kind === "segment");
    expect(seg.length).toBe(2);
    expect(seg.every((h) => h.meeting_id === IDS.weekly)).toBe(true);
    expect(seg[0]!.snippet).toMatch(/\[pricing\]/i);
    expect(seg[0]!.start_ms).toBeTypeOf("number");
    const note = hits.find((h) => h.kind === "note");
    expect(note).toMatchObject({ meeting_id: IDS.weekly, note_kind: "summary" });
    expect(note!.snippet).toContain("[pricing]");
    expect(await r.search("   ")).toEqual([]);
    expect(await r.search("budget", { limit: 1 })).toHaveLength(1);
  });

  it("search survives FTS syntax characters in the query", async () => {
    await expect(r.search('pricing "deck" AND (x')).resolves.toBeInstanceOf(Array);
  });

  it("filters action items", async () => {
    const all = await r.getActionItems();
    expect(all).toHaveLength(3);
    expect(all[0]!.meeting_title).toBe("Weekly sync");
    const open = await r.getActionItems({ open_only: true });
    expect(open.map((a) => a.id)).toEqual(["a1", "a3"]);
    const one = await r.getActionItems({ meeting_id: IDS.design, open_only: true });
    expect(one.map((a) => a.id)).toEqual(["a3"]);
  });

  it("reports recording state in health", async () => {
    const h = await r.health();
    expect(h.ok).toBe(true);
    expect(h.recording).toEqual({ active: true, meeting_id: IDS.live });
  });

  it("rejects actions with a clear error", async () => {
    await expect(r.startRecording()).rejects.toBeInstanceOf(AppNotRunningError);
    await expect(r.stopRecording()).rejects.toThrow(/Recordist app is not running/);
    await expect(r.addMarker("x")).rejects.toThrow(/not running/);
    await expect(r.regenerateNotes()).rejects.toThrow(/not running/);
  });
});

describe("SqliteReader constructor", () => {
  it("requires the file to exist", () => {
    expect(() => new SqliteReader({ dbPath: "/nonexistent/recordist.db" })).toThrow();
  });
});

describe("helpers", () => {
  it("toFtsQuery quotes terms and keeps prefix stars", () => {
    expect(toFtsQuery("pricing deck")).toBe('"pricing" "deck"');
    expect(toFtsQuery('say "hi"')).toBe('"say" """hi"""');
    expect(toFtsQuery("pric*")).toBe('"pric"*');
    expect(toFtsQuery("  ")).toBe('""');
  });
  it("likeSnippet brackets the match", () => {
    expect(likeSnippet("the pricing deck", "PRICING", 4)).toBe("the [pricing] dec…");
    expect(likeSnippet("well the pricing deck", "pricing", 4)).toBe("…the [pricing] dec…");
    expect(likeSnippet("no match here", "zzz", 3)).toBe("no mat");
  });
});
