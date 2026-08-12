// The local configuration file `standup init` writes to (SCHEMA.md §17.1,
// §20: "the connection string is read from the environment or written by
// `init` into that file with owner-only permissions, and is never printed
// by any command"). Nothing before row #80 reads a real file off disk —
// `resolveConfig`'s `file` tier (`src/lib/cli/config.ts`) has existed since
// row #79 but was always handed an empty object by `bin/standup.ts`, because
// nothing had written one yet. This module is both directions: reading it
// back on every command, and writing it once `init` has a working
// connection.
//
// **No database import here.** Reading and writing JSON off disk is not a
// database reach, so this file is not, and does not need to be, in the
// allowlist (CLAUDE.md, "Working in this repo").
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliEnvironment, CliFileConfig } from "./config";

const FILE_KEYS = ["standupUrl", "databaseUrl", "sessionId", "actor"] as const;

/**
 * Where the local configuration file lives.
 *
 * `STANDUP_CONFIG_FILE` is an escape hatch for tests and for a machine where
 * the default location is wrong for some reason — it is read directly off
 * `env` rather than added to `CliEnvironment`'s named fields, because that
 * interface already has an index signature for exactly this (`config.ts`:
 * "the real environment satisfies it directly"). Otherwise: `XDG_CONFIG_HOME`
 * if set, else `~/.config`, then `agent-standup/config.json` — the ordinary
 * convention for a per-machine CLI tool's own configuration, independent of
 * which directory a command happens to be run from.
 */
export function configFilePath(env: CliEnvironment = process.env): string {
  const override = env.STANDUP_CONFIG_FILE;
  if (override !== undefined && override.trim() !== "") return override;

  const xdg = env.XDG_CONFIG_HOME;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const base = xdg !== undefined && xdg.trim() !== "" ? xdg : join(home, ".config");
  return join(base, "agent-standup", "config.json");
}

/** Keeps only the four known fields, and only where they're actually strings — an untrusted file on disk is not a typed value yet. */
function sanitize(value: unknown): CliFileConfig {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of FILE_KEYS) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim() !== "") result[key] = raw;
  }
  return result;
}

/**
 * Reads the local configuration file, or `{}` for any reason it can't be
 * read — missing, unreadable, not valid JSON, or valid JSON that isn't an
 * object. A corrupt or absent file must never crash every other command;
 * `standup init` (and manually deleting the file) are always the way back.
 */
export function readConfigFile(path: string = configFilePath()): CliFileConfig {
  try {
    const raw = readFileSync(path, "utf-8");
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Merges `patch` over whatever is already on disk (never dropping a field
 * `init` did not touch, e.g. an `actor` some other command set) and writes
 * the result with owner-only permissions.
 *
 * `mode: 0o600` is honoured on POSIX; Windows has no equivalent permission
 * bit and largely ignores it (it can still clear the read-only attribute,
 * nothing more) — stated here rather than silently assumed, because "owner
 * -only" is a promise this function keeps fully on Linux/macOS and only
 * partially on Windows.
 */
export function writeConfigFile(
  patch: Partial<CliFileConfig>,
  path: string = configFilePath(),
): CliFileConfig {
  const merged: CliFileConfig = { ...readConfigFile(path), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}
