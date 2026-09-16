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
import { malformed, type ErrorEnvelope } from "./envelope";
import { booleanFlag, numericFlag, stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/** The flags the dispatcher handles itself — never part of an operation's input. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

/**
 * Collects the value-carrying flags into an operation input.
 *
 * ⚠️ **Pass-through by default, and it must stay that way.** This forwards
 * every flag it does not recognise as global or already-consumed, untouched,
 * and lets the operation's own `.strict()` schema decide what is valid. It
 * must **never** grow an allow-list of accepted field names.
 *
 * The reason is a real defect this codebase has already shipped once: a
 * builder carrying a list of the fields it knows about **silently drops**
 * any flag missing from that list. The dropped field is valid on the shared
 * schema, so nothing refuses it — the call is accepted, the value is
 * discarded, and the caller is told it succeeded. A refusal-shaped test
 * passes against that bug, which is why the regression test for this reads
 * the value back through a separate call instead.
 *
 * `consumed` names bare switches a verb has already read with `booleanFlag`.
 * They are skipped rather than left to fall through, because this function
 * refuses a valueless flag outright and passing one through would send it to
 * the operation twice under two spellings.
 */
function passThroughFlags(
  flags: ParsedArgs["flags"],
  consumed: readonly string[] = [],
): InputResult {
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

/** Reads the leading positional a verb requires, naming it when it is absent. */
function requiredPositional(
  rest: readonly string[],
  usage: string,
  field: string,
): { ok: true; value: string } | { ok: false; envelope: ErrorEnvelope } {
  const value = rest[0];
  if (value === undefined) {
    return {
      ok: false,
      envelope: malformed(`\`standup ${usage}\` needs a ${field}.`, [field]),
    };
  }
  return { ok: true, value };
}

/**
 * Folds the numeric flags a verb's schema declares as numbers.
 *
 * This is **not** the allow-list the warning above forbids: every flag still
 * passes through, and this only re-types the ones the schema declares as
 * numbers. A flag not named here still reaches the operation — as a string,
 * where the schema refuses it if that is wrong. Nothing is dropped.
 */
function withNumeric(
  input: Record<string, unknown>,
  flags: ParsedArgs["flags"],
  names: readonly string[],
): InputResult {
  const out: Record<string, unknown> = { ...input };
  for (const name of names) {
    const parsed = numericFlag(flags, name);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) out[name] = parsed.value;
  }
  return { ok: true, input: out };
}

/**
 * `standup score run <run-id> --rater-type … --facets '[…]'`.
 *
 * `--facets` carries JSON because the field is an array of objects, which a
 * flag cannot otherwise express. Invalid JSON is refused here rather than
 * passed through, for the reason `commands.ts` gives about its own JSON
 * flags: a string that is not JSON at all is not a question the operation's
 * schema could ever be asked.
 */
function buildScoreRunInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const runId = requiredPositional(rest, "score run <run-id>", "runId");
  if (!runId.ok) return runId;

  const facetsRaw = stringFlag(flags, "facets");
  if (!facetsRaw.ok) return facetsRaw;

  const passthrough = passThroughFlags(flags, []);
  if (!passthrough.ok) return passthrough;

  const input: Record<string, unknown> = {
    ...(passthrough.input as Record<string, unknown>),
    runId: runId.value,
  };

  if (facetsRaw.value !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(facetsRaw.value);
    } catch {
      return {
        ok: false,
        envelope: malformed('--facets must be JSON, e.g. \'[{"facet":"x","score":4}]\'.', [
          "facets",
        ]),
      };
    }
    input.facets = parsed;
  }

  return renameHyphenated(input);
}

function buildDeriveRunScoreInput(
  rest: readonly string[],
  flags: ParsedArgs["flags"],
): InputResult {
  const runId = requiredPositional(rest, "score derive <run-id>", "runId");
  if (!runId.ok) return runId;
  const force = booleanFlag(flags, "force");
  if (!force.ok) return force;
  const passthrough = passThroughFlags(flags, ["force"]);
  if (!passthrough.ok) return passthrough;

  const input: Record<string, unknown> = {
    ...(passthrough.input as Record<string, unknown>),
    runId: runId.value,
  };
  // Only sent when given: the schema's own default is what decides the
  // absent case, and stamping `false` here would overwrite it.
  if (force.value) input.force = true;
  return renameHyphenated(input);
}

/**
 * `standup score accept <run-id> --rater-id … [--facets a,b]`.
 *
 * `--facets` is a comma-separated list here rather than JSON, because the
 * field is an array of plain strings and `a,b` is what a person types.
 */
function buildAcceptRunScoreInput(
  rest: readonly string[],
  flags: ParsedArgs["flags"],
): InputResult {
  const runId = requiredPositional(rest, "score accept <run-id>", "runId");
  if (!runId.ok) return runId;

  const facets = stringFlag(flags, "facets");
  if (!facets.ok) return facets;

  const passthrough = passThroughFlags(flags, []);
  if (!passthrough.ok) return passthrough;

  const input: Record<string, unknown> = {
    ...(passthrough.input as Record<string, unknown>),
    runId: runId.value,
  };
  if (facets.value !== undefined) {
    input.facets = facets.value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  return renameHyphenated(input);
}

function buildGetRunScoresInput(_rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const passthrough = passThroughFlags(flags, []);
  if (!passthrough.ok) return passthrough;
  const numeric = withNumeric(passthrough.input as Record<string, unknown>, flags, ["threshold"]);
  if (!numeric.ok) return numeric;
  return renameHyphenated(numeric.input as Record<string, unknown>);
}

/**
 * `standup score list` — the runs, optionally narrowed.
 *
 * `--session` is the global identity flag, so it maps onto the operation's
 * own `sessionId` the way every other session-scoped command reads it.
 */
function buildListRunsInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const passthrough = passThroughFlags(flags, []);
  if (!passthrough.ok) return passthrough;
  const numeric = withNumeric(passthrough.input as Record<string, unknown>, flags, ["limit"]);
  if (!numeric.ok) return numeric;

  const input: Record<string, unknown> = { ...(numeric.input as Record<string, unknown>) };
  // An item id may be given positionally, which is how every other
  // item-taking verb reads one.
  if (rest[0] !== undefined) input.itemId = rest[0];

  const session = stringFlag(flags, "session");
  if (!session.ok) return session;
  if (session.value !== undefined) input.sessionId = session.value;

  return renameHyphenated(input);
}

function buildScoreInterventionInput(
  rest: readonly string[],
  flags: ParsedArgs["flags"],
): InputResult {
  const eventId = requiredPositional(rest, "score intervention <event-id>", "eventId");
  if (!eventId.ok) return eventId;
  const passthrough = passThroughFlags(flags, []);
  if (!passthrough.ok) return passthrough;
  const numeric = withNumeric(passthrough.input as Record<string, unknown>, flags, ["score"]);
  if (!numeric.ok) return numeric;

  return renameHyphenated({
    ...(numeric.input as Record<string, unknown>),
    eventId: eventId.value,
  });
}

function buildGetInterventionScoresInput(
  _rest: readonly string[],
  flags: ParsedArgs["flags"],
): InputResult {
  const passthrough = passThroughFlags(flags, []);
  if (!passthrough.ok) return passthrough;
  const numeric = withNumeric(passthrough.input as Record<string, unknown>, flags, ["threshold"]);
  if (!numeric.ok) return numeric;
  return renameHyphenated(numeric.input as Record<string, unknown>);
}

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

function renameHyphenated(input: Record<string, unknown>): InputResult {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    out[HYPHENATED[name] ?? name] = value;
  }
  return { ok: true, input: out };
}

export const SCORING_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "score",
    verb: "run",
    operation: "score_run",
    summary:
      'Record a score for a run, per facet. --rater-type agent writes the frozen self-assessment; --rater-type person writes the human judgement beside it and needs --rater-id. --facets takes JSON, e.g. \'[{"facet":"code","score":4}]\'.',
    buildInput: buildScoreRunInput,
  },
  {
    noun: "score",
    verb: "derive",
    operation: "derive_run_score",
    summary:
      "Derive a run's score from its reviews. --force writes even when scoring.auto_derive is off, for a run being backfilled by hand.",
    buildInput: buildDeriveRunScoreInput,
  },
  {
    noun: "score",
    verb: "accept",
    operation: "accept_run_score",
    summary:
      "Accept a run's agent scores as the person's own. Needs --rater-id. --facets a,b accepts only those; omitted accepts every facet carrying an agent score and no user score.",
    buildInput: buildAcceptRunScoreInput,
  },
  {
    noun: "score",
    verb: "scores",
    operation: "get_run_scores",
    summary:
      "Aggregate run scores per facet, worst first, with the runs in the window that carry no score at all. --source effective prefers a person's judgement over the agent's.",
    buildInput: buildGetRunScoresInput,
  },
  {
    noun: "score",
    verb: "list",
    operation: "list_runs",
    summary:
      "List runs and their ids — the id every other scoring verb asks for. --scored no is the useful filter: what has not been judged yet.",
    buildInput: buildListRunsInput,
  },
  {
    noun: "score",
    verb: "intervention",
    operation: "score_intervention",
    summary:
      "Rate one intervention firing 1-5. --note is worth adding on a low score: a 1 can mean the detection was wrong, or that it was right and the message did not say what to do next.",
    buildInput: buildScoreInterventionInput,
  },
  {
    noun: "score",
    verb: "interventions",
    operation: "get_intervention_scores",
    summary:
      "Aggregate intervention scores per catalogue entry, flagging the ones that persistently score 1 or 2.",
    buildInput: buildGetInterventionScoresInput,
  },
]);
