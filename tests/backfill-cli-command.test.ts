// `standup backfill run` — the command's own input builder
// (`src/lib/cli/commands-backfill.ts`).
//
// **Why this file exists.** The r06 review of PR #79 found that nothing
// under `tests/` imported `readPayloadFile` at all: it was reachable only
// through a full integration run, so every one of its refusals was
// unasserted. This is the direct test of that entry point.
//
// Pure — no database, no server. `readPayloadFile` reads a file and parses
// JSON, so the only I/O is a temporary file each case writes and removes.
// Every fixture is invented; this repository is public (CLAUDE.md).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKFILL_COMMANDS,
  BACKFILL_FILE_FLAG,
  readPayloadFile,
} from "@/lib/cli/commands-backfill";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "backfill-cli-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `contents` to a uniquely-named file in the temp dir and returns its path. */
function fileWith(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf-8");
  return path;
}

describe("readPayloadFile", () => {
  it("reads the payload from `--file`, spelled exactly that", () => {
    // Pinned as a literal, not through the constant. Every other case here
    // reads the flag through `BACKFILL_FILE_FLAG`, so renaming the constant
    // would move them all with it and none would notice — but the flag is
    // the documented user-facing spelling (BACKFILL.md's `standup backfill
    // run --file payload.json`), and the refusal message hardcodes `--file`
    // independently. A rename is a breaking change to a published command
    // and has to fail something.
    expect(BACKFILL_FILE_FLAG).toBe("file");

    const path = fileWith("literal-flag.json", JSON.stringify({ version: 1, tasks: [] }));
    const result = readPayloadFile({ file: path });

    expect(result.ok).toBe(true);
    expect(result.ok && result.input).toEqual({ payload: { version: 1, tasks: [] } });
  });

  it("reads the file and wraps the parsed JSON in the operation's `payload` key", () => {
    const path = fileWith(
      "ok.json",
      JSON.stringify({ version: 1, defaultArea: "imported", tasks: [] }),
    );

    const result = readPayloadFile({ [BACKFILL_FILE_FLAG]: path });

    expect(result.ok).toBe(true);
    // The wrapper is the contract with the operation, not decoration: the
    // schema takes `{ payload }`, so a bare parsed object would be refused.
    expect(result.ok && result.input).toEqual({
      payload: { version: 1, defaultArea: "imported", tasks: [] },
    });
  });

  it("refuses a missing --file flag, naming the flag", () => {
    const result = readPayloadFile({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.code).toBe("malformed_command");
    expect(result.envelope.error.message).toContain("--file");
    expect(result.envelope.error.fields).toEqual([BACKFILL_FILE_FLAG]);
  });

  it("refuses `--file` given as a bare flag with no value", () => {
    // `{ file: true }` is how the parser reports `--file` with nothing after
    // it. Distinct from the missing case above and refused for its own
    // reason, because `true` would otherwise reach `readFileSync` as a
    // non-string.
    const result = readPayloadFile({ [BACKFILL_FILE_FLAG]: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.message).toContain("needs a value");
    expect(result.envelope.error.fields).toEqual([BACKFILL_FILE_FLAG]);
  });

  it("refuses an unreadable file, naming the path it tried", () => {
    const path = join(dir, "does-not-exist.json");

    const result = readPayloadFile({ [BACKFILL_FILE_FLAG]: path });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.message).toContain("Could not read");
    expect(result.envelope.error.message).toContain(path);
  });

  it("refuses text that is not JSON, and says so rather than reporting a read failure", () => {
    // The two failures are deliberately different messages: "could not read"
    // sends somebody to check the path, "not valid JSON" sends them to the
    // contents. Asserting the message distinguishes them.
    const path = fileWith("garbage.json", "{not json");

    const result = readPayloadFile({ [BACKFILL_FILE_FLAG]: path });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.message).toContain("is not valid JSON");
    expect(result.envelope.error.message).toContain(path);
  });

  it("validates no field of the payload — that is the operation's schema's job", () => {
    // SCHEMA.md §22: every adapter parses the same schema through the same
    // call. A payload with a wrong version, no `tasks` and an unknown key is
    // accepted *here* and refused later by the operation. If this ever
    // starts failing, an adapter has grown a rejection no other adapter
    // gives.
    const path = fileWith("invalid-but-json.json", JSON.stringify({ version: 99, nonsense: true }));

    const result = readPayloadFile({ [BACKFILL_FILE_FLAG]: path });

    expect(result.ok).toBe(true);
    expect(result.ok && result.input).toEqual({ payload: { version: 99, nonsense: true } });
  });

  it("parses a JSON document that is not an object without unwrapping it", () => {
    // Same principle as above, at the one boundary most likely to tempt a
    // shortcut: the file holds a bare array. It is passed through as the
    // payload value for the schema to refuse, not coerced into an object.
    const path = fileWith("array.json", "[1, 2]");

    const result = readPayloadFile({ [BACKFILL_FILE_FLAG]: path });

    expect(result.ok).toBe(true);
    expect(result.ok && result.input).toEqual({ payload: [1, 2] });
  });
});

describe("BACKFILL_COMMANDS", () => {
  it("registers exactly `backfill run`, pointed at the `backfill` operation", () => {
    expect(BACKFILL_COMMANDS).toHaveLength(1);
    const [spec] = BACKFILL_COMMANDS;
    expect(spec?.noun).toBe("backfill");
    expect(spec?.verb).toBe("run");
    // The operation name is the string the service registry is keyed on; a
    // typo here is a command that dispatches to nothing.
    expect(spec?.operation).toBe("backfill");
  });

  it("tells a reader in its summary that the env gate must be open", () => {
    // The window is closed during normal operation, so the summary saying
    // so is what stops the first run being a confusing refusal.
    expect(BACKFILL_COMMANDS[0]?.summary).toContain("ENABLE_BACKFILL");
  });

  it("builds its input through readPayloadFile, ignoring the positional words", () => {
    const path = fileWith("via-spec.json", JSON.stringify({ version: 1, tasks: [] }));

    const result = BACKFILL_COMMANDS[0]?.buildInput(["ignored", "words"], {
      [BACKFILL_FILE_FLAG]: path,
    });

    expect(result?.ok).toBe(true);
    expect(result?.ok && result.input).toEqual({ payload: { version: 1, tasks: [] } });
  });

  it("propagates a refusal from readPayloadFile rather than swallowing it", () => {
    const result = BACKFILL_COMMANDS[0]?.buildInput([], {});

    expect(result?.ok).toBe(false);
    expect(result?.ok === false && result.envelope.error.fields).toEqual([BACKFILL_FILE_FLAG]);
  });
});
