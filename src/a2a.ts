/**
 * A2A agent: Agent Card + JSON-RPC 2.0 task endpoint (tasks/send, tasks/get,
 * tasks/cancel, tasks/sendSubscribe over SSE). Dependency-free (node:http).
 */
import { randomUUID } from "node:crypto";
import http from "node:http";

import { DEFAULT_A2A_PORT } from "./config.js";
import type { RecordistData } from "./data/types.js";
import { errorMessage } from "./data/errors.js";
import { readJsonBody, sendJson } from "./http.js";
import { routeIntent } from "./router.js";
import { findTool, runTool, TOOLS, type ToolResult } from "./tools.js";

// ---- A2A types (subset) ------------------------------------------------------

export type TaskState = "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed";

export interface TextPart { type: "text"; text: string; metadata?: Record<string, unknown> }
export interface DataPart { type: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> }
export type Part = TextPart | DataPart | { type: string; [k: string]: unknown };

export interface A2AMessage {
  role: "user" | "agent";
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export interface TaskStatus { state: TaskState; message?: A2AMessage; timestamp: string }

export interface Artifact {
  name?: string;
  description?: string;
  parts: Part[];
  index: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  sessionId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  provider?: { organization: string; url?: string };
  documentationUrl?: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  authentication?: { schemes: string[] };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

// ---- JSON-RPC errors --------------------------------------------------------

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}
const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupportedOperation: -32004,
} as const;

// ---- agent card ----------------------------------------------------------------

export function buildAgentCard(opts: { url: string; version: string }): AgentCard {
  return {
    name: "Recordist",
    description:
      "Local-first meeting companion. Lists, searches and reads meetings, transcripts, notes and action items recorded on this machine, and can control recording when the Recordist desktop app is running.",
    url: opts.url,
    version: opts.version,
    provider: { organization: "Recordist" },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    authentication: { schemes: [] },
    defaultInputModes: ["text", "data"],
    defaultOutputModes: ["text", "data"],
    skills: TOOLS.map((t) => ({
      id: t.name,
      name: t.title,
      description: t.description,
      tags: ["meetings", t.readOnly ? "read" : "action"],
      examples: t.examples,
      inputModes: ["text", "data"],
      outputModes: ["text", "data"],
    })),
  };
}

// ---- task execution --------------------------------------------------------------

export interface TaskOutcome {
  skill: string;
  args: Record<string, unknown>;
  result: ToolResult;
}

function textOf(message: A2AMessage): string {
  return message.parts
    .filter((p): p is TextPart => p.type === "text" && typeof (p as TextPart).text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** A data part `{skill|tool, args|arguments|input}` bypasses the NL router. */
function explicitCall(message: A2AMessage): { skill: string; args: Record<string, unknown> } | undefined {
  for (const p of message.parts) {
    if (p.type !== "data") continue;
    const d = (p as DataPart).data;
    if (!d || typeof d !== "object") continue;
    const skill = (d.skill ?? d.tool ?? d.name) as unknown;
    if (typeof skill === "string" && findTool(skill)) {
      const args = (d.args ?? d.arguments ?? d.input ?? {}) as Record<string, unknown>;
      return { skill, args: typeof args === "object" && args ? args : {} };
    }
  }
  return undefined;
}

export async function executeMessage(data: RecordistData, message: A2AMessage): Promise<TaskOutcome> {
  const explicit = explicitCall(message);
  const text = textOf(message);
  let skill: string;
  let args: Record<string, unknown>;
  if (explicit) {
    ({ skill, args } = explicit);
  } else {
    const routed = routeIntent(text);
    skill = routed.skill;
    args = routed.args;
  }
  const result = await runTool(data, skill, args);
  return { skill, args, result };
}

function outcomeParts(o: TaskOutcome): Part[] {
  return [
    { type: "text", text: o.result.text },
    { type: "data", data: { skill: o.skill, args: o.args, ...o.result.data } },
  ];
}

// ---- server ----------------------------------------------------------------------

export interface A2AServerOptions {
  data: RecordistData;
  version: string;
  port?: number;
  host?: string;
  /** Origins (scheme://host:port) allowed to call from a browser context; none by default. */
  allowedOrigins?: string[];
  log?: (msg: string) => void;
  /** Max tasks kept in memory (oldest evicted). */
  maxTasks?: number;
}

interface SendParams {
  id?: string;
  sessionId?: string;
  message: A2AMessage;
  metadata?: Record<string, unknown>;
  historyLength?: number;
}

export class A2AAgent {
  readonly tasks = new Map<string, Task>();
  private readonly data: RecordistData;
  private readonly maxTasks: number;

  constructor(data: RecordistData, maxTasks = 500) {
    this.data = data;
    this.maxTasks = maxTasks;
  }

  private remember(task: Task): void {
    this.tasks.set(task.id, task);
    while (this.tasks.size > this.maxTasks) {
      const oldest = this.tasks.keys().next().value;
      if (oldest === undefined) break;
      this.tasks.delete(oldest);
    }
  }

  private parseSend(params: unknown): SendParams {
    const p = params as Partial<SendParams> | undefined;
    if (!p || typeof p !== "object" || !p.message || !Array.isArray(p.message.parts)) {
      throw new JsonRpcError(ERR.invalidParams, "params.message.parts is required");
    }
    return { ...p, message: p.message, id: p.id ?? randomUUID() };
  }

  /** Run a task to completion; `onEvent` receives incremental updates (for SSE). */
  async send(
    params: unknown,
    onEvent?: (ev: { kind: "status"; task: Task; final: boolean } | { kind: "artifact"; task: Task; artifact: Artifact }) => void,
  ): Promise<Task> {
    const p = this.parseSend(params);
    const existing = this.tasks.get(p.id!);
    const history = [...(existing?.history ?? []), p.message];
    const task: Task = {
      id: p.id!,
      sessionId: p.sessionId ?? existing?.sessionId ?? randomUUID(),
      status: { state: "working", timestamp: new Date().toISOString() },
      artifacts: [],
      history,
      metadata: p.metadata,
    };
    this.remember(task);
    onEvent?.({ kind: "status", task, final: false });

    try {
      const outcome = await executeMessage(this.data, p.message);
      const parts = outcomeParts(outcome);
      const artifact: Artifact = { name: outcome.skill, index: 0, lastChunk: true, parts };
      task.artifacts = [artifact];
      onEvent?.({ kind: "artifact", task, artifact });
      const reply: A2AMessage = { role: "agent", parts };
      task.history = [...history, reply];
      task.status = { state: "completed", message: reply, timestamp: new Date().toISOString() };
    } catch (err) {
      const reply: A2AMessage = {
        role: "agent",
        parts: [
          { type: "text", text: errorMessage(err) },
          { type: "data", data: { error: errorMessage(err) } },
        ],
      };
      task.history = [...history, reply];
      task.status = { state: "failed", message: reply, timestamp: new Date().toISOString() };
    }
    onEvent?.({ kind: "status", task, final: true });
    return this.view(task, p.historyLength);
  }

  get(params: unknown): Task {
    const p = params as { id?: string; historyLength?: number } | undefined;
    if (!p?.id) throw new JsonRpcError(ERR.invalidParams, "params.id is required");
    const task = this.tasks.get(p.id);
    if (!task) throw new JsonRpcError(ERR.taskNotFound, "Task not found", { id: p.id });
    return this.view(task, p.historyLength);
  }

  cancel(params: unknown): Task {
    const p = params as { id?: string } | undefined;
    if (!p?.id) throw new JsonRpcError(ERR.invalidParams, "params.id is required");
    const task = this.tasks.get(p.id);
    if (!task) throw new JsonRpcError(ERR.taskNotFound, "Task not found", { id: p.id });
    if (task.status.state === "completed" || task.status.state === "failed" || task.status.state === "canceled") {
      throw new JsonRpcError(ERR.taskNotCancelable, `Task cannot be canceled in state ${task.status.state}`, { id: p.id });
    }
    task.status = { state: "canceled", timestamp: new Date().toISOString() };
    return this.view(task);
  }

  private view(task: Task, historyLength?: number): Task {
    const history = historyLength == null ? task.history : task.history?.slice(-Math.max(0, historyLength));
    return { ...task, history };
  }
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: unknown, err: unknown) {
  if (err instanceof JsonRpcError) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
  }
  return { jsonrpc: "2.0", id: id ?? null, error: { code: ERR.internal, message: errorMessage(err) } };
}

export function createA2AServer(opts: A2AServerOptions): http.Server {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? DEFAULT_A2A_PORT;
  const log = opts.log ?? (() => undefined);
  const agent = new A2AAgent(opts.data, opts.maxTasks);
  const card = buildAgentCard({ url: `http://${host}:${port}/`, version: opts.version });

  const server = http.createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", `http://${host}:${port}`); } catch { sendJson(res, 400, { error: { code: "bad_request", message: "Unparsable request path" } }); return; }

    // Browser-side protection. A web page can send a simple cross-origin POST (text/plain) to a
    // loopback port, and a DNS-rebinding page can read responses when the Host is not checked.
    // Same three rules as the MCP transport: Host must be ours, an Origin must be allow-listed,
    // and a JSON-RPC POST must say it is JSON.
    const addr = server.address();
    const bound = typeof addr === "object" && addr ? addr.port : port;
    const hostOk = [host, "localhost", "127.0.0.1", `${host}:${bound}`, `localhost:${bound}`, `127.0.0.1:${bound}`, `[::1]:${bound}`, "[::1]"];
    const reqHost = (req.headers.host ?? "").toLowerCase();
    if (!hostOk.includes(reqHost)) {
      sendJson(res, 403, { error: { code: "forbidden", message: `Host ${reqHost || "(none)"} is not this server` } });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const allowedOrigins = opts.allowedOrigins ?? [];
      if (!allowedOrigins.includes(origin)) {
        sendJson(res, 403, { error: { code: "forbidden", message: "Origin not allowed" } });
        return;
      }
    }
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, { error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/.well-known/agent.json" || url.pathname === "/.well-known/agent-card.json")) {
      sendJson(res, 200, card);
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, { ok: true, name: card.name, version: card.version, agentCard: "/.well-known/agent.json", jsonrpc: "/" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/") {
      sendJson(res, 404, { error: { code: "not_found", message: "POST JSON-RPC to / or GET /.well-known/agent.json" } });
      return;
    }

    let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown } | undefined;
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      sendJson(res, 400, rpcError(null, new JsonRpcError(ERR.parse, `Parse error: ${errorMessage(err)}`)));
      return;
    }
    if (!body || typeof body !== "object" || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      sendJson(res, 400, rpcError(body?.id, new JsonRpcError(ERR.invalidRequest, "Invalid JSON-RPC 2.0 request")));
      return;
    }
    const { id, method, params } = body;
    log(`${method} ${JSON.stringify(params ?? {}).slice(0, 200)}`);

    try {
      switch (method) {
        case "tasks/send": {
          const task = await agent.send(params);
          sendJson(res, 200, rpcResult(id, task));
          return;
        }
        case "tasks/get":
          sendJson(res, 200, rpcResult(id, agent.get(params)));
          return;
        case "tasks/cancel":
          sendJson(res, 200, rpcResult(id, agent.cancel(params)));
          return;
        case "tasks/sendSubscribe":
        case "tasks/resubscribe": {
          if (method === "tasks/resubscribe") {
            // No long-running tasks: replay the final state once.
            const task = agent.get(params);
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            res.write(`data: ${JSON.stringify(rpcResult(id, { id: task.id, status: task.status, final: true }))}\n\n`);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
          try {
            await agent.send(params, (ev) => {
              if (ev.kind === "status") {
                write(rpcResult(id, { id: ev.task.id, status: ev.task.status, final: ev.final }));
              } else {
                write(rpcResult(id, { id: ev.task.id, artifact: ev.artifact }));
              }
            });
          } catch (err) {
            write(rpcError(id, err));
          }
          res.end();
          return;
        }
        case "tasks/pushNotification/set":
        case "tasks/pushNotification/get":
          throw new JsonRpcError(ERR.unsupportedOperation, "Push notifications are not supported");
        default:
          throw new JsonRpcError(ERR.methodNotFound, `Method not found: ${method}`);
      }
    } catch (err) {
      const status = err instanceof JsonRpcError && err.code === ERR.methodNotFound ? 404 : 200;
      sendJson(res, status, rpcError(id, err));
    }
  });
  return server;
}
