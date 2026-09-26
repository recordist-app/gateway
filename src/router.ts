/**
 * Tiny intent router for A2A: natural-language task text → gateway tool + args.
 * Deliberately simple (regex / keyword based) and fully deterministic.
 */
import { TRANSCRIPT_FORMATS, type TranscriptFormat } from "./types.js";

export interface RoutedIntent {
  skill: string;
  args: Record<string, unknown>;
  /** 0–1, how sure the router is. */
  confidence: number;
}

const ULID_RE = /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/i;
const QUOTED_RE = /["“”']([^"“”']{1,200})["“”']/;

const DAY_MS = 24 * 60 * 60 * 1000;

function quoted(text: string): string | undefined {
  const m = QUOTED_RE.exec(text);
  return m?.[1]?.trim() || undefined;
}

function meetingId(text: string): string | undefined {
  const m = ULID_RE.exec(text);
  return m?.[0]?.toUpperCase();
}

function firstNumber(text: string): number | undefined {
  const m = /\b(\d{1,3})\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

function timeWindow(text: string, now: number): { from?: number } {
  const t = text.toLowerCase();
  if (/\btoday\b/.test(t)) return { from: new Date(now).setHours(0, 0, 0, 0) };
  if (/\byesterday\b/.test(t)) return { from: new Date(now - DAY_MS).setHours(0, 0, 0, 0) };
  if (/\b(this|past|last)\s+week\b|\blast\s+7\s+days\b/.test(t)) return { from: now - 7 * DAY_MS };
  if (/\b(this|past|last)\s+month\b|\blast\s+30\s+days\b/.test(t)) return { from: now - 30 * DAY_MS };
  const n = /\blast\s+(\d{1,3})\s+days?\b/.exec(t);
  if (n) return { from: now - Number(n[1]) * DAY_MS };
  return {};
}

function transcriptFormat(text: string): TranscriptFormat | undefined {
  const t = text.toLowerCase();
  if (/\bsrt\b|subtitle/.test(t)) return "srt";
  if (/\b(web)?vtt\b/.test(t)) return "vtt";
  if (/\bjson\b/.test(t)) return "json";
  if (/\b(plain[- ]?text|txt)\b/.test(t)) return "txt";
  if (/\b(markdown|md)\b/.test(t)) return "md";
  return undefined;
}

/** Strip filler so the remainder can be used as a search query. */
function searchTerms(text: string): string {
  const q = quoted(text);
  if (q) return q;
  return text
    .replace(ULID_RE, " ")
    .replace(
      /\b(please|can you|could you|would you|search|find|look( up)?|for|in|my|the|all|meetings?|transcripts?|notes?|where|when|did|we|i|talk(ed)?|discuss(ed)?|mention(ed|s)?|about|of|show|me|any|what|was|said|regarding|on)\b/gi,
      " ",
    )
    .replace(/[?.!,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function routeIntent(input: string, now: number = Date.now()): RoutedIntent {
  const text = (input ?? "").trim();
  const t = text.toLowerCase();
  const id = meetingId(text);

  if (text.length === 0) return { skill: "list_meetings", args: { limit: 20 }, confidence: 0.3 };

  // --- recording controls ---------------------------------------------------
  if (/\b(stop|end|finish)\b.*\brecord(ing)?\b|\bstop\b.*\bmeeting\b/.test(t)) {
    return { skill: "stop_recording", args: {}, confidence: 0.95 };
  }
  if (/\b(start|begin)\b.*\brecord(ing)?\b|\brecord\b.*\b(this|a|the|new)\b.*\bmeeting\b|^record\b/.test(t)) {
    const title = quoted(text) ?? /\b(?:called|titled|named)\s+(.+)$/i.exec(text)?.[1]?.trim();
    const args: Record<string, unknown> = {};
    if (title) args.title = title;
    const app = /\b(zoom|teams|meet|slack|webex|facetime)\b/.exec(t)?.[1];
    if (app) args.source_app = app;
    return { skill: "start_recording", args, confidence: 0.9 };
  }
  if (/\b(marker|bookmark|flag this|mark this)\b/.test(t)) {
    const label =
      quoted(text) ??
      /\b(?:marker|bookmark)\s+(?:called|named|labell?ed|for)?\s*[:\-]?\s*(.+)$/i.exec(text)?.[1]?.trim();
    const args: Record<string, unknown> = {};
    if (label && !/^(now|here|this|this moment)$/i.test(label)) args.label = label;
    return { skill: "add_marker", args, confidence: 0.9 };
  }

  // --- regenerate notes -----------------------------------------------------
  if (/\b(regenerate|re-?generate|redo|rewrite|re-?run|refresh)\b.*\b(notes?|summary|summar|action items|decisions|questions|email)\b/.test(t)) {
    const kind = /\baction items?\b/.test(t)
      ? "action_items"
      : /\bdecisions?\b/.test(t)
        ? "decisions"
        : /\bquestions?\b/.test(t)
          ? "questions"
          : /\b(follow-?up )?e-?mail\b/.test(t)
            ? "followup_email"
            : "summary";
    const args: Record<string, unknown> = { kind };
    if (id) args.meeting_id = id;
    return { skill: "regenerate_notes", args, confidence: id ? 0.9 : 0.6 };
  }

  // --- action items ---------------------------------------------------------
  if (/\b(action items?|to-?dos?|todo|tasks?|follow-?ups?|next steps)\b/.test(t)) {
    const args: Record<string, unknown> = {};
    if (id) args.meeting_id = id;
    if (/\b(open|pending|outstanding|incomplete|unfinished|not done|remaining)\b/.test(t)) args.open_only = true;
    return { skill: "get_action_items", args, confidence: 0.85 };
  }

  // --- transcript -----------------------------------------------------------
  if (/\btranscripts?\b|\bsubtitles?\b|\bsrt\b|\bvtt\b/.test(t)) {
    const args: Record<string, unknown> = {};
    if (id) args.meeting_id = id;
    const fmt = transcriptFormat(text);
    if (fmt && TRANSCRIPT_FORMATS.includes(fmt)) args.format = fmt;
    return { skill: "get_transcript", args, confidence: id ? 0.9 : 0.5 };
  }

  // --- single meeting by id -------------------------------------------------
  if (id && /\b(get|show|open|details?|about|summary|summar|notes?|what|decided|happened)\b/.test(t)) {
    return { skill: "get_meeting", args: { meeting_id: id }, confidence: 0.9 };
  }
  if (id && t.replace(ULID_RE, "").trim().length < 12) {
    return { skill: "get_meeting", args: { meeting_id: id }, confidence: 0.8 };
  }

  // --- list -----------------------------------------------------------------
  if (/\b(list|recent|latest|last|show|what)\b.*\bmeetings?\b|\bmeetings?\b.*\b(today|yesterday|this week|last week|this month)\b|^meetings?$/.test(t)) {
    const args: Record<string, unknown> = { ...timeWindow(text, now) };
    const n = /\b(?:last|latest|recent|top)\s+(\d{1,3})\b/.exec(t);
    if (n) args.limit = Number(n[1]);
    else if (/\b(last|latest|most recent)\s+meeting\b/.test(t)) args.limit = 1;
    const q = quoted(text) ?? /\b(?:about|mentioning|regarding|on)\s+(.+?)(?:\s+(?:this|last|past)\s+\w+)?[?.]?$/i.exec(text)?.[1];
    if (q && !/^(today|yesterday|this week|last week|this month)$/i.test(q.trim())) args.q = q.trim();
    return { skill: "list_meetings", args, confidence: 0.8 };
  }

  // --- search (default for anything with content) ---------------------------
  const query = searchTerms(text);
  if (query.length > 0) {
    const args: Record<string, unknown> = { query };
    const n = firstNumber(t);
    if (n && /\b(top|first|limit)\b/.test(t)) args.limit = n;
    return { skill: "search_meetings", args, confidence: /\b(search|find|where|when|mention)/.test(t) ? 0.8 : 0.5 };
  }
  return { skill: "list_meetings", args: { limit: 20 }, confidence: 0.3 };
}
