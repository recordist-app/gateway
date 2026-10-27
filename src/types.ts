/**
 * Shared domain types for the Recordist gateway.
 *
 * These mirror the Meeting JSON and Transcript JSON shapes of the app's local
 * API (https://recordist.app/developers/local-api) and the tables the app keeps
 * in recordist.db.
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
  /** False when the app answered its minimal, unauthenticated health (token missing or not accepted). */
  authenticated: boolean;
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

/** `POST /v1/recording/prompt`: the record card's id, or null when Recordist showed none. */
export interface PromptResult {
  prompt_id: string | null;
  /**
   * Why no card was shown, from Recordist 1.0.5 on: "recording", "starting", "finishing", "snoozed", "cooldown",
   * "series_skipped" or "auto_recording". An earlier app leaves it out.
   */
  reason?: string;
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

/**
 * Recordist Agent: an action the assistant suggests. The app shows it as a card that says exactly what will happen; the
 * person presses Approve or Not now. Nothing runs on the suggestion itself.
 */
export type ExportFormat = "md" | "txt" | "srt" | "vtt" | "json";
export type ProposedAction =
  | { kind: "draft_followup"; meeting_id: string; template_id?: string }
  | { kind: "mark_promise_done"; action_item_id: string }
  | { kind: "export_meeting"; meeting_id: string; format?: ExportFormat };

export interface ProposeActionOptions {
  action: ProposedAction;
  /** Why, in the assistant's words; shown on the card as such (at most 300 characters). */
  reason?: string;
  /** The assistant behind the gateway, shown on the card ("Claude Desktop"). */
  via?: string;
}

export type ProposalStatus = "proposed" | "running" | "done" | "failed" | "declined" | "expired";

/** What the app tells the gateway about a suggestion: its status and the times. Never the card's words or the result. */
export interface ProposalState {
  id: string;
  status: ProposalStatus;
  expires_at?: number;
  decided_at?: number | null;
}
