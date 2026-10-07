import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { doctor, main, parseArgs } from "../src/cli.js";
import { createFixtureDb, type FixtureDb } from "./helpers/db.js";

describe("parseArgs", () => {
  it("defaults to stdio", () => {
    expect(parseArgs([])).toMatchObject({ stdio: true, http: false, a2a: false, httpPort: 47322, a2aPort: 47323 });
  });
  it("parses transports and ports", () => {
    expect(parseArgs(["--http", "--http-port", "5000"])).toMatchObject({ stdio: false, http: true, httpPort: 5000 });
    expect(parseArgs(["--a2a", "--a2a-port=6000"])).toMatchObject({ stdio: false, a2a: true, a2aPort: 6000 });
    expect(parseArgs(["--all"])).toMatchObject({ stdio: true, http: true, a2a: true });
    expect(parseArgs(["--doctor"])).toMatchObject({ doctor: true, stdio: false });
    expect(parseArgs(["--version"])).toMatchObject({ version: true, stdio: false });
  });
  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
  });
});

describe("doctor", () => {
  let fx: FixtureDb;
  beforeAll(() => { fx = createFixtureDb(); });
  afterAll(() => fx.cleanup());

  it("reports db, token and app reachability", async () => {
    const d = await doctor({
      dataDir: fx.dir,
      dbPath: fx.dbPath,
      tokenPath: `${fx.dir}/api_token`,
      apiUrl: "http://127.0.0.1:1",
      apiToken: null,
    });
    expect(d.ok).toBe(true);
    expect(d.text).toContain(`data dir:    ${fx.dir}`);
    expect(d.text).toMatch(/database: .*found — readable, FTS5 available, has meetings/);
    expect(d.text).toMatch(/api token: +missing/);
    expect(d.text).toMatch(/local api: .*unreachable/);
    expect(d.text).toContain("sqlite fallback");
    expect(d.text).toMatch(/http \/ a2a: +will not start — they require the api token/);
  });

  it("says --http and --a2a will require the token, and where it comes from", async () => {
    const saved = process.env.RECORDIST_API_TOKEN;
    const config = {
      dataDir: fx.dir,
      dbPath: fx.dbPath,
      tokenPath: `${fx.dir}/api_token`,
      apiUrl: "http://127.0.0.1:1",
      apiToken: "e".repeat(64),
    };
    try {
      delete process.env.RECORDIST_API_TOKEN;
      const fromFile = await doctor(config);
      expect(fromFile.ok).toBe(true);
      expect(fromFile.text).toContain(`http / a2a:  token required — callers must send "Authorization: Bearer <token>" with the token from ${fx.dir}/api_token`);
      expect(fromFile.text).not.toContain("e".repeat(64));

      process.env.RECORDIST_API_TOKEN = "e".repeat(64);
      const fromEnv = await doctor(config);
      expect(fromEnv.text).toMatch(/http \/ a2a: +token required — .*from RECORDIST_API_TOKEN/);
      expect(fromEnv.text).not.toContain("e".repeat(64));
    } finally {
      if (saved === undefined) delete process.env.RECORDIST_API_TOKEN; else process.env.RECORDIST_API_TOKEN = saved;
    }
  });
});

describe("main", () => {
  let fx: FixtureDb;
  beforeAll(() => { fx = createFixtureDb(); });
  afterAll(() => fx.cleanup());

  it("will not serve --http or --a2a without a token", async () => {
    const saved = { dir: process.env.RECORDIST_DATA_DIR, token: process.env.RECORDIST_API_TOKEN, exitCode: process.exitCode };
    process.env.RECORDIST_DATA_DIR = fx.dir;
    delete process.env.RECORDIST_API_TOKEN;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const flag of ["--http", "--a2a", "--all"]) {
        process.exitCode = undefined;
        await main([flag, "--http-port", "0", "--a2a-port", "0"]);
        expect(process.exitCode).toBe(1);
      }
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/need the API token/);
    } finally {
      stderr.mockRestore();
      process.exitCode = saved.exitCode;
      if (saved.dir === undefined) delete process.env.RECORDIST_DATA_DIR; else process.env.RECORDIST_DATA_DIR = saved.dir;
      if (saved.token !== undefined) process.env.RECORDIST_API_TOKEN = saved.token;
    }
  });

  it("still serves stdio without a token", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, RECORDIST_DATA_DIR: fx.dir, RECORDIST_API_URL: "http://127.0.0.1:1" };
    delete env.RECORDIST_API_TOKEN;
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    const listed = new Promise<any>((resolve, reject) => {
      child.stdout.on("data", (d) => {
        out += d;
        for (const line of out.split("\n")) {
          if (line.includes('"id":2')) resolve(JSON.parse(line));
        }
      });
      void exited.then((code) => reject(new Error(`exited ${code} before answering: ${err}`)));
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-test", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    try {
      const res = await listed;
      expect(res.result.tools.map((t: { name: string }) => t.name)).toContain("list_meetings");
      expect(err).not.toMatch(/need the API token/);
    } finally {
      child.stdin.end();
    }
    expect(await exited).toBe(0);
  });
});
