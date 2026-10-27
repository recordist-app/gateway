import { describe, expect, it } from "vitest";

import { actionStatus, proposeAction, startRecording, toProposedAction, TOOL_NAMES } from "../src/tools.js";
import { ApiError } from "../src/data/errors.js";
import type { RecordistData } from "../src/data/types.js";

/** A data layer that records what the tools send to the app and answers like it. */
function fake() {
  const sent: unknown[] = [];
  const data = {
    mode: "api",
    async proposeAction(opts: unknown) { sent.push(opts); return { id: "g1", status: "proposed" as const, expires_at: Date.UTC(2026, 9, 23, 15, 0) }; },
    async proposalStatus(id: string) { return id === "gone" ? null : { id, status: "declined" as const, decided_at: 1 }; },
  } as unknown as RecordistData;
  return { data, sent };
}

describe("Recordist Agent tools", () => {
  it("are listed, and propose_action is the only one that writes", () => {
    expect(TOOL_NAMES).toContain("propose_action");
    expect(TOOL_NAMES).toContain("action_status");
    expect(proposeAction.readOnly).toBe(false);
    expect(actionStatus.readOnly).toBe(true);
    // The description tells the assistant the truth: nothing runs on the call, the person approves in the app.
    expect(proposeAction.description).toMatch(/Nothing runs on this call/);
    expect(proposeAction.description).toMatch(/Approve or Not now/);
  });

  it("maps the flat arguments to the app's action and refuses a missing id before anything is sent", () => {
    expect(toProposedAction({ kind: "mark_promise_done", action_item_id: "a1" })).toEqual({ kind: "mark_promise_done", action_item_id: "a1" });
    expect(toProposedAction({ kind: "draft_followup", meeting_id: "m1" })).toEqual({ kind: "draft_followup", meeting_id: "m1" });
    expect(toProposedAction({ kind: "draft_followup", meeting_id: "m1", template_id: "sales" })).toEqual({ kind: "draft_followup", meeting_id: "m1", template_id: "sales" });
    expect(toProposedAction({ kind: "export_meeting", meeting_id: "m1", format: "json" })).toEqual({ kind: "export_meeting", meeting_id: "m1", format: "json" });
    expect(() => toProposedAction({ kind: "mark_promise_done" })).toThrow(/action_item_id/);
    expect(() => toProposedAction({ kind: "export_meeting" })).toThrow(/meeting_id/);
    expect(() => toProposedAction({ kind: "delete_meeting", meeting_id: "m1" })).toThrow(/Unknown action kind/);
  });

  it("sends the suggestion with its reason and says that nothing has run", async () => {
    const { data, sent } = fake();
    const r = await proposeAction.run(data, { kind: "mark_promise_done", action_item_id: "a1", reason: "It was done in the call.", via: "Claude Desktop" });
    expect(sent).toEqual([{ action: { kind: "mark_promise_done", action_item_id: "a1" }, reason: "It was done in the call.", via: "Claude Desktop" }]);
    expect(r.text).toMatch(/Nothing has run/);
    expect(r.text).toMatch(/Approve or Not now/);
    expect(r.data).toMatchObject({ id: "g1", status: "proposed" });
  });

  it("reports a status in plain words and a suggestion that is gone", async () => {
    const { data } = fake();
    expect((await actionStatus.run(data, { id: "g1" })).text).toBe("Suggestion g1 was declined (Not now).");
    expect((await actionStatus.run(data, { id: "gone" })).text).toBe("Suggestion gone is no longer in Recordist.");
  });
});

describe("start_recording: consent first", () => {
  const refused = new ApiError(403, "403", 'Agents cannot start a recording until "Allow agents to start recordings" is turned on in Settings → Integrations.');
  function app(over: { start?: () => Promise<unknown>; prompt?: (o: unknown) => Promise<{ prompt_id: string | null }> }) {
    const prompts: unknown[] = [];
    const data = {
      mode: "api",
      startRecording: over.start ?? (async () => ({ ok: true, meeting_id: "m1" })),
      async promptRecording(o: unknown) { prompts.push(o); return over.prompt ? over.prompt(o) : { prompt_id: "p1" }; },
    } as unknown as RecordistData;
    return { data, prompts };
  }

  it("starts at once when the person allowed agents to", async () => {
    const { data, prompts } = app({});
    const r = await startRecording.run(data, { title: "Design sync" });
    expect(r.text).toBe("Recording started (meeting m1): Design sync.");
    expect(r.data).toMatchObject({ started: true, meeting_id: "m1" });
    expect(prompts).toEqual([]);
  });

  it("with the safe default, raises Recordist's own card instead, and says nothing records until it is answered", async () => {
    const { data, prompts } = app({ start: async () => { throw refused; } });
    const r = await startRecording.run(data, { title: "Design sync", source_app: "zoom" });
    expect(prompts).toEqual([{ title: "Design sync", source_app: "manual" }]);
    expect(r.text).toBe("Recordist is showing its record card on the person's laptop. Nothing records until they answer it there.");
    expect(r.data).toEqual({ started: false, card_shown: true, prompt_id: "p1" });
  });

  it("says so when Recordist showed no card", async () => {
    const { data } = app({ start: async () => { throw refused; }, prompt: async () => ({ prompt_id: null }) });
    const r = await startRecording.run(data, {});
    expect(r.text).toMatch(/^Recordist did not show its record card/);
    expect(r.data).toEqual({ started: false, card_shown: false });
  });

  it("says why from the reason Recordist 1.0.5 gives, and keeps the reason in the data", async () => {
    const { data } = app({ start: async () => { throw refused; }, prompt: async () => ({ prompt_id: null, reason: "finishing" }) as { prompt_id: null } });
    const r = await startRecording.run(data, {});
    expect(r.text).toBe("Recordist did not show its record card because it is still writing up the last recording. The person can record again once that is done.");
    expect(r.data).toEqual({ started: false, card_shown: false, reason: "finishing" });
    const unknown = app({ start: async () => { throw refused; }, prompt: async () => ({ prompt_id: null, reason: "toString" }) as { prompt_id: null } });
    expect((await startRecording.run(unknown.data, {})).text).toMatch(/^Recordist did not show its record card: a recording may already be running/);
  });

  it("when the card is refused too, gives the start's own refusal and the way forward, never the card's internal words", async () => {
    const { data } = app({ start: async () => { throw refused; }, prompt: async () => { throw new ApiError(403, "403", "extension detection disabled in settings"); } });
    const err = await startRecording.run(data, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe(`${refused.message} Recordist did not show its record card either, so nothing records. The person can start the recording in Recordist.`);
    expect((err as ApiError).message).not.toMatch(/extension detection/);
  });

  it("passes on any other failure of the card as it is", async () => {
    const { data } = app({ start: async () => { throw refused; }, prompt: async () => { throw new ApiError(500, "500", "Recordist could not show its card."); } });
    await expect(startRecording.run(data, {})).rejects.toThrow("Recordist could not show its card.");
  });

  it("does not raise the card for any other failure", async () => {
    const { data, prompts } = app({ start: async () => { throw new ApiError(400, "400", "The microphone is not available."); } });
    await expect(startRecording.run(data, {})).rejects.toThrow("The microphone is not available.");
    expect(prompts).toEqual([]);
  });
});
