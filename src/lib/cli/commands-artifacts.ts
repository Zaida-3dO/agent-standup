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
import { booleanFlag, numericFlag, stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/** The flags the dispatcher handles itself — never part of an operation's input. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

type FieldsResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/**
 * Same behaviour as `commands.ts`'s `flagsToInput` — see
 * `commands-ownership.ts`'s header for why it is a second copy.
 *
 * ⚠️ **Pass-through by default.** Every flag that is not global and not
 * already consumed is forwarded untouched, and the operation's own
 * `.strict()` schema decides what is valid. This must never grow an
 * allow-list of accepted field names: a builder carrying one silently drops
 * a flag missing from the list, and because the dropped field is valid on
 * the shared schema nothing refuses it — the call is accepted, the value is
 * discarded, and the caller is told it worked.
 *
 * `consumed` names the bare switches a verb has already read with
 * `booleanFlag`. They are skipped rather than left to fall through, because
 * this function refuses a valueless flag outright and passing one through
 * would send it to the operation twice under two spellings.
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

/**
 * `standup item artifacts <item-id>` — the read beside the `artifact` write.
 *
 * Plural against the singular verb that records one, the same way `item
 * loops` reads against `item loop`, so the verb that lists and the verb that
 * writes cannot be typed for each other.
 *
 * Until this binding existed the operation was reachable on MCP alone: it has
 * no HTTP route at all, so this command is its only non-MCP reachability.
 *
 * `--full` is a bare switch, so it is read with `booleanFlag` and declared
 * consumed rather than falling through `passThroughFlags`, which refuses a
 * valueless flag. `--limit` is re-typed because the schema declares a number
 * and a command line only ever produces strings. Neither is an allow-list:
 * every other flag still passes through under its own name and is refused by
 * the operation's own `.strict()` schema if it is wrong.
 */
function buildGetItemArtifactsInput(
  rest: readonly string[],
  flags: ParsedArgs["flags"],
): InputResult {
  const idResult = itemIdPositional(rest, "item artifacts <item-id>");
  if (!idResult.ok) return idResult;
  const full = booleanFlag(flags, "full");
  if (!full.ok) return full;
  const limit = numericFlag(flags, "limit");
  if (!limit.ok) return limit;
  const passthrough = passThroughFlags(flags, ["full", "limit"]);
  if (!passthrough.ok) return passthrough;

  // The operation names the item `id`, not `itemId` — it is a read of one
  // item, spelled the way every other single-item read spells it.
  const input: Record<string, unknown> = { ...passthrough.input, id: idResult.itemId };
  if (full.value) input.full = true;
  if (limit.value !== undefined) input.limit = limit.value;
  return { ok: true, input };
}

/**
 * `standup item blocked-on-tool <item-id> --tool … --needed …`.
 *
 * Every field but the item id is a flag: none of them is the single obvious
 * subject of the command the way a loop's text is, and `--tool` and
 * `--needed` read as the two separate answers they are.
 */
function buildReportBlockedOnToolInput(
  rest: readonly string[],
  flags: ParsedArgs["flags"],
): InputResult {
  const idResult = itemIdPositional(rest, "item blocked-on-tool <item-id>");
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
  {
    noun: "item",
    verb: "artifacts",
    operation: "get_item_artifacts",
    summary:
      "List an item's artifacts — kind, verdict, ref and who recorded it. --kind filters, --artifactId reads one in full, --full returns bodies rather than summaries.",
    buildInput: buildGetItemArtifactsInput,
  },
  {
    noun: "item",
    verb: "blocked-on-tool",
    operation: "report_blocked_on_tool",
    summary:
      "Report a tool you could not use for the work an item asked of you. --tool names it, --needed says what the brief wanted done with it, --refusal records what it said back.",
    buildInput: buildReportBlockedOnToolInput,
  },
]);
