# Recordist

Recordist writes notes from your calls on your laptop, with no bot in the call.
This plugin lets Claude read that record: search every call, open a meeting's
notes and transcript, list the action items, and draft the follow-up from what
was said, quoting who said it and when.

## Install

In Claude Code:

```
/plugin install recordist --marketplace recordist-app/gateway
```

## What it runs

The plugin starts the open-source Recordist gateway, `@recordist/gateway`
version 0.1.7 from npm, with `npx`. Its source is in this repository,
https://github.com/recordist-app/gateway. The gateway is an MCP server that
talks only to the Recordist app on the same laptop, at `127.0.0.1`, with the
token the app keeps in its own data folder. When Recordist is closed, it reads
the app's database read-only.

It runs in Claude Code, and in Cowork sessions on the laptop where Recordist is
installed. It needs Node.js 20 or later, and Recordist opened there at least
once: https://recordist.app/download

## Use it

Ask, for example:

- What did I agree to in yesterday's calls?
- Draft the follow-up to my call with Dana, from what we said.
- When did we last talk about the renewal, and who raised it?

The skill `from-the-record` has Claude find the call, read it, and answer with
the speaker, the time and the words for each point.

The tools that read: `list_meetings`, `get_meeting`, `get_transcript`,
`search_meetings` and `get_action_items`. The tools that act, with Recordist
open: `regenerate_notes`, `start_recording`, `stop_recording` and `add_marker`.
`start_recording` works only after you turn on Allow agents to start recordings
in Recordist's Settings, Integrations. It is off until you do.

## Data

The record stays with you. The plugin and the gateway send nothing to
Recordist and have no telemetry. What a tool returns goes to Claude to answer
you. `regenerate_notes` asks Recordist to write notes with the provider you set
in Recordist, which may be a cloud service you chose. The gateway cannot rename
or delete a meeting.

Privacy policy: https://recordist.app/privacy
Support: https://recordist.app/support
Security reports: security@recordist.app

## License

MIT, in `LICENSE`.
