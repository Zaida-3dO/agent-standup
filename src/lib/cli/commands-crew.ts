// `standup crew wait` — the door SCHEMA.md §18 says this feature has to have
// (MILESTONES.md #64, DECISIONS.md §6).
//
// ── Why this command exists at all ─────────────────────────────────────
//
// The wait was built, proven and left without a caller. `waitForCrew`
// (`@/lib/crew/wait-core`) had both doors implemented and a full test suite,
// §18 said it was deliberately not an MCP tool "because only a shell call can
// be backgrounded", and then no shell call was ever written — so the two
// `crew.wait_*` settings on the Crew panel tuned code that nothing in the
// application could reach. This is the missing half.
//
// ── Why the command line, and not a tool ───────────────────────────────
//
// §18, verbatim: "**Not exposed as MCP:** `wait_for_crew`. It's `standup crew
// wait` (§20), because only a shell call can be backgrounded — and
// backgrounding is the whole point." A tool call occupies the session that
// made it, so an orchestrator waiting through one would be blocked for
// exactly the interval the wait was meant to free. A shell call can be put in
// the background, and the orchestrator reads its output when it is ready.
// The waiver recording that decision is in `@/lib/adapters/waivers`.
//
// This module is separate from `commands-ownership.ts` (which owns `crew
// name`) for the reason every other split here gives: rows add entries to the
// same table concurrently, so `commands.ts` takes one appended import and one
// appended spread rather than a rewrite.
import { malformed } from "./envelope";
import { numericFlag, stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/**
 * Builds `wait_for_crew`'s input.
 *
 * **`--since` is required, and is refused here rather than by the schema.**
 * The operation's schema requires it too, but a refusal from here names the
 * flag the person typed and says where to get a cursor — the schema can only
 * report a missing field called `since`, which is a less useful sentence for
 * someone who has never run this command before. §19's own note is the thing
 * worth telling them: `claim`, `orientation` and every wait hand back a
 * cursor, so a caller always has one.
 *
 * It is deliberately *not* defaulted to `0`. A wait that silently starts from
 * the beginning of the ledger returns instantly with ancient events, which
 * looks exactly like a working wait and is not one — the failure would be
 * discovered as "the wait never blocks", long after the cause.
 *
 * `--timeout` and `--limit` are converted to numbers because a flag is always
 * a string and both are `z.number()` in the schema. Refused here for the same
 * reason `session register` refuses `--hook-version`: the useful sentence
 * names the flag as typed.
 */
function buildWaitInput(_rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const since = stringFlag(flags, "since");
  if (!since.ok) return since;
  if (since.value === undefined) {
    return {
      ok: false,
      envelope: malformed(
        "`standup crew wait` needs --since, the cursor to wait from. `claim`, `orientation` and every wait hand one back.",
        ["since"],
      ),
    };
  }

  const timeout = numericFlag(flags, "timeout");
  if (!timeout.ok) return timeout;

  const limit = numericFlag(flags, "limit");
  if (!limit.ok) return limit;

  return {
    ok: true,
    input: {
      since: since.value,
      ...(timeout.value === undefined ? {} : { timeout: timeout.value }),
      ...(limit.value === undefined ? {} : { limit: limit.value }),
    },
  };
}

export const CREW_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "crew",
    verb: "wait",
    operation: "wait_for_crew",
    summary:
      "Wait for your crew to do something and print the events when they do, or nothing at the timeout. Background it (`standup crew wait --since <cursor> &`) and carry on — that is what this verb is for. --timeout is in seconds and is clamped to the configured maximum.",
    buildInput: buildWaitInput,
  },
]);
