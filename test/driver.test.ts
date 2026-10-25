import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { AutoData } from "../src/data/auto.js";
import { openReadOnly } from "../src/data/driver.js";
import { SqliteReader } from "../src/data/sqlite.js";
import { createFixtureDb } from "./helpers/db.js";

describe("openReadOnly", () => {
  const fx = createFixtureDb({ fts: true });
  afterAll(() => fx.cleanup());

  it("prefers better-sqlite3 and reads the same rows through node:sqlite", () => {
    const a = openReadOnly(fx.dbPath);
    const b = openReadOnly(fx.dbPath, "node:sqlite");
    expect(a.driver).toBe("better-sqlite3");
    expect(b.driver).toBe("node:sqlite");
    const sql = "SELECT id, title FROM meetings ORDER BY started_at DESC";
    expect(b.prepare(sql).all().map((r) => ({ ...(r as object) }))).toEqual(a.prepare(sql).all());
    expect(b.prepare("SELECT 1 FROM meetings WHERE id = ?").get("missing")).toBeUndefined();
    a.close();
    b.close();
  });

  it("never writes: both drivers refuse an INSERT", () => {
    for (const driver of ["better-sqlite3", "node:sqlite"] as const) {
      const db = openReadOnly(fx.dbPath, driver);
      expect(() => db.prepare("INSERT INTO markers(id, meeting_id, at_ms, created_at) VALUES('x','y',0,0) RETURNING id").all()).toThrow(
        /readonly|read-only/i,
      );
      db.close();
    }
  });

  it("names each driver's reason when no driver can open the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "recordist-driver-"));
    try {
      expect(() => openReadOnly(path.join(dir, "missing.db"))).toThrow(
        /could not be opened read-only \(better-sqlite3: .+; node:sqlite: .+\)/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AutoData when the database cannot be opened", () => {
  it("says why instead of saying the file was not found", async () => {
    const data = new AutoData({
      api: null,
      openSqlite: () => new SqliteReader({ dbPath: "/nonexistent/recordist.db", driver: "node:sqlite" }),
    });
    await expect(data.listMeetings()).rejects.toThrow(/recordist\.db could not be opened read-only \(node:sqlite: /);
  });
});
