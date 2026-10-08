# @recordist/gateway

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/recordist-app/gateway) [![Glama score](https://glama.ai/mcp/servers/recordist-app/gateway/badges/score.svg)](https://glama.ai/mcp/servers/recordist-app/gateway)

MCP server + A2A agent for **Recordist**, the meeting notetaker that runs on your
own computer with no bot in the call. It lets Claude Desktop, Claude Code, Cursor
and other agents read and act on the meetings recorded on your machine.

Recordist itself is opening in small waves: ask for a place at
**https://recordist.app/early-access** (Mac with Apple silicon for now).

- **Reads** (list, get, transcript, search, action items) work whether or not the
  Recordist app is running: the gateway talks to the app's local API when it is
  up and falls back to opening `recordist.db` read-only when it is not.
- **Actions** (start and stop recording, add a marker, regenerate notes) need the
  app. When it is not running they fail with `Recordist app is not running`.
  `start_recording` also needs **Allow agents to start recordings** in Recordist's
  Settings → Integrations, which is off by default.
- **Where your meetings go.** The gateway itself talks only to the Recordist app on
  `127.0.0.1` and listens on loopback by default. What it returns goes to the AI
  assistant you connect, which may send it to its own cloud model.
  `regenerate_notes` has the app write notes with the provider set in Recordist's
  Settings → AI notes, which may also be a cloud service.

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

or, for the HTTP transport while `npx -y @recordist/gateway --http` is running (it needs
the app's API token, see [Authentication](#authentication)):

```bash
TOKEN="$(cat ~/Library/Application\ Support/app.recordist.desktop/api_token)"
claude mcp add --transport http recordist http://127.0.0.1:47322/mcp \
  --header "Authorization: Bearer $TOKEN"
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
npx -y @recordist/gateway --http          # http://127.0.0.1:47322/mcp
```

Send `Authorization: Bearer <api_token>` with every request.

### Authentication

The HTTP transport (`--http`) and the A2A agent (`--a2a`) answer only requests
that carry `Authorization: Bearer <api_token>`, where the token is the contents
of `<data>/api_token` (or `RECORDIST_API_TOKEN`), the same token the gateway
uses for the app's local API. A missing or wrong token gets `401` with
`WWW-Authenticate: Bearer` and nothing else. The one exception is the A2A Agent
Card, which stays public so clients can discover the scheme; it lists skills
only, never meetings. Neither mode starts when no token is available, and
neither does `--all`, stdio included: open Recordist once so it writes
`api_token`, or run with no flags for stdio alone. The stdio transport needs no
token, since only the assistant that launched it can talk to it. `--doctor` says
whether `--http` and `--a2a` will require the token or refuse to start.

## What the assistant gets

**Tools**

| Tool | Purpose |
|---|---|
| `list_meetings` | Recent meetings; optional `q`, `from`/`to`, `limit`/`offset` |
| `get_meeting` | One meeting with notes, action items and markers |
| `get_transcript` | Transcript as `json` \| `md` \| `srt` \| `vtt` \| `txt` |
| `search_meetings` | Full-text search across transcripts and notes (FTS5) |
| `get_action_items` | Action items, filter by `meeting_id` / `open_only` |
| `regenerate_notes` | Re-run AI notes (`summary`, `action_items`, `decisions`, …) with the provider set in Recordist; needs the app |
| `start_recording` | Start recording; needs the app and **Allow agents to start recordings** (Settings → Integrations, off by default) |
| `stop_recording` | Stop the current recording; needs the app |
| `add_marker` | Bookmark the current moment; needs the app |

**Resources**: `recordist://meeting/{id}` (JSON) and
`recordist://meeting/{id}/transcript` (Markdown). The resource list shows the
50 most recent meetings.

**Prompts**: `summarize_meeting`, `draft_followup_email`, `weekly_review`.

## A2A agent

```bash
npx -y @recordist/gateway --a2a           # http://127.0.0.1:47323/
```

Agent Card at `http://127.0.0.1:47323/.well-known/agent.json` (public, no
token; `authentication.schemes` is `["bearer"]`); skills mirror the tools above.
JSON-RPC 2.0 at `/` with `tasks/send`, `tasks/get`, `tasks/cancel` and
`tasks/sendSubscribe` (SSE); every JSON-RPC request needs
`Authorization: Bearer <api_token>`.

Natural-language tasks are routed to a skill with a small keyword router; every
completed task returns a **text** part and a **data** part with the structured
result. To skip the router, send a data part `{"skill": "...", "args": {...}}`.

```bash
TOKEN="$(cat ~/Library/Application\ Support/app.recordist.desktop/api_token)"

curl -s http://127.0.0.1:47323/ \
  -H "Authorization: Bearer $TOKEN" \
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
curl -s http://127.0.0.1:47323/ -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":2,"method":"tasks/send",
  "params":{"message":{"role":"user","parts":[
    {"type":"data","data":{"skill":"get_transcript","args":{"meeting_id":"01J…","format":"srt"}}}
  ]}}}'

# streaming
curl -N http://127.0.0.1:47323/ -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":3,"method":"tasks/sendSubscribe",
  "params":{"message":{"role":"user","parts":[{"type":"text","text":"list my meetings from today"}]}}}'
```

## CLI

```
npx -y @recordist/gateway                 MCP over stdio (default)
npx -y @recordist/gateway --http          MCP over Streamable HTTP on 127.0.0.1:47322/mcp (bearer token)
npx -y @recordist/gateway --a2a           A2A agent on 127.0.0.1:47323 (bearer token)
npx -y @recordist/gateway --all           stdio + --http + --a2a (exits if there is no token)
npx -y @recordist/gateway --doctor        diagnostics: data dir, DB, token, app reachability, HTTP/A2A auth
npx -y @recordist/gateway --version
  --http-port <n>  --a2a-port <n>  --host <addr>
```

Always run it with npx by its scoped name, `@recordist/gateway`. A global
install (`npm i -g @recordist/gateway`) puts the same command on your path as
`recordist-gateway`.

`--host` binds `--http` and `--a2a` to another address and exists for
containers. Do not expose it on a network interface: the token would cross the
network in plain HTTP.

Logs go to stderr; stdout is reserved for the stdio MCP transport.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `RECORDIST_DATA_DIR` | macOS `~/Library/Application Support/app.recordist.desktop`<br>Windows `%APPDATA%\app.recordist.desktop`<br>Linux `~/.local/share/app.recordist.desktop` | Where `recordist.db` and `api_token` live |
| `RECORDIST_API_URL` | `http://127.0.0.1:47321` | Local API base URL |
| `RECORDIST_API_TOKEN` | contents of `<data>/api_token` | Bearer token for the local API, and the token `--http` and `--a2a` require from callers |

## How backend selection works

On each call the gateway probes `GET /v1/health` (800 ms timeout, result cached
for 5 s). If the app answers, the call goes to the API. Otherwise reads open
`<data>/recordist.db` with `readonly: true` (the app's WAL is never written to)
and actions return `Recordist app is not running`. FTS5 (`segments_fts`) is used
for search when present, with a `LIKE` fallback otherwise.

## Security notes

- The gateway binds `127.0.0.1` by default. `--host` exists for containers; do
  not expose it on a network interface. The Streamable HTTP transport enables
  DNS-rebinding protection and only accepts its own Host (`127.0.0.1` or
  `localhost` by default). The A2A agent accepts only its own Host, no browser
  Origin unless allow-listed, and JSON-RPC POSTs only as `application/json`.
- The gateway itself talks only to the Recordist app on `127.0.0.1`. What it
  returns goes to the AI assistant you connect, which may send it to its own
  cloud model, so connect only an assistant you trust with your meetings.
- `--http` and `--a2a` require `Authorization: Bearer <api_token>` on every
  request (the A2A Agent Card excepted), compared in constant time, so other
  user accounts on the machine cannot read meetings through them. Programs
  running under your own account can read `api_token`, so the token does not
  separate them from you.
- The API token is read from `<data>/api_token`, which the app writes with
  mode `0600`. `--doctor` warns if the file is group/world readable. Never commit
  or share it; anyone with the token can control recording on your machine.
- The SQLite database is opened read-only; the gateway never modifies it.
- No telemetry. The gateway makes no network calls other than to the Recordist
  app's local API.

## Changes in 0.1.6

- The README and the package and plugin descriptions now say where meeting text
  goes. The gateway itself talks only to the Recordist app on `127.0.0.1` and
  listens on loopback by default. What it returns goes to the AI assistant you
  connect, which may send it to its own cloud model. Earlier versions said that
  nothing leaves your machine. That is true of the gateway alone, and a cloud
  assistant sends what it reads to its provider.
- The README says the gateway binds `127.0.0.1` by default and that `--host`
  is for containers, where it used to say the gateway only ever binds
  `127.0.0.1`.
- The Recordist app is described as available for Macs with Apple silicon,
  which is the only build published.
- `start_recording` names the setting as the app shows it: **Allow agents to
  start recordings**, in Settings → Integrations.
- Every command in the README and in `--help` uses the scoped name,
  `npx -y @recordist/gateway`.
- Source comments point to the public
  [local API reference](https://recordist.app/developers/local-api).
- Tools, transports and token checks are unchanged, so a 0.1.5 setup works as
  it is.

## Changes in 0.1.5

- `--http` and `--a2a` now require `Authorization: Bearer <api_token>` on every
  request; a missing or wrong token gets `401`. The A2A Agent Card stays public
  and now lists `authentication.schemes: ["bearer"]`. If you used either mode,
  add the header to your client (see [Authentication](#authentication)). The
  stdio transport is unchanged.
- `--http` and `--a2a` refuse to start when no token is available
  (`<data>/api_token` missing and `RECORDIST_API_TOKEN` unset). So does
  `--all`, and it exits before stdio starts, so an assistant that launches the
  gateway with `--all` gets nothing. Without a token, launch it with no flags
  (stdio only).
- Library: `createMcpHttpServer` and `createA2AServer` now take a required
  `token` option (the app's api_token) and throw when it is missing or blank.
  Pass `loadConfig().apiToken`, as in [Library use](#library-use).
- `--doctor` reports whether `--http` and `--a2a` will require the token or
  refuse to start, and where the token comes from.
- The MCP HTTP transport answers `400` to an unparsable request path instead of
  ending the process (the A2A agent already did since 0.1.3).

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
const server = createMcpServer(data);        // McpServer; attach any transport
```

The HTTP and A2A servers require a bearer token and throw without one:

```ts
import { createMcpHttpServer, createMcpServer, createRecordistData, listen, loadConfig } from "@recordist/gateway";

const config = loadConfig();                 // apiToken: <data>/api_token or RECORDIST_API_TOKEN
if (!config.apiToken) throw new Error("open Recordist once so it writes api_token");
const data = createRecordistData(config);
const http = createMcpHttpServer({
  createServer: () => createMcpServer(data),
  token: config.apiToken,                    // callers must send Authorization: Bearer <token>
});
await listen(http, 47322);
```

## About

The gateway is the small, open bridge between your AI assistant and the copy of
[Recordist](https://recordist.app) running on your own computer. It contains no
app code and no keys; it can only reach the local API on the machine it runs on.
Issues and questions: support@recordist.app. Security reports: security@recordist.app
(see SECURITY.md). Made by Recordist, a small independent studio in Ontario, Canada.
