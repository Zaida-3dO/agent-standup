// MILESTONES.md #100 — the `item loop` and `item loop-close` verbs.
//
// In their own module, appended to `commands.ts`'s table as a single spread,
// per that file's header: rows add entries rather than rewriting existing
// lines, so concurrent CLI rows do not conflict over the same lines.
import { malformed, type ErrorEnvelope } from "./envelope";
import { stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/** The flags the dispatcher handles itself — never part of an operation's input. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

type FieldsResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/** Same behaviour as `commands.ts`'s `flagsToInput` — see `commands-ownership.ts` for why it is a second copy. */
function passThroughFlags(flags: ParsedArgs["flags"]): FieldsResult {
  const input: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(name)) continue;
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

export const LOOP_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "item",
    verb: "loop",
    operation: "loop_add",
    summary:
      "Records a loose end on an item — something unresolved that is not itself a work item.",
    buildInput: buildLoopAddInput,
  },
  {
    noun: "item",
    verb: "loop-close",
    operation: "loop_close",
    summary: "Closes an open loop on an item.",
    buildInput: buildLoopCloseInput,
  },
]);
