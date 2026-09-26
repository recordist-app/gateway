import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { defaultDataDir, loadConfig } from "../src/config.js";

describe("config", () => {
  it("resolves the OS data dir per contract", () => {
    expect(defaultDataDir("darwin", { HOME: "/Users/me" })).toBe("/Users/me/Library/Application Support/app.recordist.desktop");
    expect(defaultDataDir("linux", { HOME: "/home/me" })).toBe("/home/me/.local/share/app.recordist.desktop");
    expect(defaultDataDir("linux", { HOME: "/home/me", XDG_DATA_HOME: "/xdg" })).toBe("/xdg/app.recordist.desktop");
    expect(defaultDataDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" })).toBe(
      path.join("C:\\Users\\me\\AppData\\Roaming", "app.recordist.desktop"),
    );
  });

  it("honours env overrides and reads the token file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "recordist-cfg-"));
    try {
      writeFileSync(path.join(dir, "api_token"), "secret-token\n");
      const c = loadConfig({ RECORDIST_DATA_DIR: dir, RECORDIST_API_URL: "http://127.0.0.1:5555/" });
      expect(c.dataDir).toBe(dir);
      expect(c.dbPath).toBe(path.join(dir, "recordist.db"));
      expect(c.apiToken).toBe("secret-token");
      expect(c.apiUrl).toBe("http://127.0.0.1:5555");
      const c2 = loadConfig({ RECORDIST_DATA_DIR: dir, RECORDIST_API_TOKEN: "env-token" });
      expect(c2.apiToken).toBe("env-token");
      expect(c2.apiUrl).toBe("http://127.0.0.1:47321");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null token when nothing is present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "recordist-cfg-"));
    try {
      expect(loadConfig({ RECORDIST_DATA_DIR: dir }).apiToken).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
