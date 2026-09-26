/**
 * MCP server: tools, resources and prompts over any transport.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, GetPromptResult, PromptMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { RecordistData } from "./data/types.js";
import { errorMessage } from "./data/errors.js";
import { formatDate, formatDuration, formatTranscript } from "./format.js";
import { renderActionItem, renderMeeting, TOOLS } from "./tools.js";
import type { Meeting } from "./types.js";

export const RESOURCE_SCHEME = "recordist";
export const MEETING_URI_TEMPLATE = `${RESOURCE_SCHEME}://meeting/{id}`;
export const TRANSCRIPT_URI_TEMPLATE = `${RESOURCE_SCHEME}://meeting/{id}/transcript`;
export const RECENT_RESOURCE_LIMIT = 50;

/** Character budget for transcripts embedded in prompts. */
const PROMPT_TRANSCRIPT_BUDGET = 60_000;

export interface McpServerOptions {
  version?: string;
}

export function meetingUri(id: string): string {
  return `${RESOURCE_SCHEME}://meeting/${encodeURIComponent(id)}`;
}
export function transcriptUri(id: string): string {
  return `${meetingUri(id)}/transcript`;
}

function truncate(text: string, budget = PROMPT_TRANSCRIPT_BUDGET): string {
  if (text.length <= budget) return text;
  return text.slice(0, budget) + `\n\n[… transcript truncated at ${budget} characters …]`;
}

function userMessage(text: string): PromptMessage {
  return { role: "user", content: { type: "text", text } };
}

function firstVar(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return decodeURIComponent(v[0] ?? "");
  return decodeURIComponent(v ?? "");
}

async function meetingContext(data: RecordistData, id: string): Promise<{ meeting: Meeting; transcriptText: string }> {
  const [meeting, transcript] = await Promise.all([data.getMeeting(id), data.getTranscript(id)]);
  if (!meeting) throw new Error(`Meeting not found: ${id}`);
  const transcriptText = transcript && transcript.segments.length
    ? truncate(formatTranscript(transcript, "txt"))
    : "(no transcript available)";
  return { meeting, transcriptText };
}

export function createMcpServer(data: RecordistData, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "recordist", title: "Recordist", version: opts.version ?? "0.0.0" },
    {
      instructions:
        "Recordist is a local-first meeting recorder. Use list_meetings / search_meetings to find meetings, get_meeting for notes and action items, get_transcript for the full text. " +
        "Recording controls (start_recording, stop_recording, add_marker) and regenerate_notes need the Recordist desktop app to be running; reads also work offline from the local database. " +
        `Meetings are also exposed as resources: ${MEETING_URI_TEMPLATE} and ${TRANSCRIPT_URI_TEMPLATE}.`,
    },
  );

  // ---- tools --------------------------------------------------------------
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          idempotentHint: tool.readOnly,
          openWorldHint: false,
        },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await tool.run(data, (args ?? {}) as never);
          return {
            content: [{ type: "text", text: result.text }],
            structuredContent: result.data,
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: errorMessage(err) }],
          };
        }
      },
    );
  }

  // ---- resources ----------------------------------------------------------
  server.registerResource(
    "meeting",
    new ResourceTemplate(MEETING_URI_TEMPLATE, {
      list: async () => {
        const meetings = await data.listMeetings({ limit: RECENT_RESOURCE_LIMIT });
        return {
          resources: meetings.map((m) => ({
            uri: meetingUri(m.id),
            name: m.title,
            title: m.title,
            description: `${formatDate(m.started_at)} · ${formatDuration(m.duration_ms)} · ${m.source_app ?? "unknown"}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Meeting",
      description: "A meeting with its notes, action items and markers (JSON).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = firstVar(variables.id);
      const meeting = await data.getMeeting(id);
      if (!meeting) throw new Error(`Meeting not found: ${id}`);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(meeting, null, 2) }],
      };
    },
  );

  server.registerResource(
    "transcript",
    new ResourceTemplate(TRANSCRIPT_URI_TEMPLATE, { list: undefined }),
    {
      title: "Meeting transcript",
      description: "Full transcript of a meeting as Markdown with timestamps and speakers.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const id = firstVar(variables.id);
      const [meeting, transcript] = await Promise.all([data.getMeeting(id), data.getTranscript(id)]);
      if (!transcript) throw new Error(`Meeting not found: ${id}`);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: formatTranscript(transcript, "md", { title: meeting?.title }) }],
      };
    },
  );

  // ---- prompts ------------------------------------------------------------
  server.registerPrompt(
    "summarize_meeting",
    {
      title: "Summarize a meeting",
      description: "Produce a concise summary, decisions and action items from a meeting transcript.",
      argsSchema: { meeting_id: z.string().describe("Meeting id (ULID)") },
    },
    async ({ meeting_id }): Promise<GetPromptResult> => {
      const { meeting, transcriptText } = await meetingContext(data, meeting_id);
      return {
        description: `Summarize "${meeting.title}"`,
        messages: [
          userMessage(
            `Summarize the following meeting. Give: a 3–5 sentence summary, key decisions, open questions, and action items (owner + due date when stated). Be specific and cite timestamps where useful.\n\n` +
              `${renderMeeting(meeting)}\n\n## Transcript\n\n${transcriptText}`,
          ),
        ],
      };
    },
  );

  server.registerPrompt(
    "draft_followup_email",
    {
      title: "Draft a follow-up email",
      description: "Draft a follow-up email to attendees with recap, decisions and next steps.",
      argsSchema: {
        meeting_id: z.string().describe("Meeting id (ULID)"),
        tone: z.string().optional().describe("e.g. friendly, formal, brief (default friendly)"),
      },
    },
    async ({ meeting_id, tone }): Promise<GetPromptResult> => {
      const { meeting, transcriptText } = await meetingContext(data, meeting_id);
      const recipients = meeting.attendees.map((a) => a.name).join(", ") || "the attendees";
      return {
        description: `Follow-up email for "${meeting.title}"`,
        messages: [
          userMessage(
            `Draft a ${tone ?? "friendly"} follow-up email to ${recipients} after the meeting below. Include a subject line, a short recap, decisions, and a clear list of next steps with owners. Keep it under 250 words.\n\n` +
              `${renderMeeting(meeting)}\n\n## Transcript\n\n${transcriptText}`,
          ),
        ],
      };
    },
  );

  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly review",
      description: "Review the last 7 days of meetings: themes, decisions, and outstanding action items.",
      argsSchema: {},
    },
    async (): Promise<GetPromptResult> => {
      const now = Date.now();
      const from = now - 7 * 24 * 60 * 60 * 1000;
      const meetings = await data.listMeetings({ from, to: now, limit: 100 });
      const sections: string[] = [];
      for (const m of meetings) {
        const full = await data.getMeeting(m.id);
        if (!full) continue;
        const summary = full.notes.find((n) => n.kind === "summary")?.content_md;
        let body: string;
        if (summary) {
          body = summary.trim();
        } else {
          const t = await data.getTranscript(m.id);
          body = t && t.segments.length ? truncate(formatTranscript(t, "txt"), 8_000) : "(no notes or transcript)";
        }
        const open = full.action_items.filter((a) => !a.done);
        sections.push(
          `### ${full.title} — ${formatDate(full.started_at)} (\`${full.id}\`)\n\n${body}` +
            (open.length ? `\n\nOpen action items:\n${open.map(renderActionItem).join("\n")}` : ""),
        );
      }
      return {
        description: `Weekly review of ${meetings.length} meeting(s)`,
        messages: [
          userMessage(
            `Write a weekly review of my meetings from the last 7 days (${formatDate(from)} → ${formatDate(now)}). Cover: main themes, decisions made, outstanding action items grouped by owner, and anything that needs follow-up next week.\n\n` +
              (sections.length ? sections.join("\n\n---\n\n") : "No meetings were recorded in the last 7 days."),
          ),
        ],
      };
    },
  );

  return server;
}
