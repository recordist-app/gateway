# @recordist/gateway

MCP server + A2A agent for **Recordist**, the meeting notetaker that runs on your
own computer with no bot in the call and no upload. It lets Claude Desktop, Claude
Code, Cursor and other agents read and act on the meetings recorded on your machine.

Recordist itself is opening in small waves: ask for a place at
**https://recordist.app/early-access** (Mac today; Windows and Linux in early access).

- **Reads** (list, get, transcript, search, action items) work whether or not the
  Recordist app is running: the gateway talks to the app's local API when it is
  up and falls back to opening `recordist.db` read-only when it is not.
- **Actions** (start/stop recording, add marker, regenerate notes) need the app.
  When it is not running they fail with `Recordist app is not running`.
- Everything is loopback-only. Nothing leaves your machine.

## Install

```bash
npx -y @recordist/gateway --doctor     # check data dir, DB, token, app
```

Requires Node 20+. `better-sqlite3` ships prebuilt binaries for common platforms.

## Connect an assistant

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "recordist": {
      "command": "npx",
      "args": ["-y", "@recordist/gateway"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add recordist -- npx -y @recordist/gateway
```

or, for the HTTP transport while `recordist-gateway --http` is running:

```bash
claude mcp add --transport http recordist http://127.0.0.1:47322/mcp
```

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "recordist": {
      "command": "npx",
      "args": ["-y", "@recordist/gateway"]
    }
  }
}
```

### Any Streamable HTTP client

```bash
recordist-gateway --http          # http://127.0.0.1:47322/mcp
```

## What the assistant gets

**Tools**

| Tool | Purpose |
|---|---|
| `list_meetings` | Recent meetings; optional `q`, `from`/`to`, `limit`/`offset` |
| `get_meeting` | One meeting with notes, action items and markers |
| `get_transcript` | Transcript as `json` \| `md` \| `srt` \| `vtt` \| `txt` |
| `search_meetings` | Full-text search across transcripts and notes (FTS5) |
| `get_action_items` | Action items, filter by `meeting_id` / `open_only` |
| `regenerate_notes` | Re-run AI notes (`summary`, `action_items`, `decisions`, …) — needs the app |
| `start_recording` | Start recording — needs the app + "allow remote start" setting |
| `stop_recording` | Stop the current recording — needs the app |
| `add_marker` | Bookmark the current moment — needs the app |

**Resources**: `recordist://meeting/{id}` (JSON) and
`recordist://meeting/{id}/transcript` (Markdown). The resource list shows the
50 most recent meetings.

**Prompts**: `summarize_meeting`, `draft_followup_email`, `weekly_review`.

## A2A agent

```bash
recordist-gateway --a2a           # http://127.0.0.1:47323/
```

Agent Card at `http://127.0.0.1:47323/.well-known/agent.json`; skills mirror
the tools above. JSON-RPC 2.0 at `/` with `tasks/send`, `tasks/get`,
`tasks/cancel` and `tasks/sendSubscribe` (SSE).

Natural-language tasks are routed to a skill with a small keyword router; every
completed task returns a **text** part and a **data** part with the structured
result. To skip the router, send a data part `{"skill": "...", "args": {...}}`.

```bash
curl -s http://127.0.0.1:47323/ \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "tasks/send",
    "params": {
      "id": "task-1",
      "message": { "role": "user", "parts": [
        { "type": "text", "text": "What are my open action items from this week?" }
      ]}
    }
  }' | jq .result.artifacts[0].parts

# explicit skill call
curl -s http://127.0.0.1:47323/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":2,"method":"tasks/send",
  "params":{"message":{"role":"user","parts":[
    {"type":"data","data":{"skill":"get_transcript","args":{"meeting_id":"01J…","format":"srt"}}}
  ]}}}'

# streaming
curl -N http://127.0.0.1:47323/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":3,"method":"tasks/sendSubscribe",
  "params":{"message":{"role":"user","parts":[{"type":"text","text":"list my meetings from today"}]}}}'
```

## CLI

```
recordist-gateway                 MCP over stdio (default)
recordist-gateway --http          MCP over Streamable HTTP on 127.0.0.1:47322/mcp
recordist-gateway --a2a           A2A agent on 127.0.0.1:47323
recordist-gateway --all           stdio + --http + --a2a
recordist-gateway --doctor        diagnostics: data dir, DB, token, app reachability
recordist-gateway --version
  --http-port <n>  --a2a-port <n>  --host <addr>
```

Logs go to stderr; stdout is reserved for the stdio MCP transport.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `RECORDIST_DATA_DIR` | macOS `~/Library/Application Support/app.recordist.desktop`<br>Windows `%APPDATA%\app.recordist.desktop`<br>Linux `~/.local/share/app.recordist.desktop` | Where `recordist.db` and `api_token` live |
| `RECORDIST_API_URL` | `http://127.0.0.1:47321` | Local API base URL |
| `RECORDIST_API_TOKEN` | contents of `<data>/api_token` | Bearer token for the local API |

## How backend selection works

On each call the gateway probes `GET /v1/health` (800 ms timeout, result cached
for 5 s). If the app answers, the call goes to the API. Otherwise reads open
`<data>/recordist.db` with `readonly: true` (the app's WAL is never written to)
and actions return `Recordist app is not running`. FTS5 (`segments_fts`) is used
for search when present, with a `LIKE` fallback otherwise.

## Security notes

- The gateway only ever binds `127.0.0.1` (`--host` exists for containers; do
  not expose it on a network interface). The Streamable HTTP transport enables
  DNS-rebinding protection and only accepts `Host: 127.0.0.1` / `localhost`.
- The API token is read from `<data>/api_token`, which the app writes with
  mode `0600`. `--doctor` warns if the file is group/world readable. Never commit
  or share it; anyone with the token can control recording on your machine.
- The SQLite database is opened read-only; the gateway never modifies it.
- No telemetry, no outbound network calls.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest
node dist/cli.js --doctor
```

## Library use

```ts
import { createRecordistData, createMcpServer } from "@recordist/gateway";

const data = createRecordistData();          // API with SQLite fallback
const server = createMcpServer(data);        // McpServer — attach any transport
```

## About

The gateway is the small, open bridge between your AI assistant and the copy of
[Recordist](https://recordist.app) running on your own computer. It contains no
app code and no keys; it can only reach the local API on the machine it runs on.
Issues and questions: support@recordist.app. Security reports: security@recordist.app
(see SECURITY.md). Made by Recordist, a small independent studio in Ontario, Canada.
