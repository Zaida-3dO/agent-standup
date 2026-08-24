// MILESTONES.md #100 — the `item loop` and `item loop-close` verbs.
//
// In their own module, appended to `commands.ts`'s table as a single spread,
// per that file's header: rows add entries rather than rewriting existing
// lines, so concurrent CLI rows do not conflict over the same lines.
import { malformed, type ErrorEnvelope } from "./envelope";
import { booleanFlag, stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/** The flags the dispatcher handles itself — never part of an operation's input. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

type FieldsResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/**
 * Same behaviour as `commands.ts`'s `flagsToInput` — see `commands-ownership.ts` for why it is a second copy.
 *
 * `consumed` names the bare switches a verb has already read with
 * `booleanFlag`. They have to be skipped here rather than left to fall
 * through: this function refuses a valueless flag outright, so a switch
 * reaching it would be rejected as "--all needs a value", and passing one
 * through would send it to the operation twice under two spellings. `item
 * list` handles `--all`/`--full` the same way.
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

/** `--session` maps onto the operation's own optional `sessionId` field. */
function withSessionId(input: Record<string, unknown>, flags: ParsedArgs["flags"]): FieldsResult {
  const session = stringFlag(flags, "session");
  if (!session.ok) return session;
  if (session.value === undefined) return { ok: true, input };
  return { ok: true, input: { ...input, sessionId: session.value } };
}

/**
 * `standup item loop <item-id> <text...>`.
 *
 * The loop's text is the remaining positional words joined, not a `--text`
 * flag: it is prose, it is the whole point of the command, and quoting a
 * sentence into a flag is the kind of friction that stops a loose end being
 * recorded at all. Same reasoning that puts a commit message after the verb.
 */
function buildLoopAddInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item loop <item-id> <text>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;

  const words = rest.slice(1);
  const input: Record<string, unknown> = { ...withSession.input, itemId: idResult.itemId };
  // Only set from the words when there are some. A caller passing `--text`
  // explicitly still works, and an empty run leaves the field absent so the
  // schema's own "loop text is required" is what refuses it — field
  // validation belongs in the schema, not in `buildInput` (§20).
  if (words.length > 0) {
    input.text = words.join(" ");
  }
  return { ok: true, input };
}

function buildLoopCloseInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item loop-close <item-id> <loop-id>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;

  const input: Record<string, unknown> = { ...withSession.input, itemId: idResult.itemId };
  const loopId = rest[1];
  if (loopId !== undefined) {
    input.loopId = loopId;
  }
  return { ok: true, input };
}

/**
 * `standup item loops <item-id>` — the list read.
 *
 * Plural `loops` against the singular `loop` that opens one, so the verb
 * that lists and the verb that writes cannot be typed for each other. `--all`
 * is the command line's spelling of `includeClosed`, matching what `item
 * list` already calls the same idea; `--deleted` adds the retracted ones, and
 * `--notes` adds the ones filed as notes rather than as work.
 * Both are bare switches, so they cannot go through `passThroughFlags` —
 * which refuses a valueless flag — and are declared consumed so they do not
 * also arrive under their own names.
 */
function buildLoopListInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item loops <item-id>");
  if (!idResult.ok) return idResult;
  const all = booleanFlag(flags, "all");
  if (!all.ok) return all;
  const deleted = booleanFlag(flags, "deleted");
  if (!deleted.ok) return deleted;
  // Notes are held out of the default list because the count is what a
  // person reads to judge whether an item is nearly done; `--notes` asks for
  // them back. Loops blocked on a person are NOT held back — they are work.
  const notes = booleanFlag(flags, "notes");
  if (!notes.ok) return notes;
  const passthrough = passThroughFlags(flags, ["all", "deleted", "notes"]);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;

  return {
    ok: true,
    input: {
      ...withSession.input,
      itemId: idResult.itemId,
      includeClosed: all.value,
      includeDeleted: deleted.value,
      includeNonWork: notes.value,
    },
  };
}

/** `standup item loop-get <item-id> <loop-id>` — one loop in full. */
function buildLoopGetInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item loop-get <item-id> <loop-id>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;

  const input: Record<string, unknown> = { ...passthrough.input, itemId: idResult.itemId };
  const loopId = rest[1];
  if (loopId !== undefined) {
    input.loopId = loopId;
  }
  return { ok: true, input };
}

/**
 * `standup item loop-edit <item-id> <loop-id> <text...>`.
 *
 * The replacement text is the remaining positional words joined, exactly as
 * `item loop` takes the original: it is prose, it is the point of the
 * command, and quoting a sentence into a flag is the friction that stops it
 * being written at all.
 */
function buildLoopEditInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item loop-edit <item-id> <loop-id> <text>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;

  const input: Record<string, unknown> = { ...withSession.input, itemId: idResult.itemId };
  const loopId = rest[1];
  if (loopId !== undefined) {
    input.loopId = loopId;
  }
  const words = rest.slice(2);
  // Left absent when there are none, so the schema's own "loop text is
  // required" is what refuses it — field validation belongs in the schema,
  // not in `buildInput` (§20).
  if (words.length > 0) {
    input.text = words.join(" ");
  }
  return { ok: true, input };
}

/**
 * `standup item loop-delete <item-id> <loop-id> --reason "..."`.
 *
 * The reason is a flag rather than trailing prose, deliberately unlike the
 * text on `loop` and `loop-edit`. It is not the content of the thing being
 * recorded — it is a justification the operation refuses without, and
 * `--reason` at the end of the line reads as the deliberate step it is meant
 * to be. `item delete` spells the same requirement the same way.
 */
function buildLoopDeleteInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item loop-delete <item-id> <loop-id>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;

  const input: Record<string, unknown> = { ...withSession.input, itemId: idResult.itemId };
  const loopId = rest[1];
  if (loopId !== undefined) {
    input.loopId = loopId;
  }
  return { ok: true, input };
}

export const LOOP_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "item",
    verb: "loop",
    operation: "loop_add",
    summary:
      "Records a loose end on an item — a piece of work that still needs doing but is not big enough to be its own item. " +
      "Loops track WORK: a reference or a status note belongs in the repo or in a note, not here. " +
      "--kind note keeps one out of the count of work outstanding; --kind blocked_on_person is for something real waiting on a human.",
    buildInput: buildLoopAddInput,
  },
  {
    noun: "item",
    verb: "loop-close",
    operation: "loop_close",
    summary: "Closes an open loop on an item.",
    buildInput: buildLoopCloseInput,
  },
  {
    noun: "item",
    verb: "loops",
    operation: "loop_list",
    summary:
      "List an item's loops — id, kind, status, when it opened and the first 200 characters. Open loops that track work only; --all includes closed ones, --deleted includes retracted ones, --notes includes loops filed as notes.",
    buildInput: buildLoopListInput,
  },
  {
    noun: "item",
    verb: "loop-get",
    operation: "loop_get",
    summary: "Show one loop on an item in full, by its loop id.",
    buildInput: buildLoopGetInput,
  },
  {
    noun: "item",
    verb: "loop-edit",
    operation: "loop_edit",
    summary: "Rewrite an open loop's text. Keeps its original openedAt.",
    buildInput: buildLoopEditInput,
  },
  {
    noun: "item",
    verb: "loop-delete",
    operation: "loop_delete",
    summary:
      "Retract a loop that should never have existed — a duplicate, or one recorded by accident. Needs --reason. Use loop-close for a real loose end that is resolved.",
    buildInput: buildLoopDeleteInput,
  },
]);
