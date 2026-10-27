/**
 * Backend selection.
 *
 *  1. Probe `GET /v1/health` with an 800 ms timeout.
 *  2. Reachable → every call goes to the API.
 *  3. Unreachable → reads go to the read-only SQLite DB; actions fail with
 *     "Recordist app is not running".
 *
 * The probe result is cached briefly so a burst of tool calls does not hammer
 * the health endpoint, but the app becoming (un)available is noticed quickly.
 */
import type {
  ActionItem,
  ActionItemsOptions,
  Health,
  ListMeetingsOptions,
  MarkerResult,
  Meeting,
  MeetingSummary,
  PromptResult,
  ProposalState,
  ProposeActionOptions,
  RecordingResult,
  RegenerateNotesOptions,
  RegenerateResult,
  SearchHit,
  StartRecordingOptions,
  Transcript,
} from "../types.js";
import { loadConfig, type GatewayConfig } from "../config.js";
import { ApiClient } from "./api.js";
import { AppNotRunningError, NoDataSourceError } from "./errors.js";
import { SqliteReader } from "./sqlite.js";
import type { DataMode, RecordistData } from "./types.js";

/**
 * Before an action is refused as "not running", the app is given this long to answer: a closed app refuses at once,
 * but a busy one (short of memory, writing up a recording) can take longer than the quick probe that picks a reader.
 */
export const ACTION_PROBE_TIMEOUT_MS = 3_000;

export interface AutoDataOptions {
  api: ApiClient | null;
  /** Lazily opened so a missing DB is only an error when it is needed. */
  openSqlite: () => SqliteReader | null;
  /** How long a probe result stays valid (ms). */
  probeTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class AutoData implements RecordistData {
  private readonly api: ApiClient | null;
  private readonly openSqlite: () => SqliteReader | null;
  private sqlite: SqliteReader | null | undefined;
  /** Why the database could not be opened, when it exists but no SQLite driver could read it. */
  private sqliteError: string | null = null;
  private readonly probeTtlMs: number;
  private readonly now: () => number;
  private lastProbeAt = -Infinity;
  private apiReachable = false;
  private probeInFlight: Promise<boolean> | null = null;

  constructor(opts: AutoDataOptions) {
    this.api = opts.api;
    this.openSqlite = opts.openSqlite;
    this.probeTtlMs = opts.probeTtlMs ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  get mode(): DataMode {
    return this.apiReachable ? "api" : "sqlite";
  }

  /** Whether the last probe found the app. Call `probe()` to refresh. */
  get appReachable(): boolean {
    return this.apiReachable;
  }

  async probe(force = false): Promise<boolean> {
    if (!this.api) return (this.apiReachable = false);
    if (!force && this.now() - this.lastProbeAt < this.probeTtlMs) return this.apiReachable;
    if (this.probeInFlight) return this.probeInFlight;
    this.probeInFlight = (async () => {
      try {
        this.apiReachable = await this.api!.isReachable();
      } finally {
        this.lastProbeAt = this.now();
        this.probeInFlight = null;
      }
      return this.apiReachable;
    })();
    return this.probeInFlight;
  }

  private getSqlite(): SqliteReader | null {
    if (this.sqlite === undefined) {
      try {
        this.sqlite = this.openSqlite();
      } catch (err) {
        this.sqlite = null;
        this.sqliteError = err instanceof Error ? err.message : String(err);
      }
    }
    return this.sqlite;
  }

  private async reader(): Promise<RecordistData> {
    if (await this.probe()) return this.api!;
    const db = this.getSqlite();
    if (db) return db;
    if (this.sqliteError) {
      throw new NoDataSourceError(
        `${this.api ? "the app is not running and " : ""}recordist.db ${this.sqliteError}`,
      );
    }
    throw new NoDataSourceError(
      this.api ? "the app is not running and recordist.db was not found" : "recordist.db was not found",
    );
  }

  private async actor(action: string): Promise<RecordistData> {
    if (await this.probe()) return this.api!;
    if (this.api && (await this.api.isReachable(ACTION_PROBE_TIMEOUT_MS))) {
      this.apiReachable = true;
      this.lastProbeAt = this.now();
      return this.api;
    }
    throw new AppNotRunningError(action);
  }

  async health(): Promise<Health> {
    return (await this.reader()).health();
  }
  async listMeetings(opts?: ListMeetingsOptions): Promise<MeetingSummary[]> {
    return (await this.reader()).listMeetings(opts);
  }
  async getMeeting(id: string): Promise<Meeting | null> {
    return (await this.reader()).getMeeting(id);
  }
  async getTranscript(id: string): Promise<Transcript | null> {
    return (await this.reader()).getTranscript(id);
  }
  async search(q: string, opts?: { limit?: number }): Promise<SearchHit[]> {
    return (await this.reader()).search(q, opts);
  }
  async getActionItems(opts?: ActionItemsOptions): Promise<ActionItem[]> {
    return (await this.reader()).getActionItems(opts);
  }
  async regenerateNotes(opts: RegenerateNotesOptions): Promise<RegenerateResult> {
    return (await this.actor("regenerate notes")).regenerateNotes(opts);
  }
  async startRecording(opts?: StartRecordingOptions): Promise<RecordingResult> {
    return (await this.actor("start recording")).startRecording(opts);
  }
  async promptRecording(opts?: StartRecordingOptions): Promise<PromptResult> {
    return (await this.actor("show the record card")).promptRecording(opts);
  }
  async stopRecording(): Promise<RecordingResult> {
    return (await this.actor("stop recording")).stopRecording();
  }
  async addMarker(label?: string): Promise<MarkerResult> {
    return (await this.actor("add a marker")).addMarker(label);
  }
  async proposeAction(opts: ProposeActionOptions): Promise<ProposalState> {
    return (await this.actor("suggest an action")).proposeAction(opts);
  }
  async proposalStatus(id: string): Promise<ProposalState | null> {
    return (await this.actor("ask about a suggestion")).proposalStatus(id);
  }

  close(): void {
    this.sqlite?.close();
    this.sqlite = undefined;
    this.sqliteError = null;
  }
}

/** Build the default data source from env/config. */
export function createRecordistData(config: GatewayConfig = loadConfig()): AutoData {
  const api = new ApiClient({ baseUrl: config.apiUrl, token: config.apiToken });
  return new AutoData({
    api,
    openSqlite: () => (SqliteReader.exists(config.dbPath) ? new SqliteReader({ dbPath: config.dbPath }) : null),
  });
}
