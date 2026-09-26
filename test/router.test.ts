import { describe, expect, it } from "vitest";

import { routeIntent } from "../src/router.js";
import { IDS } from "./helpers/db.js";

const NOW = Date.UTC(2025, 8, 2, 12, 0, 0);

describe("routeIntent", () => {
  it.each([
    ["Stop recording", "stop_recording", {}],
    ["please end the recording now", "stop_recording", {}],
    ["Start recording", "start_recording", {}],
    ['Record a meeting called "Design sync" on zoom', "start_recording", { title: "Design sync", source_app: "zoom" }],
    ["Add a marker called pricing", "add_marker", { label: "pricing" }],
    ["bookmark this moment", "add_marker", {}],
    [`Regenerate the summary for ${IDS.weekly}`, "regenerate_notes", { kind: "summary", meeting_id: IDS.weekly }],
    [`redo the action items for meeting ${IDS.weekly}`, "regenerate_notes", { kind: "action_items", meeting_id: IDS.weekly }],
    ["What are my open action items?", "get_action_items", { open_only: true }],
    [`list the to-dos from ${IDS.design}`, "get_action_items", { meeting_id: IDS.design }],
    [`Get the transcript of ${IDS.weekly} as SRT`, "get_transcript", { meeting_id: IDS.weekly, format: "srt" }],
    [`plain text transcript for ${IDS.weekly}`, "get_transcript", { meeting_id: IDS.weekly, format: "txt" }],
    [`Show me meeting ${IDS.weekly}`, "get_meeting", { meeting_id: IDS.weekly }],
    [IDS.weekly, "get_meeting", { meeting_id: IDS.weekly }],
    ["List my meetings from this week", "list_meetings", { from: NOW - 7 * 86_400_000 }],
    ["show the last 5 meetings", "list_meetings", { limit: 5 }],
    ["what meetings did I have about pricing", "list_meetings", { q: "pricing" }],
    ['Search my meetings for "budget approval"', "search_meetings", { query: "budget approval" }],
    ["When did we talk about the Q4 roadmap?", "search_meetings", { query: "Q4 roadmap" }],
    ["", "list_meetings", { limit: 20 }],
  ])("%s → %s", (text, skill, args) => {
    const r = routeIntent(text, NOW);
    expect(r.skill).toBe(skill);
    expect(r.args).toEqual(args);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("uppercases ids and ignores lowercase ULIDs mixed in prose", () => {
    const r = routeIntent(`open ${IDS.weekly.toLowerCase()}`);
    expect(r).toMatchObject({ skill: "get_meeting", args: { meeting_id: IDS.weekly } });
  });
});
