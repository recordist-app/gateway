/**
 * Client for the desktop app's local REST API (CONTRACTS.md §3).
 * Loopback only, bearer-token authenticated.
 */
import type {
  ActionItem,
  ActionItemsOptions,
  Health,
  ListMeetingsOptions,
  MarkerResult,
  Meeting,
  MeetingSummary,
  RecordingResult,
  RegenerateNotesOptions,
  RegenerateResult,
  SearchHit,
  StartRecordingOptions,
  Transcript,
} from "../types.js";
import { API_HEALTH_TIMEOUT_MS } from "../config.js";
import { ApiError } from "./errors.js";
import type { RecordistData } from "./types.js";

export type FetchLike = typeof fetch;

export interface ApiClientOptions {
  baseUrl: string;
  token: string | null;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Default request timeout in ms (health uses `healthTimeoutMs`). */
  timeoutMs?: number;
  healthTimeoutMs?: number;
}

function normaliseMeeting(raw: Record<string, unknown>): Meeting {
  const summary = normaliseSummary(raw);
  return {
    ...summary,
    notes: Array.isArray(raw.notes) ? (raw.notes as Meeting["notes"]) : [],
    action_items: Array.isArray(raw.action_items)
      ? (raw.action_items as Meeting["action_items"]).map((a) => ({
          ...a,
          meeting_id: a.meeting_id ?? summary.id,
          done: Boolean(a.done),
        }))
      : [],
    markers: Array.isArray(raw.markers) ? (raw.markers as Meeting["markers"]) : [],
    calendar_ref: (raw.calendar_ref as string | null | undefined) ?? null,
    template_id: (raw.template_id as string | null | undefined) ?? null,
  };
}

function normaliseSummary(raw: Record<string, unknown>): MeetingSummary {
  return {
    id: String(raw.id),
    title: String(raw.title ?? "Untitled meeting"),
    source_app: (raw.source_app as string | null | undefined) ?? null,
    started_at: Number(raw.started_at),
    ended_at: raw.ended_at == null ? null : Number(raw.ended_at),
    duration_ms: raw.duration_ms == null ? null : Number(raw.duration_ms),
    status: String(raw.status ?? "ready"),
    language: (raw.language as string | null | undefined) ?? null,
    attendees: Array.isArray(raw.attendees) ? (raw.attendees as MeetingSummary["attendees"]) : [],
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    starred: Boolean(raw.starred),
  };
}

export class ApiClient implements RecordistData {
  readonly mode = "api" as const;
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? API_HEALTH_TIMEOUT_MS;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined>; timeoutMs?: number; raw?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && String(v).length > 0) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let code = `http_${res.status}`;
        let message = text || res.statusText;
        try {
          const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
          if (parsed?.error) {
            code = parsed.error.code ?? code;
            message = parsed.error.message ?? message;
          }
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(res.status, code, message);
      }
      if (opts.raw) return text as unknown as T;
      if (text.length === 0) return {} as T;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Health probe with a short timeout. Throws on any failure. */
  async health(): Promise<Health> {
    const h = await this.request<Health>("GET", "/v1/health", { timeoutMs: this.healthTimeoutMs });
    // Without an accepted bearer token the app answers only { ok, version }: reachable, not usable.
    return {
      ok: Boolean(h.ok),
      version: String(h.version ?? "unknown"),
      recording: h.recording ?? { active: false },
      authenticated: h.recording !== undefined,
    };
  }

  /** `true` when the app answers `/v1/health` within the health timeout. */
  async isReachable(): Promise<boolean> {
    try {
      const h = await this.health();
      return h.ok;
    } catch {
      return false;
    }
  }

  async listMeetings(opts: ListMeetingsOptions = {}): Promise<MeetingSummary[]> {
    const res = await this.request<{ meetings?: unknown[] } | unknown[]>("GET", "/v1/meetings", {
      query: { q: opts.q, limit: opts.limit, offset: opts.offset, from: opts.from, to: opts.to },
    });
    const arr = Array.isArray(res) ? res : (res.meetings ?? []);
    return arr.map((m) => normaliseSummary(m as Record<string, unknown>));
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    try {
      const raw = await this.request<Record<string, unknown>>("GET", `/v1/meetings/${encodeURIComponent(id)}`);
      return normaliseMeeting(raw);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getTranscript(id: string): Promise<Transcript | null> {
    try {
      const raw = await this.request<Transcript>(
        "GET",
        `/v1/meetings/${encodeURIComponent(id)}/transcript`,
        { query: { format: "json" } },
      );
      return { meeting_id: raw.meeting_id ?? id, segments: raw.segments ?? [] };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Ask the app to render a transcript in a non-JSON format. */
  async getTranscriptFormatted(id: string, format: string): Promise<string | null> {
    try {
      return await this.request<string>("GET", `/v1/meetings/${encodeURIComponent(id)}/transcript`, {
        query: { format },
        raw: true,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async search(q: string, opts: { limit?: number } = {}): Promise<SearchHit[]> {
    const res = await this.request<{ hits?: unknown[] } | unknown[]>("GET", "/v1/search", {
      query: { q, limit: opts.limit },
    });
    const arr = Array.isArray(res) ? res : (res.hits ?? []);
    return arr.map((h) => {
      const r = h as Record<string, unknown>;
      return {
        meeting_id: String(r.meeting_id),
        meeting_title: String(r.meeting_title ?? r.title ?? ""),
        started_at: Number(r.started_at ?? 0),
        kind: (r.kind === "note" ? "note" : "segment") as SearchHit["kind"],
        snippet: String(r.snippet ?? r.text ?? ""),
        start_ms: r.start_ms == null ? undefined : Number(r.start_ms),
        speaker: (r.speaker as string | null | undefined) ?? null,
        note_kind: r.note_kind == null ? undefined : String(r.note_kind),
        score: r.score == null ? undefined : Number(r.score),
      };
    });
  }

  /**
   * The REST contract has no dedicated action-items endpoint, so this is
   * assembled from `/v1/meetings/:id` (single meeting) or the recent meetings.
   */
  async getActionItems(opts: ActionItemsOptions = {}): Promise<ActionItem[]> {
    const ids: string[] = [];
    if (opts.meeting_id) {
      ids.push(opts.meeting_id);
    } else {
      const meetings = await this.listMeetings({ limit: Math.min(opts.limit ?? 50, 100) });
      ids.push(...meetings.map((m) => m.id));
    }
    const out: ActionItem[] = [];
    for (const id of ids) {
      const m = await this.getMeeting(id);
      if (!m) continue;
      for (const a of m.action_items) {
        if (opts.open_only && a.done) continue;
        out.push({ ...a, meeting_id: id, meeting_title: m.title });
      }
    }
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  async regenerateNotes(opts: RegenerateNotesOptions): Promise<RegenerateResult> {
    const res = await this.request<Record<string, unknown>>(
      "POST",
      `/v1/meetings/${encodeURIComponent(opts.meeting_id)}/notes`,
      { body: { kind: opts.kind, template_id: opts.template_id }, timeoutMs: 120_000 },
    );
    return { ok: true, ...res } as RegenerateResult;
  }

  async startRecording(opts: StartRecordingOptions = {}): Promise<RecordingResult> {
    const res = await this.request<Record<string, unknown>>("POST", "/v1/recording/start", {
      body: { source_app: opts.source_app ?? "manual", title: opts.title },
    });
    return { ok: true, ...res } as RecordingResult;
  }

  async stopRecording(): Promise<RecordingResult> {
    const res = await this.request<Record<string, unknown>>("POST", "/v1/recording/stop", { body: {} });
    return { ok: true, ...res } as RecordingResult;
  }

  async addMarker(label?: string): Promise<MarkerResult> {
    const res = await this.request<Record<string, unknown>>("POST", "/v1/recording/marker", {
      body: { label },
    });
    return { ok: true, ...res } as MarkerResult;
  }

  close(): void {
    /* nothing to release */
  }
}
