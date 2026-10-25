---
name: from-the-record
description: Answer questions about the user's past calls from the record Recordist keeps, and draft follow-ups from what was said. Use when the Recordist tools are connected and the user asks what was said, decided or agreed on a call, when something was discussed, what their action items are, or for a follow-up email after a call.
---

# From the record

Recordist keeps the record of the user's calls on their laptop: transcripts with speakers and times, notes, and action items. Answer from that record, and show where each answer comes from.

1. **Find the call.** Use `search_meetings` for a topic, a name or a phrase, and `list_meetings` with `from` and `to` for "yesterday" or "this week". If more than one call fits, name them and ask which one.
2. **Read before answering.** `get_meeting` gives the notes and action items. `get_transcript` with `format` set to `md` gives the words. Read the transcript whenever the user asks what someone said or agreed to.
3. **Quote.** For each point, give the speaker, the time in the call, and their words in quotation marks. When the record does not cover something, say so plainly. Never fill a gap with a guess.
4. **Action items.** `get_action_items` with `open_only` lists what is still open. Keep each owner as the record has it.
5. **Follow-up email.** Build it only from the notes, the action items and quoted lines. Give each commitment with its owner and date as they were said. Leave it as a draft for the user to send.

`start_recording`, `stop_recording` and `add_marker` act on the user's laptop. Use them only when the user asks for it in this conversation. `start_recording` works only after the user turns on Allow agents to start recordings in Recordist's Settings, Integrations; if it is refused, tell them where the setting is and leave the choice to them. When a recording starts, remind the user that the people on the call may need to be told.

If the Recordist tools are not available here, explain that they run on the laptop where Recordist is installed, in Claude Code or in a Cowork session on that laptop, and that Recordist needs to have been opened there once.
