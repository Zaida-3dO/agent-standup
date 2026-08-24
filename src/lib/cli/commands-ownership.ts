// Row #82's own commands: ownership (claim, release, heartbeat, checkpoint,
// my-work), item-scoped reads (note, orientation) and crew naming (SCHEMA.md
// §20). A separate module from `commands.ts` on purpose — several rows
// (#80, #81, #83, #89, #92) add their own commands to the same table
// concurrently on their own branches, and `commands.ts`'s own header already
// states the shape every row after #79 follows: "they add entries here...
// without touching either binding." This file is the "entries" for this
// row; `commands.ts` gets a single appended import and a single appended
// spread, never a rewrite of its existing lines.
//
// **Noun choice.** SCHEMA.md §20 lists nine nouns, and after `item`
// (owned by #79/#81) and `config`/`repo`/`area`/`machine`/`account`/`person`
// (owned by #83/#92), only `session` and `crew` are left unclaimed —
// exactly the two this row needs. The split between them, and between
// `session` and `item` for `note`, follows each operation's own schema:
// `claim`, `release`, `heartbeat`, `checkpoint` and `my_work` all require
// `sessionId` (SCHEMA.md #29's operations, `my-work.ts`), so they are
// `session <verb>`. `note` and `orientation` do not require a session at
// all — `note`'s `sessionId` is optional (a person's remark needs none) and
// `orientation`'s input has no session field whatsoever — so they are
// `item <verb>`, alongside the item verbs #79/#81 already register there.
// `crew name` follows `standup crew wait`'s own precedent (SCHEMA.md §20,
// MILESTONES.md #64) for the one noun left.
//
// **Flags pass straight through to the operation's schema**, the same
// convention `item create` already established in `commands.ts`
// (`flagsToInput`): a flag becomes an input field of the identical name, and
// an unrecognised or mistyped one is refused by the operation's own
// `.strict()` schema with `invalid_input`, not silently dropped here. That
// import is not reachable from this file (`flagsToInput` is module-private
// to `commands.ts`, deliberately not exported so this file cannot be forced
// to touch that file's internals) so `passThroughFlags` below is the same
// behaviour, defined once for every command in this file.
import { malformed, type ErrorEnvelope } from "./envelope";
import { booleanFlag, numericFlag, stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/** The flags every command in this build's dispatcher handles itself, never part of an operation's input. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

/** An in-progress input object being built up, as opposed to `InputResult`'s final `unknown`. */
type FieldsResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/**
 * Same behaviour as `commands.ts`'s own `flagsToInput` — see this file's
 * header for why it is a second copy.
 *
 * `consumed` names the flags a caller has already read itself, which is what
 * lets a bare switch exist at all: this function refuses a valueless flag
 * outright, so a switch has to be read by `booleanFlag` first and then
 * declared here, or it arrives at the operation twice under two spellings.
 * `commands.ts` takes the same list for the same reason.
 */
function passThroughFlags(
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

/** Reads the positional item id, or refuses with the field name every one of these operations' schemas use for it. */
function itemIdPositional(
  rest: readonly string[],
  usage: string,
): { ok: true; itemId: string } | { ok: false; envelope: ErrorEnvelope } {
  const itemId = rest[0];
  if (itemId === undefined) {
    return { ok: false, envelope: malformed(`\`standup ${usage}\` needs an item id.`, ["itemId"]) };
  }
  return { ok: true, itemId };
}

/** `--session` maps onto the operation's own `sessionId` field — dropped by `passThroughFlags` (it's global) and re-added here where the operation's schema calls for it. */
function withSessionId(input: Record<string, unknown>, flags: ParsedArgs["flags"]): FieldsResult {
  const session = stringFlag(flags, "session");
  if (!session.ok) return session;
  return {
    ok: true,
    input: session.value === undefined ? input : { ...input, sessionId: session.value },
  };
}

function buildClaimInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "session claim <item-id>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;

  const input: Record<string, unknown> = { ...withSession.input, itemId: idResult.itemId };
  // `pid` is the one numeric field `claim`'s schema declares
  // (`z.number().int().nullable().optional()`) — every other field here is
  // a string all the way through, so this is the one spot a CLI flag
  // (always a string) needs a type coercion rather than a straight
  // pass-through. It goes through the shared `numericFlag` so the CLI has
  // one spelling of "this flag is a number" rather than a per-command one.
  const pid = numericFlag(flags, "pid");
  if (!pid.ok) return pid;
  if (pid.value !== undefined) input.pid = pid.value;
  return { ok: true, input };
}

/** `release` and `heartbeat` share exactly one shape: `{ itemId, sessionId }`, nothing else. */
function buildItemSessionInput(usage: string) {
  return (rest: readonly string[], flags: ParsedArgs["flags"]): InputResult => {
    const idResult = itemIdPositional(rest, usage);
    if (!idResult.ok) return idResult;
    const passthrough = passThroughFlags(flags);
    if (!passthrough.ok) return passthrough;
    const withSession = withSessionId(passthrough.input, flags);
    if (!withSession.ok) return withSession;
    return { ok: true, input: { ...withSession.input, itemId: idResult.itemId } };
  };
}

function buildCheckpointInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "session checkpoint <item-id>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;
  return { ok: true, input: { ...withSession.input, itemId: idResult.itemId } };
}

/**
 * `session takeover <item-id> --fromSessionId … --bySessionId … --holderType … --holderId … [--force] [--reason …]`.
 *
 * `--force` is the one boolean flag in this file, and it needs the same kind
 * of pre-handling the numeric `pid` coercion in `buildClaimInput` needs, for
 * the mirror-image reason: `passThroughFlags` refuses a valueless flag
 * ("--force needs a value"), which for a boolean is exactly backwards —
 * a bare `--force` is the *correct* way to write it. So it is read with
 * `booleanFlag` before the pass-through sees it, which also refuses
 * `--force yes` as "does not take a value" rather than forwarding a string to
 * a `z.boolean()` that would then complain about a type the caller never
 * meant to supply.
 */
function buildTakeoverInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "session takeover <item-id>");
  if (!idResult.ok) return idResult;

  const force = booleanFlag(flags, "force");
  if (!force.ok) return force;

  // `force` is withheld from the pass-through (it has already been read as a
  // boolean) rather than destructured out, so there is no unused binding.
  const others = Object.fromEntries(
    Object.entries(flags).filter(([name]) => name !== "force"),
  ) as ParsedArgs["flags"];
  const passthrough = passThroughFlags(others);
  if (!passthrough.ok) return passthrough;

  const input: Record<string, unknown> = { ...passthrough.input, itemId: idResult.itemId };
  // Sent only when actually given. `takeover`'s schema declares `force` as
  // optional, and a call that never mentioned it should not be recorded as
  // having explicitly declined to force.
  if (flags.force !== undefined) input.force = force.value;
  return { ok: true, input };
}

function buildSweepInput(_rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  // `sweep`'s schema is `z.object({}).strict()` — it takes nothing. A stray
  // flag is therefore passed through and refused by that schema as
  // `invalid_input` with the offending field named, rather than dropped here
  // where the caller would never learn its flag did nothing.
  return passThroughFlags(flags);
}

function buildMyWorkInput(_rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  return withSessionId(passthrough.input, flags);
}

/**
 * `progress_report` takes the same session flag `my_work` does — the
 * difference between the two is what the server does with the session, not
 * how a caller names it.
 *
 * `--include-completed` is a bare switch, because that is what a switch looks
 * like here and `--include-completed true` is not a thing anyone would type.
 * It therefore cannot go through `passThroughFlags`, which refuses a
 * valueless flag: it is read by `booleanFlag` and declared consumed, exactly
 * as `--all` and `--full` are on `item list`.
 */
function buildProgressReportInput(
  _rest: readonly string[],
  flags: ParsedArgs["flags"],
): InputResult {
  const includeCompleted = booleanFlag(flags, "include-completed");
  if (!includeCompleted.ok) return includeCompleted;
  const passthrough = passThroughFlags(flags, ["include-completed"]);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;
  return {
    ok: true,
    input: { ...withSession.input, includeCompleted: includeCompleted.value },
  };
}

function buildNoteInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item note <item-id>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  // `note`'s own `sessionId` is optional (SCHEMA.md §7 — a person's remark
  // holds none), unlike claim/release/heartbeat/checkpoint's required one —
  // but the mapping from `--session` is identical either way.
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;
  return { ok: true, input: { ...withSession.input, itemId: idResult.itemId } };
}

function buildOrientationInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item orientation <item-id>");
  if (!idResult.ok) return idResult;
  // `--limit` names a `z.number()` field, so it converts here and is
  // declared consumed — otherwise the raw string would reach the operation
  // and be refused as `invalid_input`.
  const limit = numericFlag(flags, "limit");
  if (!limit.ok) return limit;
  const passthrough = passThroughFlags(flags, ["limit"]);
  if (!passthrough.ok) return passthrough;
  // No `--session` mapping here: `orientation`'s input schema has no
  // session field at all (it is item-scoped, not session-scoped — see this
  // file's header).
  return {
    ok: true,
    input: {
      ...passthrough.input,
      itemId: idResult.itemId,
      ...(limit.value === undefined ? {} : { limit: limit.value }),
    },
  };
}

function buildCrewNameInput(_rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  return withSessionId(passthrough.input, flags);
}

export const OWNERSHIP_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "session",
    verb: "claim",
    operation: "claim",
    summary: "Takes ownership of an item in a role. Atomic — two agents can't both win.",
    buildInput: buildClaimInput,
  },
  {
    noun: "session",
    verb: "release",
    operation: "release",
    summary: "Gives up ownership of an item.",
    buildInput: buildItemSessionInput("session release <item-id>"),
  },
  {
    noun: "session",
    verb: "heartbeat",
    operation: "heartbeat",
    summary: "Still alive. Unnecessary if your hook flushes tool calls; needed if you run no hook.",
    buildInput: buildItemSessionInput("session heartbeat <item-id>"),
  },
  {
    noun: "session",
    verb: "takeover",
    operation: "takeover",
    summary:
      "Takes an item from another session. Free if that session is dead; needs --force and --reason if it may be alive.",
    buildInput: buildTakeoverInput,
  },
  {
    noun: "session",
    verb: "sweep",
    operation: "sweep",
    summary:
      "Runs the liveness sweep: ages quiet sessions, releases claims held by dead ones, escalates stuck items.",
    buildInput: buildSweepInput,
  },
  {
    noun: "session",
    verb: "checkpoint",
    operation: "checkpoint",
    summary:
      "Records what you tried, what you ruled out, what's next. --headline gives it a one-line BLUF that reads pick up without the prose.",
    buildInput: buildCheckpointInput,
  },
  {
    noun: "session",
    verb: "my-work",
    operation: "my_work",
    summary: "What this session holds right now, and in what role.",
    buildInput: buildMyWorkInput,
  },
  {
    noun: "session",
    verb: "progress",
    operation: "progress_report",
    summary:
      "A progress report on everything this session holds, in one fixed shape every time it is asked. Finished work is counted but not listed; --include-completed lists it.",
    buildInput: buildProgressReportInput,
  },
  {
    noun: "item",
    verb: "note",
    operation: "note",
    summary: "Leaves a timestamped remark on an item.",
    buildInput: buildNoteInput,
  },
  {
    noun: "item",
    verb: "orientation",
    operation: "orientation",
    summary:
      "Catch me up: latest checkpoint, current state, what changed since, open loops, and crew.",
    buildInput: buildOrientationInput,
  },
  {
    noun: "crew",
    verb: "name",
    operation: "get_crew_name",
    summary: "Requests a name for a new agent. Hands out one available name, atomically.",
    buildInput: buildCrewNameInput,
  },
]);

/**
 * `claim` as a bare word — PLAN.md's own daily-use example: "use daily:
 * `standup ls`, `standup claim T-…`, `standup complete`." `ls` is already
 * aliased in `commands.ts`; `complete` is row #81's territory.
 *
 * `sweep` is aliased for a different reason than `claim` is, and the reason is
 * worth stating: it is not a command a person types daily, it is the command a
 * **scheduler** invokes. Whatever runs it — a cron entry, a scheduled task, a
 * container's periodic job — the invocation is written once into a
 * configuration file and then read by people debugging it much later, so the
 * short form is the one that stays legible out of context. `standup sweep`
 * says what it does; `standup session sweep` reads as though it sweeps one
 * session, which is the opposite of what it does (it sweeps all of them).
 *
 * `takeover` is deliberately **not** aliased. Every other alias here shortens
 * something safe and frequent; takeover is neither, and a one-word form is
 * exactly what makes a dangerous command easy to fire absent-mindedly.
 * Requiring `session takeover` costs a word and makes the noun — whose
 * session — impossible to miss.
 */
export const OWNERSHIP_ALIASES: Readonly<Record<string, readonly [string, string]>> = Object.freeze(
  {
    claim: ["session", "claim"],
    sweep: ["session", "sweep"],
  },
);
