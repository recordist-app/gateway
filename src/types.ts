/**
 * Shared domain types for the Recordist gateway.
 *
 * These mirror the JSON shapes in docs/product/CONTRACTS.md §3 (Meeting JSON,
 * Transcript JSON) and the SQLite schema in §2.
 */

export type SourceApp =
  | "zoom"
  | "teams"
  | "meet"
  | "slack"
  | "webex"
  | "facetime"
  | "manual"
  | "unknown";

export type MeetingStatus =
  | "recording"
  | "transcribing"
  | "summarising"
  | "ready"
  | "failed";

export type NoteKind =
  | "summary"
  | "action_items"
  | "decisions"
  | "questions"
  | "followup_email"
  | "custom"
  | "user";

export type TranscriptFormat = "json" | "md" | "srt" | "vtt" | "txt";

export const TRANSCRIPT_FORMATS: readonly TranscriptFormat[] = [
  "json",
  "md",
  "srt",
  "vtt",
  "txt",
];

export interface Attendee {
  name: string;
  email?: string;
}

/** A meeting row without its child collections (used by list endpoints). */
export interface MeetingSummary {
  id: string;
  title: string;
  source_app: SourceApp | string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: MeetingStatus | string;
  language: string | null;
  attendees: Attendee[];
  tags: string[];
  starred: boolean;
}

export interface Note {
  id: string;
  kind: NoteKind | string;
  content_md: string;
  template_id?: string | null;
  provider?: string | null;
  model?: string | null;
  content_json?: unknown;
  created_at?: number;
}

export interface ActionItem {
  id: string;
  meeting_id: string;
  text: string;
  owner: string | null;
  due: string | null;
  done: boolean;
  source_ms?: number | null;
  created_at?: number;
  /** Populated by get_action_items so callers can group by meeting. */
  meeting_title?: string;
}

export interface Marker {
  id: string;
  at_ms: number;
  label: string | null;
  created_at?: number;
}

/** Full meeting as returned by `GET /v1/meetings/:id`. */
export interface Meeting extends MeetingSummary {
  notes: Note[];
  action_items: ActionItem[];
  markers: Marker[];
  calendar_ref?: string | null;
  template_id?: string | null;
}

export interface Segment {
  speaker: string | null;
  channel: "mic" | "sys" | string;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence?: number | null;
}

export interface Transcript {
  meeting_id: string;
  segments: Segment[];
}

export interface SearchHit {
  meeting_id: string;
  meeting_title: string;
  started_at: number;
  /** Where the hit came from. */
  kind: "segment" | "note";
  snippet: string;
  /** For segment hits. */
  start_ms?: number;
  speaker?: string | null;
  /** For note hits. */
  note_kind?: string;
  score?: number;
}

export interface Health {
  ok: boolean;
  version: string;
  recording: { active: boolean; meeting_id?: string };
}

export interface ListMeetingsOptions {
  q?: string;
  limit?: number;
  offset?: number;
  /** unix ms, inclusive */
  from?: number;
  /** unix ms, inclusive */
  to?: number;
}

export interface ActionItemsOptions {
  meeting_id?: string;
  open_only?: boolean;
  limit?: number;
}

export interface RegenerateNotesOptions {
  meeting_id: string;
  kind: NoteKind | string;
  template_id?: string;
}

export interface StartRecordingOptions {
  source_app?: SourceApp | string;
  title?: string;
}

export interface RecordingResult {
  ok: boolean;
  meeting_id?: string;
  [key: string]: unknown;
}

export interface MarkerResult {
  ok: boolean;
  marker?: Marker;
  meeting_id?: string;
  [key: string]: unknown;
}

export interface RegenerateResult {
  ok: boolean;
  note?: Note;
  [key: string]: unknown;
}
