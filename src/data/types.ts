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

export type DataMode = "api" | "sqlite";

/**
 * One interface, two implementations:
 *  - `ApiClient`    → the running desktop app on 127.0.0.1:47321 (reads + actions)
 *  - `SqliteReader` → `<data>/recordist.db` opened read-only (reads only; actions throw
 *                     `AppNotRunningError`)
 *
 * `createRecordistData()` returns an `AutoData` that picks between them per call.
 */
export interface RecordistData {
  /** Which backend answered the last call (or will answer the next one). */
  readonly mode: DataMode;

  health(): Promise<Health>;

  // ---- reads --------------------------------------------------------------
  listMeetings(opts?: ListMeetingsOptions): Promise<MeetingSummary[]>;
  getMeeting(id: string): Promise<Meeting | null>;
  getTranscript(id: string): Promise<Transcript | null>;
  search(q: string, opts?: { limit?: number }): Promise<SearchHit[]>;
  getActionItems(opts?: ActionItemsOptions): Promise<ActionItem[]>;

  // ---- actions (require the running app) -----------------------------------
  regenerateNotes(opts: RegenerateNotesOptions): Promise<RegenerateResult>;
  startRecording(opts?: StartRecordingOptions): Promise<RecordingResult>;
  stopRecording(): Promise<RecordingResult>;
  addMarker(label?: string): Promise<MarkerResult>;

  close(): Promise<void> | void;
}
