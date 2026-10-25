/**
 * Opens recordist.db read-only with a SQLite driver this Node can load.
 *
 *  1. `better-sqlite3`, the npm dependency, when its native binary matches the Node that runs the gateway.
 *  2. `node:sqlite`, built into Node 22.13 and later. Claude Desktop runs extensions with the Node it ships, and a
 *     native binary built for another Node does not load there, so the Claude Desktop Extension relies on this one
 *     and carries no native code.
 *
 * Both open the file with SQLite's read-only flag: the app's database and its WAL are never written.
 */
import { createRequire } from "node:module";

export type SqliteDriver = "better-sqlite3" | "node:sqlite";

export interface ReadOnlyStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface ReadOnlyDb {
  readonly driver: SqliteDriver;
  prepare(sql: string): ReadOnlyStatement;
  close(): void;
}

const require = createRequire(import.meta.url);

function openBetterSqlite(dbPath: string): ReadOnlyDb {
  const Database = require("better-sqlite3") as new (
    file: string,
    opts: { readonly: boolean; fileMustExist: boolean },
  ) => { prepare(sql: string): ReadOnlyStatement; close(): void };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return { driver: "better-sqlite3", prepare: (sql) => db.prepare(sql), close: () => db.close() };
}

function openNodeSqlite(dbPath: string): ReadOnlyDb {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      file: string,
      opts: { readOnly: boolean },
    ) => { prepare(sql: string): ReadOnlyStatement; close(): void };
  };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return { driver: "node:sqlite", prepare: (sql) => db.prepare(sql), close: () => db.close() };
}

const OPENERS: Record<SqliteDriver, (dbPath: string) => ReadOnlyDb> = {
  "better-sqlite3": openBetterSqlite,
  "node:sqlite": openNodeSqlite,
};

/**
 * Open `dbPath` read-only. With `driver`, only that driver is tried; otherwise better-sqlite3 first, then
 * node:sqlite. Throws one error naming why each driver could not open the file.
 */
export function openReadOnly(dbPath: string, driver?: SqliteDriver): ReadOnlyDb {
  const order: SqliteDriver[] = driver ? [driver] : ["better-sqlite3", "node:sqlite"];
  const reasons: string[] = [];
  for (const name of order) {
    try {
      return OPENERS[name](dbPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      reasons.push(`${name}: ${msg}`);
    }
  }
  throw new Error(`could not be opened read-only (${reasons.join("; ")})`);
}
