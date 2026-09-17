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
import { buildVerbInput, type VerbFields } from "./flags";
import type { CommandSpec, InputResult } from "./commands";

/**
 * What each verb reads from the words and flags after it.
 *
 * ⚠️ **POSITIONALS AND BARE SWITCHES ONLY.** Every value-carrying flag
 * reaches the operation untouched, and that operation's own `.strict()`
 * schema refuses a wrong one by name. Listing value-flag names here would
 * make this the allow-list that drops a field in silence — `buildVerbInput`
 * carries the full reasoning, and `tests/cli-merged-builder-fields.test.ts`
 * carries the assertion that can catch it.
 *
 * Three of these four differed only in their usage line. The two real
 * differences are stated rather than inferred:
 *
 *   - `artifacts` names its item `id`, not `itemId` — it is a read of one
 *     item, spelled the way every other single-item read spells it.
 *   - `artifacts` alone reads `--full` and `--limit`: a bare switch and a
 *     numeric flag, which a pass-through cannot handle (it refuses a
 *     valueless flag, and a schema declaring a number cannot take a string).
 *
 * `reviewRound` and `round` need no coercion even though both are numbers:
 * their schemas declare `z.coerce.number()`, so the string a command line
 * necessarily produces is converted in the one place every adapter shares.
 */
const VERBS: Readonly<Record<string, VerbFields>> = Object.freeze({
  artifact: { itemId: "item artifact <item-id>", session: true },
  "request-review": { itemId: "item request-review <item-id>", session: true },
  artifacts: {
    itemId: "item artifacts <item-id>",
    itemIdField: "id",
    // `optionalSwitches`, not `switches`: this verb sent `full` only when it
    // was written. The schema defaults it to `false`, so sending `false`
    // explicitly would behave identically — but "the caller asked for the
    // default" and "the caller said nothing" are different statements, and
    // this is a fold, not a place to start making one of them for them.
    optionalSwitches: { full: "full" },
    numbers: { limit: "limit" },
  },
  "blocked-on-tool": { itemId: "item blocked-on-tool <item-id>", session: true },
});

/** One verb's builder, by the key it is listed under above. */
function build(
  verb: keyof typeof VERBS,
): (
  rest: readonly string[],
  flags: Parameters<ReturnType<typeof buildVerbInput>>[1],
) => InputResult {
  return buildVerbInput(VERBS[verb]!);
}

export const ARTIFACT_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "item",
    verb: "artifact",
    operation: "record_artifact",
    summary:
      "Records an artifact — a plan, a review, a commit, a screenshot — against an item. --artifactKind says which; it is not --kind, because kind means something else on the loop verbs.",
    buildInput: build("artifact"),
  },
  {
    noun: "item",
    verb: "request-review",
    operation: "request_review",
    summary: "Requests a review of an item, recording that one was asked for.",
    buildInput: build("request-review"),
  },
  {
    noun: "item",
    verb: "artifacts",
    operation: "get_item_artifacts",
    summary:
      "List an item's artifacts — kind, verdict, ref and who recorded it. --kind filters, --artifactId reads one in full, --full returns bodies rather than summaries.",
    buildInput: build("artifacts"),
  },
  {
    noun: "item",
    verb: "blocked-on-tool",
    operation: "report_blocked_on_tool",
    summary:
      "Report a tool you could not use for the work an item asked of you. --tool names it, --needed says what the brief wanted done with it, --refusal records what it said back.",
    buildInput: build("blocked-on-tool"),
  },
]);
