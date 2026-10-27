/**
 * The nine gateway tools, defined once and shared by the MCP server and the
 * A2A agent so both surfaces behave identically.
 */
import { z } from "zod";

import type { RecordistData } from "./data/types.js";
import { ApiError, NotFoundError } from "./data/errors.js";
import { formatDate, formatDuration, formatTranscript, msToClock } from "./format.js";
import type { ActionItem, ExportFormat, Meeting, MeetingSummary, ProposedAction, SearchHit, TranscriptFormat } from "./types.js";
import { TRANSCRIPT_FORMATS } from "./types.js";

export interface ToolResult {
  /** Human/LLM readable rendering. */
  text: string;
  /** Structured payload (returned as MCP structuredContent / A2A data part). */
  data: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDef<Shape extends z.ZodRawShape = any> {
  name: string;
  title: string;
  description: string;
  inputShape: Shape;
  readOnly: boolean;
  /**
   * Ends or replaces something the person has (a recording under way, the current notes): hosts are told
   * (destructiveHint) so they ask each time rather than run it unasked.
   */
  destructive?: boolean;
  /** Natural-language examples surfaced in the A2A agent card. */
  examples: string[];
  run(data: RecordistData, args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

// ---- helpers ---------------------------------------------------------------

/** Accepts unix ms, a numeric string, or an ISO date/datetime. */
export function parseWhen(v: string | number | undefined | null): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return v;
  const trimmed = v.trim();
  if (/^\d{10,}$/.test(trimmed)) return Number(trimmed);
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return t;
  throw new Error(`Cannot parse date: ${v}`);
}

const whenSchema = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Unix ms or ISO-8601 date (e.g. 2025-09-01 or 2025-09-01T09:00:00Z)");

export function renderMeetingLine(m: MeetingSummary): string {
  const parts = [
    `- **${m.title}** (\`${m.id}\`)`,
    `  ${formatDate(m.started_at)} · ${formatDuration(m.duration_ms)} · ${m.source_app ?? "unknown"} · ${m.status}`,
  ];
  if (m.attendees.length) parts.push(`  with ${m.attendees.map((a) => a.name).join(", ")}`);
  if (m.tags.length) parts.push(`  tags: ${m.tags.join(", ")}`);
  return parts.join("\n");
}

export function renderMeeting(m: Meeting): string {
  const lines: string[] = [];
  lines.push(`# ${m.title}`);
  lines.push("");
  lines.push(`- id: \`${m.id}\``);
  lines.push(`- started: ${formatDate(m.started_at)}`);
  lines.push(`- duration: ${formatDuration(m.duration_ms)}`);
  lines.push(`- source: ${m.source_app ?? "unknown"} · status: ${m.status}${m.language ? ` · language: ${m.language}` : ""}`);
  if (m.attendees.length) lines.push(`- attendees: ${m.attendees.map((a) => a.email ? `${a.name} <${a.email}>` : a.name).join(", ")}`);
  if (m.tags.length) lines.push(`- tags: ${m.tags.join(", ")}`);
  if (m.starred) lines.push("- starred");
  lines.push("");

  for (const note of m.notes) {
    lines.push(`## ${note.kind.replace(/_/g, " ")}`);
    lines.push("");
    lines.push(note.content_md.trim());
    lines.push("");
  }

  if (m.action_items.length) {
    lines.push("## Action items");
    lines.push("");
    for (const a of m.action_items) lines.push(renderActionItem(a));
    lines.push("");
  }

  if (m.markers.length) {
    lines.push("## Markers");
    lines.push("");
    for (const mk of m.markers) lines.push(`- [${msToClock(mk.at_ms)}] ${mk.label ?? "(no label)"}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function renderActionItem(a: ActionItem): string {
  const box = a.done ? "[x]" : "[ ]";
  const meta: string[] = [];
  if (a.owner) meta.push(`owner: ${a.owner}`);
  if (a.due) meta.push(`due: ${a.due}`);
  if (a.source_ms != null) meta.push(`at ${msToClock(a.source_ms)}`);
  return `- ${box} ${a.text}${meta.length ? ` _(${meta.join(", ")})_` : ""} \`${a.id}\``;
}

function renderHit(h: SearchHit): string {
  const where = h.kind === "segment"
    ? `${h.start_ms != null ? msToClock(h.start_ms) : "?"}${h.speaker ? ` ${h.speaker}` : ""}`
    : `note:${h.note_kind ?? "?"}`;
  return `- **${h.meeting_title}** (\`${h.meeting_id}\`, ${formatDate(h.started_at)}), at ${where}\n  ${h.snippet.replace(/\s+/g, " ").trim()}`;
}

async function requireMeeting(data: RecordistData, id: string): Promise<Meeting> {
  const m = await data.getMeeting(id);
  if (!m) throw new NotFoundError("Meeting", id);
  return m;
}

// ---- tool definitions -------------------------------------------------------

export const listMeetings = defineTool({
  name: "list_meetings",
  title: "List meetings",
  description:
    "List recent meetings captured by Recordist, newest first. Optional full-text filter `q`, a date range (`from`/`to`) and paging (`limit`/`offset`). Returns id, title, start time, duration, source app, status, attendees and tags.",
  readOnly: true,
  examples: ["List my meetings from this week", "Show the last 5 meetings", "Which meetings mention pricing?"],
  inputShape: {
    q: z.string().optional().describe("Full-text filter across titles, transcripts and notes"),
    limit: z.number().int().min(1).max(200).optional().describe("Max results (default 20)"),
    offset: z.number().int().min(0).optional().describe("Skip this many results"),
    from: whenSchema,
    to: whenSchema,
  },
  async run(data, args) {
    const meetings = await data.listMeetings({
      q: args.q,
      limit: args.limit ?? 20,
      offset: args.offset,
      from: parseWhen(args.from),
      to: parseWhen(args.to),
    });
    const text = meetings.length
      ? `${meetings.length} meeting(s):\n\n${meetings.map(renderMeetingLine).join("\n")}`
      : "No meetings found.";
    return { text, data: { meetings, count: meetings.length } };
  },
});

export const getMeeting = defineTool({
  name: "get_meeting",
  title: "Get meeting",
  description:
    "Fetch one meeting by id including its AI notes (summary, decisions, …), action items and markers. Use `get_transcript` for the full transcript.",
  readOnly: true,
  examples: ["Show me meeting 01J8XYZ…", "What was decided in the weekly sync?"],
  inputShape: {
    meeting_id: z.string().min(1).describe("Meeting id (ULID)"),
  },
  async run(data, args) {
    const m = await requireMeeting(data, args.meeting_id);
    return { text: renderMeeting(m), data: { meeting: m } };
  },
});

export const getTranscript = defineTool({
  name: "get_transcript",
  title: "Get transcript",
  description:
    "Return a meeting's transcript. `format` is one of json (segments with ms timestamps), md, srt, vtt or txt (default md). Speaker labels and timestamps are included.",
  readOnly: true,
  examples: ["Get the transcript of my last meeting as SRT", "Give me the plain-text transcript for meeting 01J8…"],
  inputShape: {
    meeting_id: z.string().min(1).describe("Meeting id (ULID)"),
    format: z.enum(TRANSCRIPT_FORMATS as [TranscriptFormat, ...TranscriptFormat[]]).optional().describe("json | md | srt | vtt | txt (default md)"),
  },
  async run(data, args) {
    const format: TranscriptFormat = args.format ?? "md";
    const [meeting, transcript] = await Promise.all([data.getMeeting(args.meeting_id), data.getTranscript(args.meeting_id)]);
    if (!transcript) throw new NotFoundError("Meeting", args.meeting_id);
    const content = formatTranscript(transcript, format, { title: meeting?.title });
    const payload: Record<string, unknown> = {
      meeting_id: transcript.meeting_id,
      format,
      segment_count: transcript.segments.length,
    };
    if (format === "json") payload.segments = transcript.segments;
    else payload.content = content;
    return { text: content, data: payload };
  },
});

export const searchMeetings = defineTool({
  name: "search_meetings",
  title: "Search meetings",
  description:
    "Full-text search across all transcripts and notes. Returns matching snippets with the meeting id, title, time offset and speaker so you can jump to the moment.",
  readOnly: true,
  examples: ["Search my meetings for 'budget approval'", "When did we talk about the Q4 roadmap?"],
  inputShape: {
    query: z.string().min(1).describe("Search terms (FTS5 syntax supported; plain words are ANDed)"),
    limit: z.number().int().min(1).max(100).optional().describe("Max hits (default 20)"),
  },
  async run(data, args) {
    const hits = await data.search(args.query, { limit: args.limit ?? 20 });
    const text = hits.length
      ? `${hits.length} hit(s) for "${args.query}":\n\n${hits.map(renderHit).join("\n")}`
      : `No results for "${args.query}".`;
    return { text, data: { query: args.query, hits, count: hits.length } };
  },
});

export const getActionItems = defineTool({
  name: "get_action_items",
  title: "Get action items",
  description:
    "List action items extracted from meetings. Filter by `meeting_id` and/or `open_only` (exclude completed items).",
  readOnly: true,
  examples: ["What are my open action items?", "List the to-dos from the design review"],
  inputShape: {
    meeting_id: z.string().optional().describe("Restrict to one meeting"),
    open_only: z.boolean().optional().describe("Only items not marked done (default false)"),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async run(data, args) {
    const items = await data.getActionItems({
      meeting_id: args.meeting_id,
      open_only: args.open_only ?? false,
      limit: args.limit,
    });
    if (!items.length) return { text: "No action items found.", data: { action_items: [], count: 0 } };
    const byMeeting = new Map<string, ActionItem[]>();
    for (const it of items) {
      const key = `${it.meeting_title ?? "Meeting"} (\`${it.meeting_id}\`)`;
      byMeeting.set(key, [...(byMeeting.get(key) ?? []), it]);
    }
    const blocks = [...byMeeting.entries()].map(([k, list]) => `**${k}**\n${list.map(renderActionItem).join("\n")}`);
    return {
      text: `${items.length} action item(s)${args.open_only ? " (open)" : ""}:\n\n${blocks.join("\n\n")}`,
      data: { action_items: items, count: items.length },
    };
  },
});

export const NOTE_KINDS = ["summary", "action_items", "decisions", "questions", "followup_email", "custom"] as const;

export const regenerateNotes = defineTool({
  name: "regenerate_notes",
  title: "Regenerate notes",
  description:
    "Ask the Recordist app to write a meeting's AI notes again. They replace the current notes and open action items (Recordist keeps the earlier ones under Earlier notes; the person's own notes stay). `kind` is summary, action_items, decisions, questions, followup_email or custom; `template_id` selects a template. Requires the app to be running.",
  readOnly: false,
  destructive: true,
  examples: ["Regenerate the summary for meeting 01J8…", "Redo the action items for my last meeting"],
  inputShape: {
    meeting_id: z.string().min(1),
    kind: z.enum(NOTE_KINDS).optional().describe("Default summary"),
    template_id: z.string().optional(),
  },
  async run(data, args) {
    const res = await data.regenerateNotes({ meeting_id: args.meeting_id, kind: args.kind ?? "summary", template_id: args.template_id });
    return {
      text: `Requested ${args.kind ?? "summary"} regeneration for meeting ${args.meeting_id}.${res.note ? `\n\n${res.note.content_md}` : ""}`,
      data: { ...res, meeting_id: args.meeting_id, kind: args.kind ?? "summary" },
    };
  },
});

/**
 * Why Recordist showed no record card, by the reason it gives (Recordist 1.0.5 and later), as the sentence the agent
 * passes on. A reason not listed here, or none (an earlier app), gets NO_CARD_UNKNOWN.
 */
const NO_CARD: Readonly<Record<string, string>> = {
  recording: "Recordist did not show its record card because a recording is already running.",
  starting: "Recordist did not show its record card because a recording is already starting.",
  finishing: "Recordist did not show its record card because it is still writing up the last recording. The person can record again once that is done.",
  auto_recording: "Recordist is starting the recording without its card, because the person set it to record this app without asking.",
  snoozed: "Recordist did not show its record card because the person paused its questions for now. The person can start the recording in Recordist.",
  cooldown: "Recordist did not show its record card because the person declined it a moment ago. The person can start the recording in Recordist.",
  series_skipped: "Recordist did not show its record card because the person asked not to be asked about this meeting series. The person can start the recording in Recordist.",
};
const NO_CARD_UNKNOWN =
  "Recordist did not show its record card: a recording may already be running, or the card was declined a moment ago, or asking is paused. The person can start the recording in Recordist.";
/** Added to the start's own refusal when Recordist refuses the card too. */
const CARD_REFUSED_TOO = "Recordist did not show its record card either, so nothing records. The person can start the recording in Recordist.";

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export const startRecording = defineTool({
  name: "start_recording",
  title: "Start recording",
  description:
    "Record a meeting via the Recordist app. If the person turned on 'Allow agents to start recordings' in Recordist (Settings, Integrations), the recording starts at once. " +
    "Otherwise, the safe default, Recordist shows its own record card on the person's laptop and nothing records until they answer it; the result says which happened. Requires the app to be running.",
  readOnly: false,
  examples: ["Start recording this meeting", "Record a meeting called 'Design sync'"],
  inputShape: {
    title: z.string().optional().describe("Meeting title"),
    source_app: z.string().optional().describe("zoom | teams | meet | slack | webex | facetime | manual (default manual)"),
  },
  async run(data, args) {
    try {
      const res = await data.startRecording({ title: args.title, source_app: args.source_app ?? "manual" });
      return {
        text: `Recording started${res.meeting_id ? ` (meeting ${res.meeting_id})` : ""}${args.title ? `: ${args.title}` : ""}.`,
        data: { ...res, started: true },
      };
    } catch (err) {
      // 403: agents may not start a recording on their own (the setting is off, or the organisation's policy). Ask the
      // way the Chrome extension and Stream Deck do: Recordist's own card, which the person answers.
      if (!(err instanceof ApiError && err.status === 403)) throw err;
      let card: Awaited<ReturnType<RecordistData["promptRecording"]>>;
      try {
        card = await data.promptRecording({ title: args.title, source_app: "manual" });
      } catch (cardErr) {
        // The card refused too (Recordist 1.0.4 and earlier refuse it while Settings, Detection, Chrome extension is
        // off). The start's own refusal is the one the person can act on: say it, never the card's internal words.
        if (cardErr instanceof ApiError && cardErr.status === 403) throw new ApiError(err.status, err.code, `${sentence(err.message)} ${CARD_REFUSED_TOO}`);
        throw cardErr;
      }
      if (card.prompt_id) {
        return {
          text: "Recordist is showing its record card on the person's laptop. Nothing records until they answer it there.",
          data: { started: false, card_shown: true, prompt_id: card.prompt_id },
        };
      }
      const why = card.reason !== undefined && Object.prototype.hasOwnProperty.call(NO_CARD, card.reason) ? NO_CARD[card.reason] : undefined;
      return {
        text: why ?? NO_CARD_UNKNOWN,
        data: { started: false, card_shown: false, ...(card.reason ? { reason: card.reason } : {}) },
      };
    }
  },
});

export const stopRecording = defineTool({
  name: "stop_recording",
  title: "Stop recording",
  description:
    "Stop the recording under way. This ends the person's recording of their call, so only stop it when they ask you to. Transcription and notes continue in the background. Requires the app to be running.",
  readOnly: false,
  destructive: true,
  examples: ["Stop recording", "End the current meeting"],
  inputShape: {},
  async run(data) {
    const res = await data.stopRecording();
    return { text: `Recording stopped${res.meeting_id ? ` (meeting ${res.meeting_id})` : ""}.`, data: { ...res } };
  },
});

export const addMarker = defineTool({
  name: "add_marker",
  title: "Add marker",
  description: "Bookmark the current moment in the active recording with an optional label. Requires the app to be running.",
  readOnly: false,
  examples: ["Add a marker called 'pricing'", "Bookmark this moment"],
  inputShape: {
    label: z.string().optional().describe("Short label for the bookmark"),
  },
  async run(data, args) {
    const res = await data.addMarker(args.label);
    return { text: `Marker added${args.label ? `: ${args.label}` : ""}.`, data: { ...res, label: args.label ?? null } };
  },
});

export const proposeAction = defineTool({
  name: "propose_action",
  title: "Suggest an action",
  description:
    "Suggest an action on the person's record for them to approve in the Recordist app: draft the follow-up (kind draft_followup: meeting_id, optional template_id), mark a promise done (kind mark_promise_done: action_item_id), or export a meeting (kind export_meeting: meeting_id, optional format md|txt|srt|vtt|json). " +
    "Nothing runs on this call. Recordist shows a card that says exactly what will happen and waits for the person to press Approve or Not now; a suggestion nobody answers runs out. " +
    "Use `reason` to say why, in one sentence; it is shown on the card in your words. Poll `action_status` for the answer. Requires the app to be running and 'Let connected assistants suggest actions' turned on in Settings → Integrations → Recordist Agent.",
  readOnly: false,
  examples: ["Suggest marking the revised-scope promise done", "Suggest exporting yesterday's client call as Markdown", "Suggest drafting the follow-up for meeting 01J8…"],
  inputShape: {
    kind: z.enum(["draft_followup", "mark_promise_done", "export_meeting"]),
    meeting_id: z.string().optional().describe("draft_followup and export_meeting"),
    action_item_id: z.string().optional().describe("mark_promise_done: the promise's id from get_action_items"),
    template_id: z.string().optional().describe("draft_followup: the template; default the meeting's own"),
    format: z.enum(["md", "txt", "srt", "vtt", "json"]).optional().describe("export_meeting: default md"),
    reason: z.string().max(300).optional().describe("Why you suggest it, in one sentence, shown to the person"),
    via: z.string().max(60).optional().describe("The assistant's name, shown on the card (for example 'Claude Desktop')"),
  },
  async run(data, args) {
    const action = toProposedAction(args);
    const res = await data.proposeAction({ action, reason: args.reason, via: args.via });
    const until = res.expires_at ? ` It waits for an answer until ${formatDate(res.expires_at)}.` : "";
    return {
      text: `Suggested in Recordist (${res.id}). Nothing has run: the person sees a card saying exactly what will happen and can press Approve or Not now.${until} Ask action_status for the answer.`,
      data: { ...res, action },
    };
  },
});

/** The flat tool arguments as the app's action object; a missing id is refused here, before anything reaches the app. */
export function toProposedAction(a: { kind: string; meeting_id?: string; action_item_id?: string; template_id?: string; format?: string }): ProposedAction {
  switch (a.kind) {
    case "draft_followup":
      if (!a.meeting_id) throw new Error("draft_followup needs meeting_id.");
      return { kind: "draft_followup", meeting_id: a.meeting_id, ...(a.template_id ? { template_id: a.template_id } : {}) };
    case "mark_promise_done":
      if (!a.action_item_id) throw new Error("mark_promise_done needs action_item_id.");
      return { kind: "mark_promise_done", action_item_id: a.action_item_id };
    case "export_meeting":
      if (!a.meeting_id) throw new Error("export_meeting needs meeting_id.");
      return { kind: "export_meeting", meeting_id: a.meeting_id, ...(a.format ? { format: a.format as ExportFormat } : {}) };
    default:
      throw new Error(`Unknown action kind: ${a.kind}`);
  }
}

export const actionStatus = defineTool({
  name: "action_status",
  title: "What became of a suggestion",
  description:
    "The status of an action you suggested with propose_action: proposed (waiting), done, failed, declined (the person said Not now) or expired (nobody answered in time). Only the status and the time of the answer come back; the card's words and any result stay in the app. Requires the app to be running.",
  readOnly: true,
  examples: ["Did they approve the suggestion?", "Check suggestion 01J9…"],
  inputShape: { id: z.string().min(1).describe("The id propose_action returned") },
  async run(data, args) {
    const res = await data.proposalStatus(args.id);
    if (!res) return { text: `Suggestion ${args.id} is no longer in Recordist.`, data: { id: args.id, status: null } };
    const words: Record<string, string> = { proposed: "is waiting for the person's answer", running: "was approved and is running", done: "was approved and done", failed: "was approved but did not work; the person saw why", declined: "was declined (Not now)", expired: "ran out before it was answered" };
    return { text: `Suggestion ${res.id} ${words[res.status] ?? res.status}.`, data: { ...res } };
  },
});

export const TOOLS: readonly ToolDef[] = [
  listMeetings,
  getMeeting,
  getTranscript,
  searchMeetings,
  getActionItems,
  regenerateNotes,
  startRecording,
  stopRecording,
  addMarker,
  proposeAction,
  actionStatus,
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Validate `args` against the tool's schema and run it. */
export async function runTool(data: RecordistData, name: string, args: unknown): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const parsed = z.object(tool.inputShape).parse(args ?? {});
  return tool.run(data, parsed);
}
