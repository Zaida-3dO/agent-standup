// The `standup backfill` command (docs/plans/BACKFILL.md).
//
// Its own module, appended to `./commands.ts`'s table as a single spread —
// the same arrangement the admin, ownership and config rows use, so
// concurrent work adding entries elsewhere never conflicts with this one.
//
// The payload arrives as a **file path**, not as a flag value. A backfill
// payload is the whole of somebody's existing backlog; passing it as an
// argument would run into every shell's command-length limit and, on the
// way there, put the entire thing into shell history. Reading a file is the
// only shape that works at the size this is for.
import { readFileSync } from "node:fs";
import type { CommandSpec, InputResult } from "./commands";
import { malformed } from "./envelope";

/** The flag naming the payload file. A long name, because this is not a command anyone types often. */
export const BACKFILL_FILE_FLAG = "file";

/**
 * Reads and parses the payload file.
 *
 * Refuses only what it can tell is wrong without the schema — a missing
 * flag, an unreadable file, text that is not JSON at all. **It validates no
 * field**: the operation's own schema is the single place a payload is
 * checked (SCHEMA.md §22, "every adapter parses the same schema through the
 * same call"), so re-checking here would produce a rejection this adapter
 * could give and no other one would.
 */
export function readPayloadFile(flags: Record<string, string | true>): InputResult {
  const file = flags[BACKFILL_FILE_FLAG];
  if (file === undefined) {
    return {
      ok: false,
      envelope: malformed("`standup backfill run` needs --file <payload.json>.", [
        BACKFILL_FILE_FLAG,
      ]),
    };
  }
  if (file === true) {
    return {
      ok: false,
      envelope: malformed(`--${BACKFILL_FILE_FLAG} needs a value.`, [BACKFILL_FILE_FLAG]),
    };
  }

  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return {
      ok: false,
      envelope: malformed(`Could not read ${file}.`, [BACKFILL_FILE_FLAG]),
    };
  }

  try {
    return { ok: true, input: { payload: JSON.parse(text) } };
  } catch {
    return {
      ok: false,
      envelope: malformed(`${file} is not valid JSON.`, [BACKFILL_FILE_FLAG]),
    };
  }
}

export const BACKFILL_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "backfill",
    verb: "run",
    operation: "backfill",
    summary: "Bulk-load an existing body of work from a payload file. Needs ENABLE_BACKFILL=true.",
    buildInput: (_rest, flags) => readPayloadFile(flags),
  },
]);
