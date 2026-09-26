/**
 * Transcript formatting helpers: JSON → Markdown / SRT / WebVTT / plain text.
 */
import type { Segment, Transcript, TranscriptFormat } from "./types.js";

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

interface Clock {
  h: number;
  m: number;
  s: number;
  ms: number;
}

function splitMs(totalMs: number): Clock {
  const clamped = Math.max(0, Math.round(totalMs));
  const ms = clamped % 1000;
  const totalS = Math.floor(clamped / 1000);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  return { h, m, s, ms };
}

/** `HH:MM:SS,mmm` (SubRip). */
export function msToSrtTime(totalMs: number): string {
  const { h, m, s, ms } = splitMs(totalMs);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** `HH:MM:SS.mmm` (WebVTT). */
export function msToVttTime(totalMs: number): string {
  const { h, m, s, ms } = splitMs(totalMs);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/** `HH:MM:SS` (human readable). */
export function msToClock(totalMs: number): string {
  const { h, m, s } = splitMs(totalMs);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
}

/** Human duration such as `1h 02m` or `12m 05s`. */
export function formatDuration(totalMs: number | null | undefined): string {
  if (totalMs == null || !Number.isFinite(totalMs)) return "unknown";
  const { h, m, s } = splitMs(totalMs);
  if (h > 0) return `${h}h ${pad(m, 2)}m`;
  if (m > 0) return `${m}m ${pad(s, 2)}s`;
  return `${s}s`;
}

export function speakerLabel(seg: Segment): string {
  if (seg.speaker && seg.speaker.trim().length > 0) return seg.speaker.trim();
  return seg.channel === "mic" ? "You" : "Speaker";
}

function sorted(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => a.start_ms - b.start_ms);
}

export function transcriptToTxt(t: Transcript): string {
  return sorted(t.segments)
    .map((seg) => `[${msToClock(seg.start_ms)}] ${speakerLabel(seg)}: ${seg.text.trim()}`)
    .join("\n");
}

export function transcriptToMarkdown(t: Transcript, title?: string): string {
  const lines: string[] = [];
  lines.push(`# ${title ?? "Transcript"}`);
  lines.push("");
  if (title) {
    lines.push(`Meeting \`${t.meeting_id}\``);
    lines.push("");
  }
  for (const seg of sorted(t.segments)) {
    lines.push(`**[${msToClock(seg.start_ms)}] ${speakerLabel(seg)}:** ${seg.text.trim()}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function transcriptToSrt(t: Transcript): string {
  const blocks: string[] = [];
  let i = 1;
  for (const seg of sorted(t.segments)) {
    blocks.push(
      [
        String(i++),
        `${msToSrtTime(seg.start_ms)} --> ${msToSrtTime(seg.end_ms)}`,
        `${speakerLabel(seg)}: ${seg.text.trim()}`,
      ].join("\n"),
    );
  }
  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}

export function transcriptToVtt(t: Transcript): string {
  const lines: string[] = ["WEBVTT", ""];
  let i = 1;
  for (const seg of sorted(t.segments)) {
    lines.push(String(i++));
    lines.push(`${msToVttTime(seg.start_ms)} --> ${msToVttTime(seg.end_ms)}`);
    lines.push(`<v ${speakerLabel(seg)}>${seg.text.trim()}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatTranscript(
  t: Transcript,
  format: TranscriptFormat,
  opts: { title?: string } = {},
): string {
  switch (format) {
    case "json":
      return JSON.stringify(t, null, 2);
    case "md":
      return transcriptToMarkdown(t, opts.title);
    case "srt":
      return transcriptToSrt(t);
    case "vtt":
      return transcriptToVtt(t);
    case "txt":
      return transcriptToTxt(t);
    default: {
      const never: never = format;
      throw new Error(`Unknown transcript format: ${String(never)}`);
    }
  }
}

export function mimeForFormat(format: TranscriptFormat): string {
  switch (format) {
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "srt":
      return "application/x-subrip";
    case "vtt":
      return "text/vtt";
    case "txt":
      return "text/plain";
  }
}

/** ISO string in local time without milliseconds, e.g. 2025-09-02T14:30. */
export function formatDate(unixMs: number | null | undefined): string {
  if (unixMs == null) return "unknown";
  const d = new Date(unixMs);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
