/**
 * @recordist/gateway — public library surface.
 */
export * from "./types.js";
export * from "./config.js";
export * from "./format.js";
export * from "./data/index.js";
export { createMcpServer, MEETING_URI_TEMPLATE, TRANSCRIPT_URI_TEMPLATE, RESOURCE_SCHEME, meetingUri, transcriptUri } from "./mcp.js";
export { createMcpHttpServer, listen } from "./http.js";
export { createA2AServer, A2AAgent, buildAgentCard, executeMessage, JsonRpcError } from "./a2a.js";
export type { AgentCard, AgentSkill, Task, TaskStatus, TaskState, Artifact, A2AMessage, Part } from "./a2a.js";
export { routeIntent, type RoutedIntent } from "./router.js";
export { TOOLS, TOOL_NAMES, findTool, runTool, parseWhen, type ToolDef, type ToolResult } from "./tools.js";
export { packageVersion } from "./version.js";
