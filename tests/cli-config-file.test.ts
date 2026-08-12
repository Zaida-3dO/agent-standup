// The local configuration file `standup init` writes and every command
// reads back (SCHEMA.md §20). Real filesystem operations against a scratch
// temp directory — no database needed, so unlike most of `standup init`
// this is fully exercised here rather than gated on TEST_DATABASE_URL.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFilePath, readConfigFile, writeConfigFile } from "@/lib/cli/config-file";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "standup-config-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("configFilePath", () => {
  it("honours STANDUP_CONFIG_FILE when set", () => {
    const explicit = join(dir, "custom.json");
    expect(configFilePath({ STANDUP_CONFIG_FILE: explicit })).toBe(explicit);
  });

  it("ignores a blank STANDUP_CONFIG_FILE, falling back to the default location", () => {
    const path = configFilePath({ STANDUP_CONFIG_FILE: "  ", HOME: dir });
    expect(path).not.toBe("  ");
    expect(path.endsWith(join("agent-standup", "config.json"))).toBe(true);
  });

  it("prefers XDG_CONFIG_HOME over ~/.config when both would apply", () => {
    const xdg = join(dir, "xdg");
    const path = configFilePath({ HOME: dir, XDG_CONFIG_HOME: xdg });
    expect(path).toBe(join(xdg, "agent-standup", "config.json"));
  });
});

describe("writeConfigFile / readConfigFile — the real round trip", () => {
  it("writes a databaseUrl and reads it back unchanged", () => {
    const path = join(dir, "config.json");
    writeConfigFile({ databaseUrl: "postgres://app:secret@localhost:5433/standup" }, path);
    expect(readConfigFile(path)).toEqual({
      databaseUrl: "postgres://app:secret@localhost:5433/standup",
    });
  });

  it("creates the parent directory if it doesn't exist yet", () => {
    const path = join(dir, "nested", "deeper", "config.json");
    expect(existsSync(path)).toBe(false);
    writeConfigFile({ databaseUrl: "postgres://x/y" }, path);
    expect(existsSync(path)).toBe(true);
  });

  it("merges a second write over the first, never dropping an untouched field", () => {
    const path = join(dir, "config.json");
    writeConfigFile({ databaseUrl: "postgres://first/db", actor: "user-a" }, path);
    writeConfigFile({ databaseUrl: "postgres://second/db" }, path);
    expect(readConfigFile(path)).toEqual({
      databaseUrl: "postgres://second/db",
      actor: "user-a",
    });
  });

  it("returns {} for a file that does not exist", () => {
    expect(readConfigFile(join(dir, "nope.json"))).toEqual({});
  });

  it("returns {} for a file that is not valid JSON, rather than throwing", () => {
    const path = join(dir, "config.json");
    writeConfigFile({ databaseUrl: "postgres://x/y" }, path);
    // Corrupt it directly on disk.
    writeFileSync(path, "{ not json", "utf-8");
    expect(() => readConfigFile(path)).not.toThrow();
    expect(readConfigFile(path)).toEqual({});
  });

  it("drops unknown keys and non-string values rather than trusting the file blindly", () => {
    const path = join(dir, "config.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ databaseUrl: "postgres://x/y", nonsense: 42, actor: null }),
      "utf-8",
    );
    expect(readConfigFile(path)).toEqual({ databaseUrl: "postgres://x/y" });
  });

  it("writes the file with owner-only permissions on POSIX", () => {
    if (process.platform === "win32") return; // Windows has no equivalent mode bit — documented in config-file.ts.
    const path = join(dir, "config.json");
    writeConfigFile({ databaseUrl: "postgres://x/y" }, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never writes a value verbatim without going through JSON — the file on disk actually contains the string", () => {
    // Not a tautology: this is what would catch a future "redact before
    // writing" mistake that silently broke the one command allowed to
    // persist the connection string at all.
    const path = join(dir, "config.json");
    writeConfigFile({ databaseUrl: "postgres://app:hunter2@localhost/standup" }, path);
    expect(readFileSync(path, "utf-8")).toContain("hunter2");
  });
});
