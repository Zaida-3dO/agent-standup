// The `score` fold — seven scoring verbs behind one tool, against Postgres.
//
// **What would make this file hollow.** Asserting that `score { action:
// "list" }` returns an array proves only that a dispatch happened; it would
// pass against a fold that dropped `raterId`, sent `score_run`'s facet
// objects to `accept_run_score`'s name list, or refused nothing by name. So
// every case below fixes a decision and, beside the assertion, names what
// breaks it.
//
// The decisions worth pinning, in the order they can go wrong:
//
//   1. **Each action reaches the operation it folds, and no other.** The
//      fold's whole safety argument is that it reimplements nothing, so a
//      branch wired to the wrong delegate is the failure that matters most.
//   2. **A missing required field is refused by name, per action.** The
//      refusal has to say which field and which action, because a caller
//      reading it should know the next call to make without opening a
//      schema.
//   3. **Optional fields are forwarded as they arrived.** Absent must stay
//      absent, so each operation applies its own default rather than having
//      one restated in the fold. The `facets`/`acceptFacets` split is the
//      sharpest case: two actions take a field called `facets` with
//      different SHAPES, and collapsing them would send the wrong one.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { listOperations } from "@/lib/service/registry";
import { exposedOperations } from "@/lib/adapters/waivers";
import { FOLDED_INTO } from "@/lib/service/describe/reachability";
import { SCORE_ACTIONS, SCORE_ACTION_FIELDS } from "@/lib/service/operations/score";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ServiceError {
  code: string;
  guard?: string;
  fields?: string[];
  message: string;
}

/** Runs `call` and returns the error it threw, failing the test if it did not throw. */
async function rejection(call: Promise<unknown>): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

// ── The surface, which needs no database ─────────────────────────────────

describe("the score fold's reachability", () => {
  const all = listOperations();

  it("exposes `score` on both MCP transports", () => {
    for (const adapter of ["mcp_http", "mcp_stdio"] as const) {
      const names = exposedOperations(adapter, all).map((operation) => operation.name);
      expect(names, `score must be reachable from ${adapter}`).toContain("score");
    }
  });

  it("waives the six folded verbs off both MCP transports", () => {
    // Six, not seven: `list_runs` keeps its own MCP exposure. It is the
    // route from an item id to a runId, and every other scoring action
    // requires one — `tests/run-listing-db.test.ts` pins that it stays
    // reachable on every adapter, and folding it away would remove the
    // front door to scoring while leaving the rest of the tool useless.
    const folded = [
      "score_run",
      "derive_run_score",
      "accept_run_score",
      "get_run_scores",
      "score_intervention",
      "get_intervention_scores",
    ];
    for (const adapter of ["mcp_http", "mcp_stdio"] as const) {
      const names = exposedOperations(adapter, all).map((operation) => operation.name);
      for (const operation of folded) {
        expect(names, `${operation} should be folded away on ${adapter}`).not.toContain(operation);
      }
      expect(names, `list_runs stays reachable from ${adapter}`).toContain("list_runs");
    }
  });

  it("keeps every folded verb reachable on HTTP and the command line", () => {
    // The fold is an MCP-surface change only. An operation that fell off
    // every adapter would be stranded, which two other suites assert
    // globally; this says the same thing for these seven specifically, so a
    // waiver added to the wrong adapter fails here with a clear name.
    for (const adapter of ["http", "cli"] as const) {
      const names = exposedOperations(adapter, all).map((operation) => operation.name);
      for (const operation of [
        "score_run",
        "derive_run_score",
        "accept_run_score",
        "get_run_scores",
        "list_runs",
        "score_intervention",
        "get_intervention_scores",
      ]) {
        expect(names, `${operation} must stay on ${adapter}`).toContain(operation);
      }
    }
  });

  it("records each folded verb's fold target, so advice can name the replacement", () => {
    // `describe_tool` and the advice checker both read this map. A waived
    // operation missing from it reads as simply unreachable rather than as
    // folded, and the advice checker then cannot suggest where it went.
    for (const operation of [
      "score_run",
      "derive_run_score",
      "accept_run_score",
      "get_run_scores",
      "score_intervention",
      "get_intervention_scores",
    ]) {
      expect(FOLDED_INTO.get(operation), `${operation} should record its fold`).toBe("score");
    }
    expect(FOLDED_INTO.has("list_runs")).toBe(false);
  });

  it("declares a required-field list for every action it accepts", () => {
    // The refusal sentence is built from this table, so an action missing
    // from it would refuse nothing and a field missing from it would be
    // advertised as optional while the delegate refused it.
    for (const action of SCORE_ACTIONS) {
      expect(SCORE_ACTION_FIELDS[action], `${action} needs a field list`).toBeDefined();
    }
  });
});

describeIfDb("the score fold, against Postgres", () => {
  const dbName = scratchDatabaseName("score_fold");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const scratch = await createMigratedScratchDatabase(testDatabaseUrl!, dbName);
    prisma = createTestPrismaClient(scratch.url);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    // Deepest first: a run_scores row points at a run, a run points at an
    // assignment and an item, and an assignment points at an item. Deleting
    // an item first is refused by the foreign keys.
    await prisma.runScore.deleteMany({});
    await prisma.$executeRawUnsafe(`DELETE FROM "intervention_scores"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "intervention_events"`);
    await prisma.run.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  const call = <T>(name: string, input: unknown): Promise<T> =>
    runtime.call(name as never, input, { caller: { actor: "tester" } }) as Promise<T>;

  let counter = 0;
  async function seedItem(): Promise<string> {
    counter += 1;
    const id = `score-fold-item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Item ${counter}`,
        body: "seeded for the score fold tests",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

  /**
   * Seeds an item, an assignment and a run, returning the run's id.
   *
   * A `Run` needs an `Assignment`, which needs an `Item`, so scoring
   * anything means building the whole chain. The item declares no
   * difficulty, so `assertFacetsDeclared` finds nothing declared and lets
   * any facet through — which keeps these tests about the fold's forwarding
   * rather than about the declaration rule, which `score_run` owns and
   * tests itself.
   */
  async function seedRun(): Promise<string> {
    const itemId = await seedItem();
    counter += 1;
    const assignmentId = `score-fold-assignment-${counter}`;
    await prisma.assignment.create({
      data: {
        id: assignmentId,
        itemId,
        role: "builder" as never,
        holderType: "agent" as never,
        holderId: "agent-a",
        sessionId: `sess-score-${counter}`,
        rootSessionId: `sess-score-${counter}`,
        machine: "calliope",
      },
    });
    const runId = `score-fold-run-${counter}`;
    await prisma.run.create({
      data: {
        id: runId,
        itemId,
        assignmentId,
        sessionId: `sess-score-${counter}`,
        model: "opus",
        effort: "high",
      },
    });
    return runId;
  }

  describe("each action reaches the operation it folds", () => {
    it("`list` reads runs for an item, the same as list_runs", async () => {
      const itemId = await seedItem();
      const folded = await call<{ runs: unknown[] }>("score", { action: "list", itemId });
      const direct = await call<{ runs: unknown[] }>("list_runs", { itemId });
      // Same handler, same input, so the payloads are equal rather than
      // merely similar. A branch wired to the wrong delegate fails here.
      expect(folded).toEqual(direct);
    });

    it("`runs` reads the aggregate, the same as get_run_scores", async () => {
      const folded = await call("score", { action: "runs" });
      const direct = await call("get_run_scores", {});
      expect(folded).toEqual(direct);
    });

    it("`interventions` reads the intervention aggregate", async () => {
      const folded = await call("score", { action: "interventions" });
      const direct = await call("get_intervention_scores", {});
      expect(folded).toEqual(direct);
    });
  });

  describe("a missing required field is refused by name, per action", () => {
    it("names `runId` when `derive` is called without one", async () => {
      const error = await rejection(call("score", { action: "derive" }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("runId");
      // The sentence has to name the action too: the same field is required
      // by four actions and optional for two, so "runId is required" alone
      // would not tell a caller which call it just got wrong.
      expect(error.message).toContain("derive");
      expect(error.message).toContain("runId");
    });

    it("names every missing field at once, rather than one per round trip", async () => {
      const error = await rejection(call("score", { action: "run" }));
      expect(error.fields).toEqual(expect.arrayContaining(["runId", "raterType", "facets"]));
    });

    it("names `eventId` and `score` for an intervention rating", async () => {
      const error = await rejection(call("score", { action: "intervention" }));
      expect(error.fields).toEqual(expect.arrayContaining(["eventId", "score", "raterType"]));
    });

    it("refuses an action the tool does not have", async () => {
      const error = await rejection(call("score", { action: "obliterate" }));
      expect(error.code).toBe("invalid_input");
    });

    it("refuses a field no action declares, rather than ignoring it", async () => {
      // The schema is `.strict()`, so a typo is refused rather than
      // silently dropped — the same property the CLI's pass-through relies
      // on the operation schema for.
      const error = await rejection(call("score", { action: "runs", nonsense: 1 }));
      expect(error.code).toBe("invalid_input");
    });
  });

  describe("optional fields survive the fold rather than being dropped", () => {
    /** Seeds a firing to rate, returning its id. */
    async function seedFiring(): Promise<string> {
      const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
        `INSERT INTO "intervention_events"
           ("entry_id", "session_id", "outcome", "level", "phase")
         VALUES ('test-entry', 'sess-score-fold', 'nudged'::"InterventionOutcome", 'info', 'pre')
         RETURNING "id"`,
      );
      return String(rows[0]!.id);
    }

    // ── The forwarding case a shape assertion cannot reach ──────────────
    //
    // `raterId` is optional, so dropping it from a branch does not refuse
    // anything — the write succeeds and is answered with a success, which
    // is the same silent-loss shape the CLI's pass-through rule exists for.
    // What makes it observable is that `rater_id` is part of the
    // `intervention_scores` conflict target: two raters produce two rows,
    // but if the fold drops the field both collapse onto the sentinel and
    // the second overwrites the first.
    it("keeps `raterId` on an intervention rating, so two raters stay two rows", async () => {
      const eventId = await seedFiring();

      await call("score", {
        action: "intervention",
        eventId,
        score: 2,
        raterType: "person",
        raterId: "ope",
        note: "right detection, unclear wording",
      });
      await call("score", {
        action: "intervention",
        eventId,
        score: 4,
        raterType: "person",
        raterId: "someone-else",
      });

      const rows = await prisma.$queryRawUnsafe<{ rater_id: string; score: number }[]>(
        `SELECT "rater_id", "score" FROM "intervention_scores" WHERE "event_id" = $1::bigint ORDER BY "rater_id"`,
        eventId,
      );
      // Breaks the moment the fold stops forwarding `raterId`: both writes
      // then land on the empty-string sentinel, the second updates the
      // first, and this reads one row instead of two.
      expect(rows.map((row) => row.rater_id)).toEqual(["ope", "someone-else"]);
      expect(rows.map((row) => row.score)).toEqual([2, 4]);
    });

    it("keeps `note` on an intervention rating, and reads it back", async () => {
      const eventId = await seedFiring();
      await call("score", {
        action: "intervention",
        eventId,
        score: 1,
        raterType: "agent",
        raterId: "sess-9",
        note: "fired on a session it did not apply to",
      });

      const rows = await prisma.$queryRawUnsafe<{ note: string | null }[]>(
        `SELECT "note" FROM "intervention_scores" WHERE "event_id" = $1::bigint`,
        eventId,
      );
      expect(rows[0]?.note).toBe("fired on a session it did not apply to");
    });

    it("leaves an absent optional absent, so the delegate's own default applies", async () => {
      const eventId = await seedFiring();
      await call("score", { action: "intervention", eventId, score: 3, raterType: "agent" });

      const rows = await prisma.$queryRawUnsafe<{ rater_id: string; note: string | null }[]>(
        `SELECT "rater_id", "note" FROM "intervention_scores" WHERE "event_id" = $1::bigint`,
        eventId,
      );
      // The operation turns an absent rater into the empty-string sentinel
      // itself. The fold must not send `raterId: null` or `""` on its
      // behalf — that would be the fold restating a rule that belongs to
      // the operation, and the two could then drift.
      expect(rows[0]?.rater_id).toBe("");
      expect(rows[0]?.note).toBeNull();
    });
  });

  describe("`run` — the write verb, end to end", () => {
    // ── The regression this file failed to catch the first time ─────────
    //
    // The fold forwarded the caller's `facets` under that name, while
    // `score_run` declares the field as `scores`. Its schema is `.strict()`,
    // so every `run` call was refused twice over — `scores` reported
    // missing, `facets` reported unrecognised — and the fold's PRIMARY WRITE
    // VERB did not work at all.
    //
    // Nothing here caught it, because the only `run` case asserted a
    // REFUSAL. It passed for the wrong reason: the key was unrecognised
    // whatever it contained, so the assertion held whether the shape was
    // wrong or the name was. The lesson is the one this file's header
    // already states and I applied to `raterId` and not to this: a fold's
    // forwarding is proved by a call that SUCCEEDS and a value read back,
    // never by one that is refused.
    it("records a score, which requires the field to arrive under the delegate's name", async () => {
      const runId = await seedRun();

      const result = await call<{
        scored: readonly { facet: string; agentScore: number | null }[];
      }>("score", {
        action: "run",
        runId,
        raterType: "agent",
        facets: [
          { facet: "reasoning", score: 4 },
          { facet: "precision", score: 5 },
        ],
      });

      // Breaks the moment the fold forwards under the wrong name again:
      // `score_run` is `.strict()`, so the call is refused rather than
      // returning this.
      expect(result.scored.map((entry) => entry.facet).sort()).toEqual(["precision", "reasoning"]);
    });

    it("writes the scores it was given, read back from the store", async () => {
      const runId = await seedRun();
      await call("score", {
        action: "run",
        runId,
        raterType: "agent",
        facets: [{ facet: "reasoning", score: 3 }],
      });

      const rows = await prisma.runScore.findMany({ where: { runId } });
      // The value, not merely the shape. A fold that forwarded an empty
      // array, or the right array under a right-looking name that the
      // delegate ignored, would not produce this row.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.facet).toBe("reasoning");
      expect(rows[0]?.agentScore).toBe(3);
    });

    it("carries `raterId` through on a person's score", async () => {
      const runId = await seedRun();
      await call("score", {
        action: "run",
        runId,
        raterType: "person",
        raterId: "ope",
        facets: [{ facet: "reasoning", score: 2 }],
      });

      const rows = await prisma.runScore.findMany({ where: { runId } });
      expect(rows[0]?.userScoredBy).toBe("ope");
    });
  });

  describe("the two fields called `facets` are kept apart", () => {
    it("refuses `run` given the name-list shape `accept` takes", async () => {
      // `score_run` wants `[{facet, score}]`; `accept_run_score` wants
      // `["code"]`. One field carrying both shapes would send the wrong one
      // to whichever action the caller did not mean, so the fold gives them
      // separate names and lets each delegate's schema refuse the other.
      //
      // **Asserted on the FIELD the refusal names, not merely on the code.**
      // Checking `invalid_input` alone passed while `run` was broken for an
      // entirely unrelated reason — an unrecognised key refuses with the
      // same code as a badly-shaped one. Naming `scores` is what makes this
      // about the shape rather than about the plumbing, and the seeded run
      // means the call gets far enough for the shape to be what fails.
      const runId = await seedRun();
      const error = await rejection(
        call("score", {
          action: "run",
          runId,
          raterType: "agent",
          facets: ["reasoning"],
        }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.fields?.some((field) => field.startsWith("scores"))).toBe(true);
    });

    it("keeps `accept`'s name list separate from `run`'s objects", async () => {
      // The other half: `acceptFacets` is a distinct field, so the two
      // shapes cannot be sent to the wrong delegate.
      const runId = await seedRun();
      await call("score", {
        action: "run",
        runId,
        raterType: "agent",
        facets: [{ facet: "reasoning", score: 4 }],
      });

      const accepted = await call<{ accepted: readonly { facet: string }[] }>("score", {
        action: "accept",
        runId,
        raterId: "ope",
        acceptFacets: ["reasoning"],
      });
      expect(accepted.accepted.map((entry) => entry.facet)).toEqual(["reasoning"]);
    });
  });
});
