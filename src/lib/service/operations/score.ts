// `score` — the seven scoring verbs behind one tool, chosen with `action`.
//
// ── Why this is folded, and why only on MCP ─────────────────────────────
//
// An MCP tool list is sent to the model **on every session**, so every
// registered tool spends context whether or not it is ever called — the same
// cost `waivers.ts` reasons about for `backfill`. Seven scoring verbs spend
// that budget seven times to describe one capability: judging how a piece of
// work went. `score_run`, `derive_run_score`, `accept_run_score`,
// `get_run_scores` and `list_runs` all name a `runId` or filter the same
// rows; `score_intervention` and `get_intervention_scores` do the same for a
// firing. A caller reaching for any of them has already decided it is
// scoring something; what it has not yet said is which verb.
//
// The seven operations are **not removed**. They stay registered, stay
// reachable over HTTP and the command line (`standup score …`), and keep
// their own tests; they are waived off the two MCP adapters only.
//
// ── Why one tool over runs AND interventions ────────────────────────────
//
// They are two tables, and a split into `score` and `score_intervention`
// would have been defensible. One tool wins because the question a caller
// actually has is "how did this go", and the answer is the same shape either
// way: a 1-5 judgement, a rater who is an agent or a person, and an
// aggregate read that flags the bad ones. Two tools would spend the tool
// budget twice to express one idea, which is the cost this fold exists to
// remove. The `runId`/`eventId` split is what `action` already tells us.
//
// ── No second implementation ────────────────────────────────────────────
//
// Every action below dispatches to the operation that already implements it,
// through the same `ctx` it was handed. There is no copy of the
// frozen-agent-score rule, no copy of the facet-declaration check, no copy of
// the auto-derive setting logic — and therefore nothing that can drift. A
// refusal a caller gets here is the *same object* the unfolded operation
// would have thrown, so its `code`, its `guard` id and its `fields` are
// identical on both surfaces, which is what §22's cross-adapter comparison
// needs.
//
// ── The asymmetry that must not be flattened ────────────────────────────
//
// **`raterId` is required for a person and optional for an agent**, on both
// `score_run` and `score_intervention`. An agent rating its own session's
// work is identified by the session it is already calling from; a person is
// not, and two people may judge the same work differently — collapsing them
// loses that. This fold forwards `raterId` exactly as it arrived and lets
// each operation apply its own rule, rather than restating either here.
import { z } from "zod";

import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { parseDelegateInput } from "../shape-refusal";
import { scoreRun } from "./score-run";
import { deriveRunScore } from "./derive-run-score";
import { acceptRunScore } from "./accept-run-score";
import { getRunScores } from "./get-run-scores";
import { listRuns } from "./list-runs";
import { scoreIntervention } from "./score-intervention";
import { getInterventionScores } from "./get-intervention-scores";

/** The verbs this tool folds, runs first and then intervention firings. */
export const SCORE_ACTIONS = [
  "run",
  "derive",
  "accept",
  "runs",
  "list",
  "intervention",
  "interventions",
] as const;

export type ScoreAction = (typeof SCORE_ACTIONS)[number];

/**
 * The fields each action cannot run without.
 *
 * One list, used both to refuse and to build the sentence the refusal is
 * made from — a required field and the sentence naming it cannot disagree
 * when there is one list. `describe_tool` reads the same table, so what the
 * tool advertises as required and what it actually refuses are one fact.
 */
export const SCORE_ACTION_FIELDS: Readonly<Record<ScoreAction, { required: readonly string[] }>> =
  Object.freeze({
    run: { required: ["runId", "raterType", "facets"] },
    derive: { required: ["runId"] },
    accept: { required: ["runId", "raterId"] },
    runs: { required: [] },
    list: { required: [] },
    intervention: { required: ["eventId", "score", "raterType"] },
    interventions: { required: [] },
  });

const inputSchema = z
  .object({
    /** Which verb. The one field that decides what the rest of the call means. */
    action: z.enum(SCORE_ACTIONS),

    // ── Runs ───────────────────────────────────────────────────────────
    /** The `runs` row being scored, derived, accepted, or narrowed to. */
    runId: z.string().trim().min(1).optional(),
    /**
     * One entry per facet scored, for `run`.
     *
     * Left as a loose array here and parsed by `score_run`'s own schema,
     * which is where the facet enum and the 1-5 bound live. Restating either
     * would put the same rule in two places.
     */
    facets: z.array(z.unknown()).optional(),
    /**
     * Which facets to accept, for `accept`. Omitted means every facet
     * carrying an agent score and no user score.
     */
    acceptFacets: z.array(z.string()).optional(),
    /** Write even when `scoring.auto_derive` is off, for `derive`. */
    force: z.boolean().optional(),

    // ── Intervention firings ───────────────────────────────────────────
    /** The `intervention_events` row being rated, for `intervention`. */
    eventId: z.string().trim().min(1).optional(),
    /** The 1-5 judgement, for `intervention`. Bounded by that operation. */
    score: z.number().int().optional(),
    /** One line on why, optional and worth having on a low score. */
    note: z.string().trim().min(1).optional(),
    /** Narrow an aggregate to one catalogue entry, for `interventions`. */
    entryId: z.string().trim().min(1).optional(),

    // ── Shared by the writes and the reads ─────────────────────────────
    /**
     * Who is rating, for `run` and `intervention`.
     *
     * Kept apart because an agent and a person answer differently and a mean
     * over both would hide the disagreement worth seeing.
     */
    raterType: z.enum(["agent", "person"]).optional(),
    /**
     * A session id for an agent, a person id for a person.
     *
     * **Required for a person, optional for an agent** — and that rule is
     * enforced by each operation, not restated here. See this module's
     * header.
     */
    raterId: z.string().trim().min(1).optional(),
    /** Only rows at or after this instant. ISO 8601. */
    since: z.string().trim().min(1).optional(),
    /** Minimum count before a facet or an entry can be flagged. */
    threshold: z.number().int().positive().optional(),
    /** Which score an aggregate reads, for `runs`. */
    source: z.enum(["agent", "user", "effective"]).optional(),
    /** Restrict an aggregate to runs served by one model, for `runs`. */
    model: z.string().trim().min(1).optional(),

    // ── `list` only ────────────────────────────────────────────────────
    /** The item whose runs to list. Accepts a short id prefix. */
    itemId: z.string().trim().min(1).optional(),
    /** The session whose runs to list. Combines with `itemId` as AND. */
    sessionId: z.string().trim().min(1).optional(),
    /** Narrow to runs that do, or do not, already carry a score. */
    scored: z.enum(["yes", "no"]).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export type ScoreInput = z.infer<typeof inputSchema>;

/**
 * Refuses an action that is missing a field it cannot run without.
 *
 * Named after the field and the action, and it says what to pass, so a
 * caller that reads this knows which call to make next without opening a
 * schema.
 */
function requireFields(input: ScoreInput): void {
  const missing = SCORE_ACTION_FIELDS[input.action].required.filter(
    (field) => input[field as keyof ScoreInput] === undefined,
  );
  if (missing.length === 0) return;
  const list = missing.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `score action "${input.action}" requires ${list}, which ${
      missing.length === 1 ? "was" : "were"
    } not supplied. Resend the call with ${list} set.`,
    { fields: missing },
  );
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const score = defineOperation({
  name: "score",
  kind: "write",
  summary:
    "Judges how work went — say which with action. run records a per-facet score for a run (raterType agent writes the frozen self-assessment, person writes the human judgement beside it and needs raterId). derive computes one from the run's reviews; accept adopts the agent's scores as a person's. runs and list read them back — list is what returns the runId every other action needs, and scored:no is the 'what have I not judged yet' filter. intervention rates one catalogue firing 1-5, and interventions aggregates those, flagging the ones that persistently score 1 or 2.",
  contract: {
    rules: [
      {
        fields: ["action"],
        rule: "run requires runId, raterType and facets; derive requires runId; accept requires runId and raterId; intervention requires eventId, score and raterType; runs, list and interventions require none. A missing field is refused by name.",
      },
      {
        fields: ["raterId"],
        rule: "Required when raterType is person, on both run and intervention — two people may judge the same work differently and collapsing them loses that. Optional for an agent, which is identified by the session it is calling from.",
      },
      {
        fields: ["facets"],
        rule: "On action run, only facets the item declared may be sent, and a facet that already carries a frozen agent score is left alone and reported rather than overwritten. On action accept, omitting acceptFacets accepts every facet that carries an agent score and no user score.",
      },
    ],
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ScoreInput): Promise<unknown> {
    requireFields(input);

    // Each branch forwards only the fields its operation's `.strict()` schema
    // accepts. Spreading everything would be shorter and would fail: each of
    // the seven refuses an unrecognised key, so a `note` left over from an
    // intervention rating would make the next `derive` invalid.
    //
    // Every optional field is forwarded **as it arrived** — present when the
    // caller sent one, absent when it did not — so each operation applies its
    // own default rather than having one restated here.
    switch (input.action) {
      case "run":
        return scoreRun.handler(
          ctx,
          parseDelegateInput(
            scoreRun.name,
            scoreRun.input,
            {
              runId: input.runId,
              raterType: input.raterType,
              facets: input.facets,
              ...(input.raterId === undefined ? {} : { raterId: input.raterId }),
            },
            ctx.caller.transport,
          ),
        );
      case "derive":
        return deriveRunScore.handler(
          ctx,
          parseDelegateInput(
            deriveRunScore.name,
            deriveRunScore.input,
            {
              runId: input.runId,
              ...(input.force === undefined ? {} : { force: input.force }),
            },
            ctx.caller.transport,
          ),
        );
      case "accept":
        return acceptRunScore.handler(
          ctx,
          parseDelegateInput(
            acceptRunScore.name,
            acceptRunScore.input,
            {
              runId: input.runId,
              raterId: input.raterId,
              // `facets` on this operation is a list of facet NAMES, unlike
              // `score_run`'s list of objects. They are separate fields here
              // so one tool cannot send the wrong shape to the other.
              ...(input.acceptFacets === undefined ? {} : { facets: input.acceptFacets }),
            },
            ctx.caller.transport,
          ),
        );
      case "runs":
        return getRunScores.handler(
          ctx,
          parseDelegateInput(
            getRunScores.name,
            getRunScores.input,
            {
              ...(input.since === undefined ? {} : { since: input.since }),
              ...(input.runId === undefined ? {} : { runId: input.runId }),
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.source === undefined ? {} : { source: input.source }),
              ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
            },
            ctx.caller.transport,
          ),
        );
      case "list":
        return listRuns.handler(
          ctx,
          parseDelegateInput(
            listRuns.name,
            listRuns.input,
            {
              ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
              ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
              ...(input.since === undefined ? {} : { since: input.since }),
              ...(input.scored === undefined ? {} : { scored: input.scored }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            },
            ctx.caller.transport,
          ),
        );
      case "intervention":
        return scoreIntervention.handler(
          ctx,
          parseDelegateInput(
            scoreIntervention.name,
            scoreIntervention.input,
            {
              eventId: input.eventId,
              score: input.score,
              raterType: input.raterType,
              ...(input.raterId === undefined ? {} : { raterId: input.raterId }),
              ...(input.note === undefined ? {} : { note: input.note }),
            },
            ctx.caller.transport,
          ),
        );
      case "interventions":
        return getInterventionScores.handler(
          ctx,
          parseDelegateInput(
            getInterventionScores.name,
            getInterventionScores.input,
            {
              ...(input.since === undefined ? {} : { since: input.since }),
              ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
              ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
            },
            ctx.caller.transport,
          ),
        );
    }
  },
});
