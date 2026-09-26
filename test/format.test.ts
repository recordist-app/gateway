import { describe, expect, it } from "vitest";

import { formatDuration, formatTranscript, msToClock, msToSrtTime, msToVttTime } from "../src/format.js";
import type { Transcript } from "../src/types.js";

const t: Transcript = {
  meeting_id: "m",
  segments: [
    { speaker: "Ana", channel: "sys", start_ms: 2200, end_ms: 6500, text: "Second line" },
    { speaker: "You", channel: "mic", start_ms: 0, end_ms: 2100, text: "Hi all" },
    { speaker: null, channel: "sys", start_ms: 3_723_456, end_ms: 3_725_000, text: "  unnamed  " },
  ],
};

describe("timestamps", () => {
  it("formats SRT / VTT / clock", () => {
    expect(msToSrtTime(0)).toBe("00:00:00,000");
    expect(msToSrtTime(3_723_456)).toBe("01:02:03,456");
    expect(msToVttTime(3_723_456)).toBe("01:02:03.456");
    expect(msToClock(59_999)).toBe("00:00:59");
    expect(msToSrtTime(-5)).toBe("00:00:00,000");
  });
  it("formats durations", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(null)).toBe("unknown");
  });
});

describe("formatTranscript", () => {
  it("srt sorts by start and numbers cues", () => {
    const srt = formatTranscript(t, "srt");
    expect(srt).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:02,100",
        "You: Hi all",
        "",
        "2",
        "00:00:02,200 --> 00:00:06,500",
        "Ana: Second line",
        "",
        "3",
        "01:02:03,456 --> 01:02:05,000",
        "Speaker: unnamed",
        "",
      ].join("\n"),
    );
  });
  it("vtt has header and voice tags", () => {
    const vtt = formatTranscript(t, "vtt");
    expect(vtt.startsWith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.100\n<v You>Hi all\n")).toBe(true);
    expect(vtt).toContain("<v Ana>Second line");
  });
  it("txt and md carry speaker labels and HH:MM:SS", () => {
    expect(formatTranscript(t, "txt")).toBe("[00:00:00] You: Hi all\n[00:00:02] Ana: Second line\n[01:02:03] Speaker: unnamed");
    const md = formatTranscript(t, "md", { title: "Weekly" });
    expect(md).toContain("# Weekly");
    expect(md).toContain("**[00:00:02] Ana:** Second line");
  });
  it("json round-trips", () => {
    expect(JSON.parse(formatTranscript(t, "json"))).toEqual(t);
  });
});
