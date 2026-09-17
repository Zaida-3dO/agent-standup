// The flag plumbing every command module shares.
//
// `GLOBAL_FLAGS` had six identical copies and `passThroughFlags` four, all
// written separately and all having drifted into being the same. A fix to one
// had to be remembered in every other, and the set of flags the dispatcher
// owns is not a per-module opinion — it is one fact about the command line.
//
// The sibling `args.ts` holds the parsers for a SINGLE flag (`stringFlag`,
// `booleanFlag`, `numericFlag`). This holds the rules that apply to the flag
// set AS A WHOLE: which names the dispatcher keeps for itself, and how the
// rest reach an operation.
import { malformed, type ErrorEnvelope } from "./envelope";
import { stringFlag, type ParsedArgs } from "./args";

/**
 * The flags the dispatcher handles itself — never part of an operation's
 * input.
 *
 * These are the words that say HOW to run a command rather than WHAT to run
 * it on: which binding to use, which session and actor to attribute it to,
 * how to render the answer. An operation never declares a field for any of
 * them, so forwarding one would be refused by a `.strict()` schema as an
 * unknown field — naming a flag the person legitimately typed.
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "json",
  "direct",
  "as",
  "session",
  "url",
  "help",
]);

/** What collecting flags into an operation input produced. */
export type FieldsResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/**
 * Collects the value-carrying flags into an operation input.
 *
 * ⚠️ **PASS-THROUGH BY DEFAULT, AND IT MUST STAY THAT WAY.**
 *
 * This forwards EVERY flag that is not global and not already consumed,
 * untouched, and the operation's own `.strict()` schema does the refusing. A
 * builder calling this may enumerate **positionals and bare switches only**.
 * Neither this function nor any builder above it may carry an **allow-list of
 * value-flag names**.
 *
 * Why an allow-list is the dangerous shape, specifically: a builder that
 * filtered to a list of fields it knew about would **silently drop** any flag
 * missing from that list. The dropped field is valid on the shared schema, so
 * nothing ever refuses it — the call is parsed, the value is discarded, and
 * the caller is answered with a success. That is a defect this codebase has
 * shipped once already: a `--reason` on a close was accepted and thrown away.
 *
 * It also means a refusal-shaped test cannot catch it. The regression tests
 * for this write a value and read it back through a separate call, because
 * that is the only assertion that can tell "kept" from "accepted and
 * discarded" — see `tests/cli-loop-noun-fields.test.ts`.
 *
 * `consumed` names the bare switches a verb has already read with
 * `booleanFlag`. They are skipped rather than left to fall through, because
 * this function refuses a valueless flag outright and passing one through
 * would send it to the operation twice under two spellings. Passing the names
 * here rather than pre-stripping the flag object keeps "which flags did this
 * command handle?" readable in the command entry.
 */
export function passThroughFlags(
  flags: ParsedArgs["flags"],
  consumed: readonly string[] = [],
): FieldsResult {
  const input: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(name)) continue;
    if (consumed.includes(name)) continue;
    if (value === true) {
      return { ok: false, envelope: malformed(`--${name} needs a value.`, [name]) };
    }
    input[name] = value;
  }
  return { ok: true, input };
}

/**
 * Maps the global `--session` flag onto an operation's own optional
 * `sessionId` field.
 *
 * `--session` is the one global flag that is also a field on many operations:
 * it says who is calling, and a session-scoped operation records that. It is
 * still global — the dispatcher reads it for attribution regardless — so it
 * is excluded from `passThroughFlags` and added back here, under the name the
 * schema uses, by the verbs that take it.
 */
export function withSessionId(
  input: Record<string, unknown>,
  flags: ParsedArgs["flags"],
): FieldsResult {
  const session = stringFlag(flags, "session");
  if (!session.ok) return session;
  if (session.value === undefined) return { ok: true, input };
  return { ok: true, input: { ...input, sessionId: session.value } };
}

/**
 * Reads the leading item-id positional a verb requires, naming it when it is
 * absent.
 *
 * `usage` is the command as a person would type it, so the refusal shows the
 * shape rather than describing it.
 */
export function itemIdPositional(
  rest: readonly string[],
  usage: string,
): { ok: true; itemId: string } | { ok: false; envelope: ErrorEnvelope } {
  const itemId = rest[0];
  if (itemId === undefined) {
    return { ok: false, envelope: malformed(`\`standup ${usage}\` needs an item id.`, ["itemId"]) };
  }
  return { ok: true, itemId };
}
