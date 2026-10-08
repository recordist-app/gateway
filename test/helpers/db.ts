/**
 * Builds a temporary recordist.db with the same tables as the app's schema and a
 * small, deterministic fixture set.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meetings (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT 'Untitled meeting',
  source_app    TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  duration_ms   INTEGER,
  status        TEXT NOT NULL DEFAULT 'recording',
  language      TEXT,
  audio_mic     TEXT,
  audio_sys     TEXT,
  template_id   TEXT,
  calendar_ref  TEXT,
  attendees     TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  starred       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,
  speaker       TEXT,
  speaker_key   TEXT,
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  text          TEXT NOT NULL,
  confidence    REAL,
  words         TEXT
);
CREATE INDEX IF NOT EXISTS idx_segments_meeting ON segments(meeting_id, start_ms);

CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  template_id   TEXT,
  provider      TEXT,
  model         TEXT,
  content_md    TEXT NOT NULL,
  content_json  TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_meeting ON notes(meeting_id, kind);

CREATE TABLE IF NOT EXISTS action_items (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  owner         TEXT,
  due           TEXT,
  done          INTEGER NOT NULL DEFAULT 0,
  source_ms     INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS markers (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  at_ms         INTEGER NOT NULL,
  label         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  prompt_md     TEXT NOT NULL,
  sections      TEXT NOT NULL,
  builtin       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS speakers (
  key           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  embedding     BLOB,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  text, content='segments', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

const DAY = 24 * 60 * 60 * 1000;
export const NOW = Date.now();

/** Valid Crockford-base32 ULIDs (no I, L, O, U). */
export const IDS = {
  weekly: "01J8AAAAWEEKSYNC0000000001",
  design: "01J8AAAADESGNREV0000000002",
  live: "01J8AAAAREC000000000000003",
} as const;

export interface FixtureDb {
  dir: string;
  dbPath: string;
  cleanup(): void;
}

export function createFixtureDb(opts: { fts?: boolean } = {}): FixtureDb {
  const dir = mkdtempSync(path.join(tmpdir(), "recordist-gw-"));
  const dbPath = path.join(dir, "recordist.db");
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  if (opts.fts !== false) db.exec(FTS_SQL);

  const insMeeting = db.prepare(
    `INSERT INTO meetings (id,title,source_app,started_at,ended_at,duration_ms,status,language,attendees,tags,starred,created_at,updated_at)
     VALUES (@id,@title,@source_app,@started_at,@ended_at,@duration_ms,@status,@language,@attendees,@tags,@starred,@created_at,@updated_at)`,
  );
  const weeklyStart = NOW - 2 * DAY;
  insMeeting.run({
    id: IDS.weekly, title: "Weekly sync", source_app: "meet",
    started_at: weeklyStart, ended_at: weeklyStart + 3_600_000, duration_ms: 3_600_000,
    status: "ready", language: "en",
    attendees: JSON.stringify([{ name: "Ana" }, { name: "Ben", email: "ben@example.com" }]),
    tags: JSON.stringify(["sales"]), starred: 1, created_at: weeklyStart, updated_at: weeklyStart,
  });
  const designStart = NOW - 10 * DAY;
  insMeeting.run({
    id: IDS.design, title: "Design review", source_app: "zoom",
    started_at: designStart, ended_at: designStart + 1_500_000, duration_ms: 1_500_000,
    status: "ready", language: "en", attendees: JSON.stringify([{ name: "Cleo" }]),
    tags: "[]", starred: 0, created_at: designStart, updated_at: designStart,
  });
  const liveStart = NOW - 5 * 60_000;
  insMeeting.run({
    id: IDS.live, title: "Untitled meeting", source_app: "manual",
    started_at: liveStart, ended_at: null, duration_ms: null,
    status: "recording", language: null, attendees: null,
    tags: "[]", starred: 0, created_at: liveStart, updated_at: liveStart,
  });

  const insSeg = db.prepare(
    `INSERT INTO segments (meeting_id,channel,speaker,speaker_key,start_ms,end_ms,text,confidence)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  insSeg.run(IDS.weekly, "mic", "You", "mic:0", 0, 2100, "Hi all, let's start with pricing.", 0.95);
  insSeg.run(IDS.weekly, "sys", "Ana", "sys:0", 2200, 6500, "Sure. The pricing deck needs a refresh before Friday.", 0.9);
  insSeg.run(IDS.weekly, "sys", null, "sys:1", 6600, 9000, "I can send the deck tonight.", 0.8);
  insSeg.run(IDS.weekly, "mic", "You", "mic:0", 3_601_000, 3_605_000, "Great, thanks everyone.", 0.97);
  insSeg.run(IDS.design, "mic", "You", "mic:0", 0, 3000, "Today we review the Q4 roadmap and the budget.", 0.92);
  insSeg.run(IDS.design, "sys", "Cleo", "sys:0", 3100, 8000, "The budget approval is still pending with finance.", 0.9);

  const insNote = db.prepare(
    `INSERT INTO notes (id,meeting_id,kind,provider,model,content_md,content_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  insNote.run("n1", IDS.weekly, "summary", "ollama", "qwen2.5:3b",
    "Discussed the pricing deck refresh; Ana will send the updated deck.", JSON.stringify({ bullets: 1 }), weeklyStart + 3_700_000);
  insNote.run("n2", IDS.weekly, "decisions", "heuristic", null, "- Refresh pricing deck before Friday", null, weeklyStart + 3_700_001);
  insNote.run("n3", IDS.design, "summary", "anthropic", "claude", "Roadmap reviewed. Budget approval pending with finance.", null, designStart + 2_000_000);

  const insAi = db.prepare(
    `INSERT INTO action_items (id,meeting_id,text,owner,due,done,source_ms,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  insAi.run("a1", IDS.weekly, "Send pricing deck", "Ana", "2025-09-05", 0, 6600, weeklyStart + 1);
  insAi.run("a2", IDS.weekly, "Book follow-up", "You", null, 1, null, weeklyStart + 2);
  insAi.run("a3", IDS.design, "Chase finance for budget approval", "Cleo", null, 0, 3100, designStart + 1);

  db.prepare(`INSERT INTO markers (id,meeting_id,at_ms,label,created_at) VALUES (?,?,?,?,?)`).run(
    "m1", IDS.weekly, 2200, "pricing", weeklyStart + 2200,
  );
  db.prepare(`INSERT INTO kv (key,value) VALUES ('schema_version','1')`).run();
  db.close();

  return {
    dir,
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
