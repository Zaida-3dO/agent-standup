// The `score` command-line noun — run scoring and intervention scoring.
//
// A separate module from `commands.ts` for the reason that file's header
// gives: entries are added as one appended import and one appended spread,
// so concurrent rows do not conflict over the same lines.
//
// ── Why one noun and not two ──────────────────────────────────────────
//
// These seven operations split naturally into two families — four about a
// `runs` row (`score_run`, `derive_run_score`, `accept_run_score`,
// `get_run_scores`, `list_runs`) and two about an `intervention_events` row
// (`score_intervention`, `get_intervention_scores`) — and the obvious
// binding would have been a `run` noun and an `intervention` noun. That was
// considered and rejected. SCHEMA.md §20 pins the nouns a person may type,
// and the table has already drifted past it; adding two nouns widens exactly
// the gap. One `score` noun carrying all seven verbs adds one.
//
// It is also the name the MCP surface gives the same capability, so one
// concept has one spelling on both surfaces — which is the property the
// taxonomy actually wants, and which two nouns would have given up to buy a
// tidier-looking split.
//
// Hanging the seven off the existing `session` noun would have added none at
// all, and was rejected for a different reason: a run is not a session, and
// buying a number by making the grammar say something false is a worse trade
// than the number is worth.
//
// **`score interventions`, not `score-interventions`.** The plural verb
// against the singular one is how `item loops` already distinguishes the
// read from the write. A hyphenated pseudo-verb would have contradicted the
// same PR's removal of six of them elsewhere.
import { buildVerbInput, type VerbFields } from "./flags";
import type { CommandSpec, InputResult } from "./commands";

/**
 * Maps the hyphenated command-line spelling onto the schema's camelCase.
 *
 * This is the one place the two vocabularies differ, and it is a **rename,
 * not a filter**: a flag with no entry here passes through under its own
 * name and is refused by the operation's `.strict()` schema if it is wrong.
 * Nothing is dropped — see the warning on `passThroughFlags`.
 */
const HYPHENATED: Readonly<Record<string, string>> = Object.freeze({
  "rater-type": "raterType",
  "rater-id": "raterId",
  "entry-id": "entryId",
  "event-id": "eventId",
  "run-id": "runId",
  "item-id": "itemId",
  "session-id": "sessionId",
});

/** `--facets '[{"facet":"code","score":4}]'` — an array of objects, so JSON. */
const facetsAsJson = {
  // The operation calls this field `scores`, not `facets`. The flag keeps
  // the word a person types — they are scoring facets, and `score accept`
  // takes a `--facets` of its own — so the rename happens here, once.
  to: "scores",
  parse: (raw: string) => {
    try {
      return { ok: true as const, value: JSON.parse(raw) as unknown };
    } catch {
      return {
        ok: false as const,
        message: '--facets must be JSON, e.g. \'[{"facet":"x","score":4}]\'.',
      };
    }
  },
};

/** `--facets a,b` — an array of plain strings, so a comma-separated list. */
const facetsAsList = {
  to: "facets",
  parse: (raw: string) => ({
    ok: true as const,
    value: raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  }),
};

/**
 * What each verb reads from the words and flags after it.
 *
 * ⚠️ **POSITIONALS, BARE SWITCHES, RENAMES AND TRANSFORMS ONLY — NEVER A
 * LIST OF THE VALUE FLAGS A VERB ACCEPTS.** A rename maps a spelling; a
 * transform reshapes one named flag's value; neither filters. Every flag
 * not mentioned reaches the operation untouched, and that operation's own
 * `.strict()` schema refuses a wrong one by name. A `fields: [...]` key
 * here would silently drop anything omitted from it — `buildVerbInput`
 * carries the reasoning, `tests/cli-merged-builder-fields.test.ts` the
 * assertion that can catch it.
 *
 * The two `--facets` entries are why transforms are per verb rather than
 * per flag: `score run` takes an array of objects and `score accept` an
 * array of strings, under the same flag name.
 */
/**
 * The verb descriptors this module's commands are built from.
 *
 * ⚠️ **Declared with `satisfies`, never with a `Record<string, VerbFields>`
 * annotation.** The annotation widens `keyof typeof VERBS` to `string`,
 * which silently defeats the `build(verb: keyof typeof VERBS)` constraint
 * below, because every string satisfies it: `build("clajm")` compiles, and
 * `VERBS[verb]` is then `undefined` at run time, so the verb's builder
 * reads no positional and no switch — a field parsed, accepted and quietly
 * not applied. `satisfies` keeps the keys literal instead, so a mistyped
 * verb is a compile error naming every valid key, while each value is
 * still checked against `VerbFields`.
 *
 * `tests/cli-verb-keys.test.ts` pins that every key here is reachable from
 * a command, which is the half a type cannot state.
 */
const VERBS = Object.freeze({
  run: {
    positional: { field: "runId", usage: "score run <run-id>", required: true },
    transforms: { facets: facetsAsJson },
    rename: HYPHENATED,
  },
  derive: {
    positional: { field: "runId", usage: "score derive <run-id>", required: true },
    // Sent only when given: the schema's own default decides the absent
    // case, and stamping `false` here would overwrite it.
    optionalSwitches: { force: "force" },
    rename: HYPHENATED,
  },
  accept: {
    positional: { field: "runId", usage: "score accept <run-id>", required: true },
    transforms: { facets: facetsAsList },
    rename: HYPHENATED,
  },
  scores: { numbers: { threshold: "threshold" }, rename: HYPHENATED },
  list: {
    // An item id may be given positionally, which is how every other
    // item-taking verb reads one — and optionally, because `score list`
    // with none lists every run.
    positional: { field: "itemId", usage: "score list", required: false },
    numbers: { limit: "limit" },
    session: true,
    rename: HYPHENATED,
  },
  intervention: {
    positional: { field: "eventId", usage: "score intervention <event-id>", required: true },
    numbers: { score: "score" },
    rename: HYPHENATED,
  },
  interventions: { numbers: { threshold: "threshold" }, rename: HYPHENATED },
} satisfies Readonly<Record<string, VerbFields>>);

/** One verb's builder, by the key it is listed under above. */
function build(
  verb: keyof typeof VERBS,
): (
  rest: readonly string[],
  flags: Parameters<ReturnType<typeof buildVerbInput>>[1],
) => InputResult {
  return buildVerbInput(VERBS[verb]);
}

export const SCORING_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "score",
    verb: "run",
    operation: "score_run",
    summary:
      'Record a score for a run, per facet. --rater-type agent writes the frozen self-assessment; --rater-type person writes the human judgement beside it and needs --rater-id. --facets takes JSON, e.g. \'[{"facet":"code","score":4}]\'.',
    buildInput: build("run"),
  },
  {
    noun: "score",
    verb: "derive",
    operation: "derive_run_score",
    summary:
      "Derive a run's score from its reviews. --force writes even when scoring.auto_derive is off, for a run being backfilled by hand.",
    buildInput: build("derive"),
  },
  {
    noun: "score",
    verb: "accept",
    operation: "accept_run_score",
    summary:
      "Accept a run's agent scores as the person's own. Needs --rater-id. --facets a,b accepts only those; omitted accepts every facet carrying an agent score and no user score.",
    buildInput: build("accept"),
  },
  {
    noun: "score",
    verb: "scores",
    operation: "get_run_scores",
    summary:
      "Aggregate run scores per facet, worst first, with the runs in the window that carry no score at all. --source effective prefers a person's judgement over the agent's.",
    buildInput: build("scores"),
  },
  {
    noun: "score",
    verb: "list",
    operation: "list_runs",
    summary:
      "List runs and their ids — the id every other scoring verb asks for. --scored no is the useful filter: what has not been judged yet.",
    buildInput: build("list"),
  },
  {
    noun: "score",
    verb: "intervention",
    operation: "score_intervention",
    summary:
      "Rate one intervention firing 1-5. --note is worth adding on a low score: a 1 can mean the detection was wrong, or that it was right and the message did not say what to do next.",
    buildInput: build("intervention"),
  },
  {
    noun: "score",
    verb: "interventions",
    operation: "get_intervention_scores",
    summary:
      "Aggregate intervention scores per catalogue entry, flagging the ones that persistently score 1 or 2.",
    buildInput: build("interventions"),
  },
]);
