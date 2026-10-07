/**
 * Bearer-token check for the MCP Streamable HTTP transport and the A2A agent.
 * The token is the app's api_token. Both sides are hashed first so
 * timingSafeEqual always compares equal-length buffers and the length of the
 * expected token never shows in the timing.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export function bearerAuth(token: string): (req: http.IncomingMessage) => boolean {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (trimmed.length === 0) throw new Error("A bearer token (the app's api_token) is required to serve over HTTP");
  const expected = digest(trimmed);
  return (req) => {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    return timingSafeEqual(digest(match[1]!.trim()), expected);
  };
}

export function sendUnauthorised(res: http.ServerResponse): void {
  const payload = JSON.stringify({ error: "unauthorised" });
  res.writeHead(401, {
    "WWW-Authenticate": "Bearer",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
