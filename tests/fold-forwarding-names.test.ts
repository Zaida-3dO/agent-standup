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
//
// ── Why the literal table below was NOT enough, and what was added ──────
//
// The file as originally written was hollow on two axes, and both were
// found by asking the question the defect above teaches: *could this test
// have failed?*
//
//   1. **The payloads were literals, not observations.** Nothing here
//      imported a fold or invoked one — only `getOperation`, to reach the
//      DELEGATE's schema. So the entry claiming `score_run` receives
//      `scores` was a sentence written in this file about a payload built
//      in `score.ts`, and the two were never compared. Reverting the
//      `facets`→`scores` fix in `score.ts` left all nineteen cases green:
//      the literal said `scores` regardless of what the fold built. That is
//      the SAME class as the CLI's builder-versus-literal test named above
//      — a literal agrees with a builder that is wrong in the same way —
//      reproduced inside the very file written to end it.
//   2. **The coverage assertion was self-referential.** It compared
//      `FORWARDED`'s operation names against a hand-written list of the
//      same names a few lines below, in this same file. Adding to both kept
//      it green and forgetting both kept it green, so it could only catch a
//      contributor who edited one of two adjacent literals. It never
//      consulted the real table of what is folded, and consequently missed
//      `create_work`'s three delegates (`create_project`, `create_task`,
//      `create_subtask`) entirely — that fold's forwarding was checked by
//      nothing at all.
//
// Both halves are now derived and observed rather than restated:
//
//   - Coverage comes from `FOLDED_INTO.keys()` — the same map the
//     reachability checker and the adapter waivers read. A fold that gains a
//     delegate gains it here, because that map is what makes the delegate
//     reachable in the first place.
//   - Payloads are OBSERVED. `observeForwarding` runs a fold's real handler
//     and captures what it handed `parseDelegateInput`, which is the
//     delegate's own `.strict()` schema applied to the fold's own output.
//     A rename on either side now fails here whatever this file expected,
//     which is the property the literal table only claimed to have.
//
// The literal table is **kept**, not replaced. It is cheap and it catches a
// different thing: a delegate schema tightening under a fold that did not
// change. The two fail for different causes, which is the point.
import { describe, expect, it } from "vitest";

import { getOperation } from "@/lib/service/registry";
import { FOLDED_INTO } from "@/lib/service/describe/reachability";
import { discriminatorFor, FOLD_ACTIONS } from "@/lib/service/describe/fold-actions";
import type { ServiceContext } from "@/lib/service/context";
import { observeForwarding } from "./helpers/observe-forwarding";

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

  // ── get_item ─────────────────────────────────────────────────────────
  //
  // The depth fold. `get_item` forwards to `get_item_detail` only at
  // `full: "detail"`, and the two limits are the only fields that travel
  // with it — the delegate takes `id`, not `itemId`, and has no `full` of
  // its own, so forwarding this tool's `full` would be refused.
  {
    operation: "get_item_detail",
    input: { id: "item-1", historyLimit: 5, artifactLimit: 5 },
  },

  // ── create_work ──────────────────────────────────────────────────────
  //
  // **These three were delegated to and checked by nothing**, which the
  // derived coverage assertion below is what exposed. They were missing
  // from the hand-written list as well as from this table, so the two
  // literals agreed with each other and neither agreed with `FOLDED_INTO`.
  //
  // `create_work` calls its subject `title` for every kind and maps the
  // parent pointer per kind — `projectId` for a task, `taskId` for a
  // subtask — which is the same class of per-branch rename as
  // `repair_stuck_projects`'s `projectId` above.
  {
    operation: "create_project",
    input: { title: "a project", area: "web", repo: "agent-standup", body: "why" },
  },
  {
    operation: "create_task",
    input: {
      title: "a task",
      projectId: "project-1",
      area: "web",
      repo: "agent-standup",
      body: "why",
    },
  },
  {
    operation: "create_subtask",
    input: {
      title: "a subtask",
      taskId: "task-1",
      area: "web",
      repo: "agent-standup",
      body: "why",
    },
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
    // **Derived from `FOLDED_INTO`, not from a list beside this one.**
    //
    // The previous form of this assertion compared `FORWARDED`'s names
    // against a hand-written array of the same names a few lines below, in
    // this same file. Two literals maintained by one edit are not a check
    // on each other: adding to both kept it green, forgetting both kept it
    // green, and it never once consulted the table that decides what is
    // actually folded. It consequently reported full coverage while
    // `create_work`'s three delegates were checked by nothing.
    //
    // `FOLDED_INTO` is the right source because it is not a description of
    // the folds — it is the mechanism. An operation appears in it precisely
    // when it has been waived off MCP and made reachable through a fold, so
    // a fold gaining a delegate gains an entry there as a condition of
    // working at all. There is no way to fold something and not appear.
    const covered = new Set(FORWARDED.map((entry) => entry.operation));
    const delegated = [...FOLDED_INTO.keys()];

    // Anti-vacuity. An empty `FOLDED_INTO` — a bad import, a map renamed —
    // would make the filter below pass while checking nothing at all, and
    // this whole file's subject would have quietly disappeared.
    expect(delegated.length).toBeGreaterThan(0);

    expect(delegated.filter((operation) => !covered.has(operation))).toEqual([]);
  });

  it("still covers the delegates named when this file was written", () => {
    // Kept alongside the derived assertion above, and NOT as a duplicate of
    // it. This one fails if a delegate silently leaves `FOLDED_INTO` — an
    // unfolding — where the derived check would simply stop asking about
    // it and go green. The two therefore fail for opposite causes: the
    // derived one catches a fold that grew, this one catches a fold that
    // shrank without anyone saying so.
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
      "create_project",
      "create_task",
      "create_subtask",
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

// ── The observed half ──────────────────────────────────────────────────
//
// Everything above parses a payload written in THIS file. That is useful
// and it is not sufficient: it never once asks what the fold builds. The
// suite below does only that — it runs each fold's real handler and looks
// at what reached `parseDelegateInput`.
//
// **The mutation this was checked against**, and the reason the file is
// worth its length: revert `score.ts`'s forwarding from `scores` back to
// `facets` — the original defect, a single field name — and the literal
// table above stays green while `score → run` below goes red. That is the
// difference between a test about a fold and a test of one.

/** One action of one fold, and the delegate it must reach. */
interface ObservedCase {
  /** The folded tool, by the name a caller holds. */
  readonly tool: string;
  /** A well-formed call to it. Placeholder values; only names are under test. */
  readonly input: Record<string, unknown>;
  /** The registered operation this call must forward to. */
  readonly delegate: string;
}

/**
 * Every action of every fold, with a call that reaches its delegate.
 *
 * The inputs carry the fields each action REQUIRES, because a call refused
 * for a missing field never reaches the forwarding seam and would observe
 * nothing — a silent vacuous pass. `observedDelegates` below asserts that
 * every one of these actually forwarded, so an input that stops short fails
 * rather than being counted.
 */
const OBSERVED: readonly ObservedCase[] = [
  // ── loop ─────────────────────────────────────────────────────────────
  {
    tool: "loop",
    input: { action: "add", itemId: "item-1", text: "a loose end" },
    delegate: "loop_add",
  },
  {
    tool: "loop",
    input: { action: "get", itemId: "item-1", loopId: "loop-1" },
    delegate: "loop_get",
  },
  { tool: "loop", input: { action: "list", itemId: "item-1" }, delegate: "loop_list" },
  {
    tool: "loop",
    input: { action: "edit", itemId: "item-1", loopId: "loop-1", text: "reworded" },
    delegate: "loop_edit",
  },
  {
    tool: "loop",
    input: { action: "close", itemId: "item-1", loopId: "loop-1" },
    delegate: "loop_close",
  },
  {
    tool: "loop",
    input: {
      action: "delete",
      itemId: "item-1",
      loopId: "loop-1",
      reason: "a duplicate of an earlier loop",
    },
    delegate: "loop_delete",
  },

  // ── score ────────────────────────────────────────────────────────────
  //
  // `run` is the regression itself: the fold names the caller's list
  // `facets` on its own schema and must forward it as `scores`, which is
  // what `score_run` declares. Observed, so the rename is checked against
  // the builder rather than against a sentence about it.
  {
    tool: "score",
    input: {
      action: "run",
      runId: "run-1",
      raterType: "agent",
      facets: [{ facet: "reasoning", score: 4 }],
    },
    delegate: "score_run",
  },
  { tool: "score", input: { action: "derive", runId: "run-1" }, delegate: "derive_run_score" },
  {
    tool: "score",
    input: { action: "accept", runId: "run-1", raterId: "rater-1" },
    delegate: "accept_run_score",
  },
  // `runs` reads the recorded SCORES; `list` lists the RUNS. Two actions
  // one letter apart reaching two different operations is exactly the kind
  // of pairing a hand-written table gets wrong in a way that still looks
  // right, and observing it is what settles which is which.
  { tool: "score", input: { action: "runs" }, delegate: "get_run_scores" },
  { tool: "score", input: { action: "list" }, delegate: "list_runs" },
  {
    tool: "score",
    input: { action: "intervention", eventId: "1", score: 3, raterType: "agent" },
    delegate: "score_intervention",
  },
  {
    tool: "score",
    input: { action: "interventions" },
    delegate: "get_intervention_scores",
  },

  // ── project ──────────────────────────────────────────────────────────
  { tool: "project", input: { action: "list" }, delegate: "get_projects" },
  {
    tool: "project",
    input: { action: "detail", id: "project-1" },
    delegate: "get_project_detail",
  },
  // `id` on the fold, `projectId` at the delegate — the same class of
  // rename as `score`'s, and one only an observation can confirm.
  {
    tool: "project",
    input: { action: "repair", id: "project-1" },
    delegate: "repair_stuck_projects",
  },

  // ── session ──────────────────────────────────────────────────────────
  {
    tool: "session",
    input: { action: "register", sessionId: "sess-1", machine: "calliope" },
    delegate: "register_session",
  },
  {
    tool: "session",
    input: { action: "shape", sessionId: "sess-1" },
    delegate: "get_session_shape",
  },

  // ── get_item ─────────────────────────────────────────────────────────
  //
  // The one fold whose discriminator is neither `action` nor `type`: the
  // depth is `full`, kept under that name because it is the field that
  // already meant depth and every existing `full: true` goes on meaning
  // what it meant.
  //
  // Only the deepest depth forwards. The other two are answered by
  // `get_item` itself, which is why the coverage assertion below counts
  // declared ACTIONS separately from forwarded delegates.
  {
    tool: "get_item",
    input: { full: "detail", id: "item-1" },
    delegate: "get_item_detail",
  },

  // ── create_work ──────────────────────────────────────────────────────
  //
  // The three that were checked by nothing at all. Note the discriminator
  // is `type`, not `action` — which is itself a thing a hand-written
  // payload table cannot notice and an observation cannot miss.
  {
    tool: "create_work",
    input: { type: "project", title: "a project", area: "web", body: "why this exists" },
    delegate: "create_project",
  },
  {
    tool: "create_work",
    input: {
      type: "task",
      title: "a task",
      projectId: "project-1",
      area: "web",
      body: "why this exists",
    },
    delegate: "create_task",
  },
  {
    tool: "create_work",
    input: {
      type: "subtask",
      title: "a subtask",
      taskId: "task-1",
      area: "web",
      body: "why this exists",
    },
    delegate: "create_subtask",
  },
];

interface FoldOperation {
  // Typed against `ServiceContext` rather than `never` so the stub context
  // `observeForwarding` supplies is accepted. The INPUT stays `never`: every
  // fold declares its own schema-derived input type, and a test table
  // holding calls to five different folds has no single type for it.
  readonly handler: (ctx: ServiceContext, input: never) => Promise<unknown>;
}

describe("every fold forwards to the delegate it claims, under names that delegate accepts", () => {
  it.each(OBSERVED)(
    "$tool $input.action$input.type$input.full reaches $delegate",
    async ({ tool, input, delegate }) => {
      const fold = getOperation(tool as never) as unknown as FoldOperation | undefined;
      expect(fold, `${tool} should be registered`).toBeDefined();

      // The delegate's own `.strict()` parse runs inside this call. A field
      // the delegate does not know throws an `InvalidInputError` out of
      // here rather than being recorded, so a rename fails as a refusal
      // naming the field — the same object a caller would have been given.
      const forwarded = await observeForwarding(fold!.handler, input);

      expect(
        forwarded.map((call) => call.operation),
        `${tool} ${String(input.action ?? input.type)} forwarded somewhere unexpected`,
      ).toEqual([delegate]);
    },
  );

  /**
   * Actions a fold answers itself rather than by forwarding.
   *
   * **Named one by one, with the reason, rather than the assertion below
   * being relaxed to "most actions".** Every entry here is an action a
   * caller can be told about by `describe_tool` and that this file does NOT
   * check the forwarding of — so the list is the exact cost of the
   * exemption, written where it can be read, and adding to it is a visible
   * edit rather than a silent gap.
   *
   * `get_item`'s two shallower depths qualify because the tool answers them
   * with its own query; there is no delegate for a forwarding to reach.
   * That is a property of this fold rather than a thing left undone: the
   * depth fold is the one case where the tool folded INTO is also a real
   * read of its own, so only its deepest depth dispatches.
   */
  const ANSWERED_IN_TOOL = new Set(["get_item:summary", "get_item:item"]);

  it("observes a forwarding for every action every fold declares", () => {
    // Anti-vacuity of the table above, and the assertion that makes a fold
    // gaining an action fail here. `FOLD_ACTIONS` is what `describe_tool`
    // answers from, so an action a caller can be told about and that is
    // forwarded by nothing observed is exactly the gap this catches.
    // The discriminator is read from the same table `describe_tool` quotes
    // it from, rather than guessed at. Three folds name it three different
    // things — `action`, `type` and `full` — and a test that assumed one
    // would silently report every case of another as unobserved.
    const observed = new Set(
      OBSERVED.map((entry) => `${entry.tool}:${String(entry.input[discriminatorFor(entry.tool)])}`),
    );
    expect(FOLD_ACTIONS.size).toBeGreaterThan(0);

    const unobserved: string[] = [];
    for (const [tool, fold] of FOLD_ACTIONS) {
      expect(fold.actions.length, `${tool} declares an empty action list`).toBeGreaterThan(0);
      for (const action of fold.actions) {
        const key = `${tool}:${action}`;
        if (ANSWERED_IN_TOOL.has(key)) continue;
        if (!observed.has(key)) unobserved.push(key);
      }
    }
    expect(unobserved).toEqual([]);
  });

  it("exempts only actions that really are answered without forwarding", () => {
    // The exemption above is a hole, so it is bounded from both ends. Every
    // entry must name a real action of a real fold — a stale one would
    // silently excuse nothing while looking like it excused something, and
    // a typo'd one would excuse an action that does not exist while the
    // real action went unchecked.
    for (const key of ANSWERED_IN_TOOL) {
      const [tool, action] = key.split(":");
      const fold = FOLD_ACTIONS.get(tool!);
      expect(fold, `${key} exempts an action of a tool that folds nothing`).toBeDefined();
      expect(fold!.actions, `${key} exempts an action ${tool} does not declare`).toContain(action);
    }
  });

  it("observes a forwarding reaching every operation FOLDED_INTO claims is reachable", () => {
    // The OBSERVED half of §4.2b's cross-check, and the strong form of it.
    //
    // `FOLDED_INTO` says "this operation is reachable through that tool",
    // and the adapter waivers trust that sentence when they waive the
    // operation off MCP. Comparing that map against `FOLD_ACTIONS` compares
    // two declarations; running the fold and seeing which delegate it
    // actually reached compares a declaration against behaviour. A fold
    // that declared it folded an operation and reached a different one
    // would pass the former and fail here.
    const reached = new Set(OBSERVED.map((entry) => entry.delegate));
    const claimed = [...FOLDED_INTO.keys()];
    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.filter((operation) => !reached.has(operation))).toEqual([]);
  });
});
