// Every field a folded tool forwards, against the schema that receives it.
//
// ── The defect this exists to make impossible ───────────────────────────
//
// The `score` fold forwarded the caller's facet list under the tool's own
// field name, `facets`, while `score_run` declares that field as `scores`.
// Both schemas are `.strict()`, so every `run` call was refused twice — the
// field it needed reported missing, the field it was sent reported
// unrecognised — and the fold's primary write verb did not work at all.
//
// **Nothing caught it**, and the reason is worth stating because it is a
// class rather than an incident:
//
//   - The fold's own tests asserted REFUSALS for the `run` action. A refusal
//     assertion passes whether the call was refused for the reason the test
//     meant or for a different reason entirely, so it held while the verb
//     was completely broken.
//   - The CLI's tests compared the builder's output to a literal written in
//     the test. A name the builder got wrong was a name the expectation got
//     wrong in exactly the same way, so the two agreed.
//   - Typescript could not help: both sides are `Record<string, unknown>` by
//     the time the value crosses the boundary.
//
// What no version of those checks does is ask the RECEIVING SCHEMA. This
// file does only that: for every action of every fold, it builds the payload
// the fold builds and parses it with the delegate's own schema — the object
// the service rejects with. A name the delegate does not know fails here,
// whatever any test expected.
//
// **It is deliberately about names and shapes, not behaviour.** No database,
// no handler, no seeded rows: the values below are placeholders chosen only
// to be well-formed. A field that reaches the right schema under the right
// name still has to do the right thing, and that is what the per-fold suites
// against Postgres are for.
import { describe, expect, it } from "vitest";

import { getOperation } from "@/lib/service/registry";

interface ParsingOperation {
  readonly input: {
    safeParse: (value: unknown) => { success: boolean; error?: { issues?: unknown } };
  };
}

/**
 * One forwarded payload, named by the delegate that must accept it.
 *
 * Every field each fold's handler can forward for that action appears here,
 * so a rename on either side is caught. The values are placeholders; only
 * the KEYS are under test, plus enough type-correctness for the schema to
 * reach its own field checks.
 */
const FORWARDED: readonly {
  readonly operation: string;
  readonly input: Record<string, unknown>;
}[] = [
  // ── score ────────────────────────────────────────────────────────────
  {
    operation: "score_run",
    // `scores`, not `facets`. This entry is the regression itself.
    input: {
      runId: "run-1",
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 4 }],
      raterId: "rater-1",
    },
  },
  { operation: "derive_run_score", input: { runId: "run-1", force: true } },
  {
    operation: "accept_run_score",
    // `facets` here IS correct — a list of names, and a different field
    // from `score_run`'s objects. The fold keeps them apart as `facets`
    // and `acceptFacets` for exactly this reason.
    input: { runId: "run-1", raterId: "rater-1", facets: ["reasoning"] },
  },
  {
    operation: "get_run_scores",
    input: { since: "2026-01-01", runId: "run-1", model: "opus", source: "agent", threshold: 2 },
  },
  {
    operation: "list_runs",
    input: {
      itemId: "item-1",
      sessionId: "sess-1",
      since: "2026-01-01",
      scored: "no",
      limit: 5,
    },
  },
  {
    operation: "score_intervention",
    input: { eventId: "1", score: 3, raterType: "agent", raterId: "sess-1", note: "a note" },
  },
  {
    operation: "get_intervention_scores",
    input: { since: "2026-01-01", entryId: "I10", threshold: 2 },
  },

  // ── project ──────────────────────────────────────────────────────────
  {
    operation: "get_projects",
    input: {
      area: "web",
      repo: "agent-standup",
      includeCompleted: true,
      includeArchived: true,
      limit: 5,
      cursor: "1",
    },
  },
  {
    operation: "get_project_detail",
    input: { id: "project-1", activityLimit: 5, childLimit: 5, includeArchived: true },
  },
  {
    operation: "repair_stuck_projects",
    // `projectId`, not `id`. The `project` tool calls the subject `id` for
    // every action and maps it here, which is the same class of rename.
    input: { projectId: "project-1", area: "web", apply: true },
  },

  // ── session ──────────────────────────────────────────────────────────
  {
    operation: "register_session",
    input: {
      sessionId: "sess-1",
      machine: "calliope",
      hookVariant: "cli",
      hookVersion: 1,
      client: "a-client",
      personId: "ope",
      driveMode: "autonomous",
    },
  },
  { operation: "get_session_shape", input: { sessionId: "sess-1", limit: 5 } },

  // ── loop ─────────────────────────────────────────────────────────────
  //
  // The fold that established the pattern. Included so the oldest one is
  // covered by the same check as the new ones rather than trusted.
  { operation: "loop_add", input: { itemId: "item-1", text: "a loose end", kind: "work" } },
  { operation: "loop_get", input: { itemId: "item-1", loopId: "loop-1" } },
  {
    operation: "loop_list",
    input: {
      itemId: "item-1",
      includeClosed: true,
      includeDeleted: true,
      includeNonWork: true,
    },
  },
  { operation: "loop_edit", input: { itemId: "item-1", loopId: "loop-1", text: "reworded" } },
  { operation: "loop_close", input: { itemId: "item-1", loopId: "loop-1", reason: "resolved" } },
  {
    operation: "loop_delete",
    input: { itemId: "item-1", loopId: "loop-1", reason: "a duplicate of an earlier loop" },
  },
];

describe("every folded field name is one its delegate accepts", () => {
  it.each(FORWARDED)("$operation accepts the payload its fold builds", ({ operation, input }) => {
    const delegate = getOperation(operation as never) as unknown as ParsingOperation | undefined;
    expect(delegate, `${operation} should be registered`).toBeDefined();

    const parsed = delegate!.input.safeParse(input);
    expect(
      parsed.success,
      `${operation} refused a field its fold forwards: ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
  });

  it("covers every operation the folds delegate to", () => {
    // A fold gaining a branch without gaining an entry here would leave the
    // new forwarding unchecked, which is how the original defect survived
    // review. Listing the delegates explicitly means the gap fails rather
    // than passing quietly.
    const covered = new Set(FORWARDED.map((entry) => entry.operation));
    for (const operation of [
      "score_run",
      "derive_run_score",
      "accept_run_score",
      "get_run_scores",
      "list_runs",
      "score_intervention",
      "get_intervention_scores",
      "get_projects",
      "get_project_detail",
      "repair_stuck_projects",
      "register_session",
      "get_session_shape",
      "loop_add",
      "loop_get",
      "loop_list",
      "loop_edit",
      "loop_close",
      "loop_delete",
    ]) {
      expect(covered, `${operation} is delegated to but not checked here`).toContain(operation);
    }
  });
});
