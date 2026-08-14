// MILESTONES.md #98 — the `item artifact` and `item request-review` verbs.
//
// In their own module, appended to `commands.ts`'s table as a single spread,
// per that file's header: rows add entries rather than rewriting its existing
// lines, so two CLI rows landing at once do not conflict over the same lines.
//
// Both verbs take the item id as a positional and everything else as flags,
// which `passThroughFlags` maps onto the operation's own field names
// unchanged. No numeric coercion is needed here even though `reviewRound` and
// `round` are numbers: both schemas declare them with `z.coerce.number()`, so
// the string a command line necessarily produces is converted in the one
// place every adapter shares. Coercing here as well would be a second,
// adapter-local conversion — and the first thing to drift the day the schema
// changes what it accepts.
import { malformed, type ErrorEnvelope } from "./envelope";
import { stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/** The flags the dispatcher handles itself — never part of an operation's input. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

type FieldsResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/** Same behaviour as `commands.ts`'s `flagsToInput` — see `commands-ownership.ts`'s header for why it is a second copy. */
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

function buildRecordArtifactInput(
  rest: readonly string[],
  flags: ParsedArgs["flags"],
): InputResult {
  const idResult = itemIdPositional(rest, "item artifact <item-id>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;
  return { ok: true, input: { ...withSession.input, itemId: idResult.itemId } };
}

function buildRequestReviewInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const idResult = itemIdPositional(rest, "item request-review <item-id>");
  if (!idResult.ok) return idResult;
  const passthrough = passThroughFlags(flags);
  if (!passthrough.ok) return passthrough;
  const withSession = withSessionId(passthrough.input, flags);
  if (!withSession.ok) return withSession;
  return { ok: true, input: { ...withSession.input, itemId: idResult.itemId } };
}

export const ARTIFACT_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "item",
    verb: "artifact",
    operation: "record_artifact",
    summary: "Records an artifact — a plan, a review, a commit, a screenshot — against an item.",
    buildInput: buildRecordArtifactInput,
  },
  {
    noun: "item",
    verb: "request-review",
    operation: "request_review",
    summary: "Requests a review of an item, recording that one was asked for.",
    buildInput: buildRequestReviewInput,
  },
]);
