/**
 * Read-only access to `<data>/recordist.db` using the schema in CONTRACTS.md §2.
 *
 * Uses the FTS5 table `segments_fts` for full-text search and falls back to a
 * `LIKE` scan when the FTS table is not present (e.g. an older DB or a build
 * of SQLite without FTS5).
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";

import type {
  ActionItem,
  ActionItemsOptions,
  Health,
  ListMeetingsOptions,
  Marker,
  Meeting,
  MeetingSummary,
  Note,
  SearchHit,
  Segment,
  Transcript,
} from "../types.js";
import { AppNotRunningError } from "./errors.js";
import type { RecordistData } from "./types.js";

type Row = Record<string, unknown>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (limit == null || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function parseJsonArray<T>(raw: unknown, fallback: T[]): T[] {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : v == null ? null : Number(v);
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression: every term is
 * quoted (so user punctuation cannot break the query) and terms are ANDed.
 * Trailing `*` on a term is preserved as a prefix query.
 */
export function toFtsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '""';
  return terms
    .map((t) => {
      const prefix = t.endsWith("*");
      const bare = (prefix ? t.slice(0, -1) : t).replace(/"/g, '""');
      if (bare.length === 0) return null;
      return `"${bare}"${prefix ? "*" : ""}`;
    })
    .filter((t): t is string => t !== null)
    .join(" ");
}

export function rowToSummary(r: Row): MeetingSummary {
  return {
    id: String(r.id),
    title: String(r.title ?? "Untitled meeting"),
    source_app: str(r.source_app),
    started_at: Number(r.started_at),
    ended_at: num(r.ended_at),
    duration_ms: num(r.duration_ms),
    status: String(r.status ?? "ready"),
    language: str(r.language),
    attendees: parseJsonArray(r.attendees, []),
    tags: parseJsonArray(r.tags, []),
    starred: Boolean(Number(r.starred ?? 0)),
  };
}

export interface SqliteReaderOptions {
  /** Path to recordist.db. Must exist. */
  dbPath: string;
}

export class SqliteReader implements RecordistData {
  readonly mode = "sqlite" as const;
  readonly dbPath: string;
  private readonly db: Database.Database;
  private readonly hasFts: boolean;

  constructor(opts: SqliteReaderOptions) {
    this.dbPath = opts.dbPath;
    this.db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });
    this.hasFts = this.detectFts();
  }

  static exists(dbPath: string): boolean {
    return existsSync(dbPath);
  }

  get ftsAvailable(): boolean {
    return this.hasFts;
  }

  private detectFts(): boolean {
    try {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='segments_fts'")
        .get() as Row | undefined;
      if (!row) return false;
      // Make sure the FTS module is actually loadable in this SQLite build.
      this.db.prepare("SELECT rowid FROM segments_fts WHERE segments_fts MATCH '\"x\"' LIMIT 1").all();
      return true;
    } catch {
      return false;
    }
  }

  async health(): Promise<Health> {
    const rec = this.db
      .prepare("SELECT id FROM meetings WHERE status = 'recording' ORDER BY started_at DESC LIMIT 1")
      .get() as Row | undefined;
    const base: Health = {
      ok: true,
      version: "sqlite-readonly",
      recording: { active: Boolean(rec) },
      authenticated: true,
    };
    if (rec) base.recording.meeting_id = String(rec.id);
    return base;
  }

  // ---- reads ---------------------------------------------------------------

  async listMeetings(opts: ListMeetingsOptions = {}): Promise<MeetingSummary[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.from != null) {
      where.push("m.started_at >= ?");
      params.push(opts.from);
    }
    if (opts.to != null) {
      where.push("m.started_at <= ?");
      params.push(opts.to);
    }
    const q = opts.q?.trim();
    if (q && q.length > 0) {
      const like = `%${q}%`;
      if (this.hasFts) {
        where.push(
          `(m.title LIKE ? OR m.id IN (
             SELECT s.meeting_id FROM segments s
             WHERE s.id IN (SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?)
           ) OR m.id IN (SELECT n.meeting_id FROM notes n WHERE n.content_md LIKE ?))`,
        );
        params.push(like, toFtsQuery(q), like);
      } else {
        where.push(
          `(m.title LIKE ? OR m.id IN (SELECT s.meeting_id FROM segments s WHERE s.text LIKE ?)
            OR m.id IN (SELECT n.meeting_id FROM notes n WHERE n.content_md LIKE ?))`,
        );
        params.push(like, like, like);
      }
    }

    const sql = `SELECT m.id, m.title, m.source_app, m.started_at, m.ended_at, m.duration_ms,
                        m.status, m.language, m.attendees, m.tags, m.starred
                 FROM meetings m
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY m.started_at DESC
                 LIMIT ? OFFSET ?`;
    params.push(clampLimit(opts.limit), Math.max(0, Math.floor(opts.offset ?? 0)));
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(rowToSummary);
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    const row = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const summary = rowToSummary(row);

    const notes = (
      this.db
        .prepare(
          `SELECT id, kind, template_id, provider, model, content_md, content_json, created_at
           FROM notes WHERE meeting_id = ? ORDER BY created_at ASC`,
        )
        .all(id) as Row[]
    ).map(
      (n): Note => ({
        id: String(n.id),
        kind: String(n.kind),
        template_id: str(n.template_id),
        provider: str(n.provider),
        model: str(n.model),
        content_md: String(n.content_md ?? ""),
        content_json: parseJson(n.content_json),
        created_at: Number(n.created_at),
      }),
    );

    const action_items = this.actionItemRows("WHERE a.meeting_id = ?", [id]);

    const markers = (
      this.db
        .prepare("SELECT id, at_ms, label, created_at FROM markers WHERE meeting_id = ? ORDER BY at_ms ASC")
        .all(id) as Row[]
    ).map(
      (m): Marker => ({
        id: String(m.id),
        at_ms: Number(m.at_ms),
        label: str(m.label),
        created_at: Number(m.created_at),
      }),
    );

    return {
      ...summary,
      calendar_ref: str(row.calendar_ref),
      template_id: str(row.template_id),
      notes,
      action_items,
      markers,
    };
  }

  async getTranscript(id: string): Promise<Transcript | null> {
    const exists = this.db.prepare("SELECT 1 FROM meetings WHERE id = ?").get(id);
    if (!exists) return null;
    const rows = this.db
      .prepare(
        `SELECT speaker, channel, start_ms, end_ms, text, confidence
         FROM segments WHERE meeting_id = ? ORDER BY start_ms ASC, id ASC`,
      )
      .all(id) as Row[];
    const segments: Segment[] = rows.map((r) => ({
      speaker: str(r.speaker),
      channel: String(r.channel),
      start_ms: Number(r.start_ms),
      end_ms: Number(r.end_ms),
      text: String(r.text ?? ""),
      confidence: num(r.confidence),
    }));
    return { meeting_id: id, segments };
  }

  async search(q: string, opts: { limit?: number } = {}): Promise<SearchHit[]> {
    const query = q.trim();
    if (query.length === 0) return [];
    const limit = clampLimit(opts.limit, 20);
    const hits: SearchHit[] = [];

    if (this.hasFts) {
      const rows = this.db
        .prepare(
          `SELECT s.meeting_id, m.title, m.started_at, s.start_ms, s.speaker,
                  snippet(segments_fts, 0, '[', ']', '…', 14) AS snippet,
                  bm25(segments_fts) AS score
           FROM segments_fts
           JOIN segments s ON s.id = segments_fts.rowid
           JOIN meetings m ON m.id = s.meeting_id
           WHERE segments_fts MATCH ?
           ORDER BY score
           LIMIT ?`,
        )
        .all(toFtsQuery(query), limit) as Row[];
      for (const r of rows) {
        hits.push({
          meeting_id: String(r.meeting_id),
          meeting_title: String(r.title),
          started_at: Number(r.started_at),
          kind: "segment",
          snippet: String(r.snippet),
          start_ms: Number(r.start_ms),
          speaker: str(r.speaker),
          score: Number(r.score),
        });
      }
    } else {
      const rows = this.db
        .prepare(
          `SELECT s.meeting_id, m.title, m.started_at, s.start_ms, s.speaker, s.text
           FROM segments s JOIN meetings m ON m.id = s.meeting_id
           WHERE s.text LIKE ? ORDER BY m.started_at DESC, s.start_ms ASC LIMIT ?`,
        )
        .all(`%${query}%`, limit) as Row[];
      for (const r of rows) {
        hits.push({
          meeting_id: String(r.meeting_id),
          meeting_title: String(r.title),
          started_at: Number(r.started_at),
          kind: "segment",
          snippet: likeSnippet(String(r.text), query),
          start_ms: Number(r.start_ms),
          speaker: str(r.speaker),
        });
      }
    }

    // Notes are not in FTS; a LIKE scan over markdown is cheap enough.
    const remaining = limit - hits.length;
    if (remaining > 0) {
      const noteRows = this.db
        .prepare(
          `SELECT n.meeting_id, n.kind, n.content_md, m.title, m.started_at
           FROM notes n JOIN meetings m ON m.id = n.meeting_id
           WHERE n.content_md LIKE ? ORDER BY m.started_at DESC LIMIT ?`,
        )
        .all(`%${query}%`, remaining) as Row[];
      for (const r of noteRows) {
        hits.push({
          meeting_id: String(r.meeting_id),
          meeting_title: String(r.title),
          started_at: Number(r.started_at),
          kind: "note",
          note_kind: String(r.kind),
          snippet: likeSnippet(String(r.content_md), query),
        });
      }
    }
    return hits;
  }

  async getActionItems(opts: ActionItemsOptions = {}): Promise<ActionItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.meeting_id) {
      where.push("a.meeting_id = ?");
      params.push(opts.meeting_id);
    }
    if (opts.open_only) where.push("a.done = 0");
    const clause = where.length ? "WHERE " + where.join(" AND ") : "";
    return this.actionItemRows(clause, params, clampLimit(opts.limit, 200));
  }

  private actionItemRows(whereClause: string, params: unknown[], limit?: number): ActionItem[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.meeting_id, a.text, a.owner, a.due, a.done, a.source_ms, a.created_at, m.title
         FROM action_items a JOIN meetings m ON m.id = a.meeting_id
         ${whereClause}
         ORDER BY m.started_at DESC, a.created_at ASC
         ${limit ? "LIMIT " + limit : ""}`,
      )
      .all(...params) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      meeting_id: String(r.meeting_id),
      meeting_title: String(r.title),
      text: String(r.text),
      owner: str(r.owner),
      due: str(r.due),
      done: Boolean(Number(r.done ?? 0)),
      source_ms: num(r.source_ms),
      created_at: Number(r.created_at),
    }));
  }

  // ---- actions: unavailable without the app ---------------------------------

  async regenerateNotes(): Promise<never> {
    throw new AppNotRunningError("regenerate notes");
  }
  async startRecording(): Promise<never> {
    throw new AppNotRunningError("start recording");
  }
  async stopRecording(): Promise<never> {
    throw new AppNotRunningError("stop recording");
  }
  async addMarker(): Promise<never> {
    throw new AppNotRunningError("add a marker");
  }

  close(): void {
    this.db.close();
  }
}

/** Build a bracketed snippet around the first case-insensitive match. */
export function likeSnippet(text: string, query: string, radius = 60): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const before = text.slice(start, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length, end);
  return `${prefix}${before}[${match}]${after}${suffix}`;
}
