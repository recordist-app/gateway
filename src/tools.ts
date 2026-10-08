/**
 * The nine gateway tools, defined once and shared by the MCP server and the
 * A2A agent so both surfaces behave identically.
 */
import { z } from "zod";

import type { RecordistData } from "./data/types.js";
import { NotFoundError } from "./data/errors.js";
import { formatDate, formatDuration, formatTranscript, msToClock } from "./format.js";
import type { ActionItem, Meeting, MeetingSummary, SearchHit, TranscriptFormat } from "./types.js";
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
    `- **${m.title}** — \`${m.id}\``,
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
  return `- **${h.meeting_title}** (\`${h.meeting_id}\`, ${formatDate(h.started_at)}) — ${where}\n  ${h.snippet.replace(/\s+/g, " ").trim()}`;
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
    "Ask the Recordist app to (re)generate AI notes for a meeting. `kind` is summary, action_items, decisions, questions, followup_email or custom; `template_id` selects a template. Requires the app to be running.",
  readOnly: false,
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

export const startRecording = defineTool({
  name: "start_recording",
  title: "Start recording",
  description:
    "Start recording a meeting now via the Recordist app. Requires the app to be running and 'Allow agents to start recordings' turned on in Settings → Integrations.",
  readOnly: false,
  examples: ["Start recording this meeting", "Record a meeting called 'Design sync'"],
  inputShape: {
    title: z.string().optional().describe("Meeting title"),
    source_app: z.string().optional().describe("zoom | teams | meet | slack | webex | facetime | manual (default manual)"),
  },
  async run(data, args) {
    const res = await data.startRecording({ title: args.title, source_app: args.source_app ?? "manual" });
    return {
      text: `Recording started${res.meeting_id ? ` (meeting ${res.meeting_id})` : ""}${args.title ? `: ${args.title}` : ""}.`,
      data: { ...res },
    };
  },
});

export const stopRecording = defineTool({
  name: "stop_recording",
  title: "Stop recording",
  description: "Stop the current recording. Transcription and notes continue in the background. Requires the app to be running.",
  readOnly: false,
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
