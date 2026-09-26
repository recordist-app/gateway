import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { doctor, parseArgs } from "../src/cli.js";
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
  });
});
