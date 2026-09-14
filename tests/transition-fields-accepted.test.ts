// The closed accepted-key set for `fields`, and the refusal that names the
// exit — `src/lib/service/state-machine/transition-fields.ts`.
//
// **The defect this pins.** `transition_item` took `fields` as an open
// record whose own doc comment promised it was "passed straight through to
// the guard layer unchanged". Every key no guard read was therefore
// discarded in silence *while the operation answered `allowed: true`*. The
// reported call is reproduced verbatim below: `fields: {mergeAuthority:
// "pre-approved"}` returned success, and the item in that same response
// still read `needs_approval`. A second reporter hit the camelCase form of
// the same bug — `blockedReason` accepted and dropped, and then the blocked
// guard refusing because `blocked_reason` was absent, so one call made two
// contradictory statements about one field.
//
// ── What would make this file hollow, named first ──────────────────────
//
//   1. **Asserting only that a refusal happened.** "Throws" is satisfied by
//      a guard refusing for an unrelated reason, which is exactly the
//      confusion the camelCase case caused. So every rejection test asserts
//      the error *names the accepted spelling*, and the right-name-wrong-
//      state tests assert it does NOT claim the key is unknown.
//   2. **Testing the table instead of the operation.** A unit test of
//      `findRejectedTransitionFields` proves a pure function agrees with
//      itself. The acceptance-criteria tests therefore run the real
//      operations through `ServiceRuntime` against real Postgres, so what
//      is proved is what a caller receives.
//   3. **Not proving the accepted keys still work.** A check that refuses
//      unknown keys is trivially satisfiable by refusing everything, and
//      doing so would break the UI cancel button, which posts
//      `{to: "cancelled", fields: {summary}}` through this very route. The
//      positive regression tests below are the load-bearing half.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, guardRegistry, prismaTransactionRunner } from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { defaultSnapshot } from "@/lib/settings";
import {
  TRANSITION_FIELDS,
  TRANSITION_FIELD_KEYS,
  findRejectedTransitionFields,
} from "@/lib/service/state-machine/transition-fields";
import { COMPLETED_STATES } from "@/lib/service/summaries/validate";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A service error as the tests below read it. */
interface CaughtError {
  code?: string;
  message?: string;
  fields?: readonly string[];
  guard?: string;
}

describe("the accepted-key table itself", () => {
  it("declares exactly eight keys, six of which write a column", () => {
    // The count is the thing three separate derivations got wrong — nine
    // (counting an `Array.prototype.push` call as a key) and six (deriving
    // from the UPDATE statement, which drops the two keys guards read but
    // no column stores). Pinning both numbers makes either mistake fail
    // here rather than in a review.
    expect(TRANSITION_FIELD_KEYS).toEqual([
      "blocked_reason",
      "blocked_on_type",
      "blocked_on_person",
      "unblock_at",
      "pause_reason",
      "resume_condition",
      "summary",
      "merge_rationale",
    ]);
    expect(TRANSITION_FIELDS.filter((f) => f.writesColumn)).toHaveLength(6);
  });

  it("keeps `summary`'s completed-state list in step with COMPLETED_STATES", () => {
    // The one list in that module that is written out rather than derived,
    // because deriving it would make an import cycle. Checked here instead
    // of trusted — the duplication is allowed to exist only because this
    // assertion exists.
    const summarySpec = TRANSITION_FIELDS.find((f) => f.key === "summary");
    expect([...(summarySpec?.appliesTo ?? [])].sort()).toEqual([...COMPLETED_STATES].sort());
  });

  it("accepts `summary` on transition_item and refuses it on complete_item", () => {
    // The per-operation distinction, at the table level. `complete_item`
    // has a dedicated top-level `summary` and deliberately refuses one in
    // `fields`; `transition_item` is how the UI cancel button sends it. A
    // table keyed only on state could not express this, and flattening it
    // would break one or the other.
    expect(findRejectedTransitionFields({ summary: {} }, "cancelled", "transition_item")).toEqual(
      [],
    );
    const refused = findRejectedTransitionFields({ summary: {} }, "cancelled", "complete_item");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.message).toContain("top-level");
  });
});

describeIfDb("fields acceptance through the real operations", () => {
  const dbName = scratchDatabaseName("transition_fields");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    for (const guard of ALL_GUARDS) {
      if (!guardRegistry.has(guard.id)) guardRegistry.register(guard);
    }
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "Summary"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Event"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artifact"`);
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(state = "executing"): Promise<string> {
    taskCounter += 1;
    const id = `tf-task-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${taskCounter}`,
        body: "body",
        state: state as never,
        originType: "person",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function failedTransition(args: Record<string, unknown>): Promise<CaughtError> {
    return (await runtime.call("transition_item", args).catch((e: unknown) => e)) as CaughtError;
  }

  describe("AC1 — a discarded field is never reported as allowed", () => {
    it("refuses the reported call verbatim: to on_deck with fields.mergeAuthority", async () => {
      // The reported call, reproduced exactly. Without the check, this
      // answers `allowed: true` while `mergeAuthority` stays
      // `needs_approval` in the very same response body — a write that
      // reports it landed and did not.
      const id = await createTask("executing");
      const error = await failedTransition({
        id,
        to: "on_deck",
        fields: { mergeAuthority: "pre-approved" },
      });

      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["mergeAuthority"]);
      // Names the operation that actually writes it…
      expect(error.message).toContain("update_item");
      // …with the spelling that operation ACCEPTS. `update-item.ts` takes
      // the hyphenated enum member and maps it to the underscored DB form
      // internally, so a remedy saying `pre_approved` would be advice the
      // named operation refuses — the unreachable-remedy defect this whole
      // item exists to remove.
      expect(error.message).toContain("pre-approved");
      expect(error.message).not.toContain("pre_approved");
    });

    it("leaves the item untouched when it refuses", async () => {
      // The defect was a write reporting success and doing nothing. The
      // mirror failure — refusing and writing anyway — would be worse, so
      // both halves are pinned.
      const id = await createTask("executing");
      await failedTransition({ id, to: "on_deck", fields: { mergeAuthority: "pre-approved" } });

      const after = await prisma.item.findUniqueOrThrow({ where: { id } });
      expect(after.state).toBe("executing");
      expect(after.mergeAuthority).toBe("needs_approval");
    });

    it("refuses on the dry-run path too, so a rehearsal cannot disagree with the real call", async () => {
      // `dry_run` exists to report what a real call would do. Passing a bad
      // key here while the real call refuses it would be the same lie one
      // step earlier.
      const id = await createTask("executing");
      const error = await failedTransition({
        id,
        to: "on_deck",
        fields: { mergeAuthority: "pre-approved" },
        dryRun: true,
      });

      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("update_item");
    });
  });

  describe("AC2 — a misspelled key is refused with the accepted spelling named", () => {
    it("refuses camelCase blockedReason and names blocked_reason", async () => {
      // The camelCase case. Without the check, both spellings are
      // accepted and dropped, and then the blocked guard refuses for the
      // snake_case fields being missing — two contradictory answers to one
      // call, neither of which mentions the spelling that caused it.
      const id = await createTask("executing");
      const error = await failedTransition({
        id,
        to: "blocked",
        fields: { blockedReason: "waiting", blockedOnType: "person" },
      });

      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["blockedReason", "blockedOnType"]);
      expect(error.message).toContain("blocked_reason");
      expect(error.message).toContain("blocked_on_type");
      // Not the blocked guard: the point is that a mistyped key is answered
      // as a mistyped key, before any guard gets to refuse for a different
      // reason.
      expect(error.guard).toBeUndefined();
    });

    it("reports every offending key in one message, not one per round trip", async () => {
      const id = await createTask("executing");
      const error = await failedTransition({
        id,
        to: "blocked",
        fields: { blockedReason: "a", unblockAT: "b", totalNonsenseKey: "c" },
      });

      expect(error.fields).toEqual(["blockedReason", "unblockAT", "totalNonsenseKey"]);
      expect(error.message).toContain("blocked_reason");
      // The reported near-miss that a case-sensitive compare would miss.
      expect(error.message).toContain("unblock_at");
      expect(error.message).toContain("totalNonsenseKey");
    });

    it("refuses a key that resembles nothing, listing what is accepted", async () => {
      const id = await createTask("executing");
      const error = await failedTransition({
        id,
        to: "on_deck",
        fields: { totalNonsenseKey: "x" },
      });

      expect(error.code).toBe("invalid_input");
      // No suggestion invented for a key the caller was plainly not
      // reaching for — "did you mean?" pointed at the wrong key is worse
      // than no suggestion.
      expect(error.message).not.toContain("did you mean");
      expect(error.message).toContain("blocked_reason");
    });

    it("tells a right-name-wrong-state caller where the key DOES apply", async () => {
      // Distinct from both classes above: `blocked_reason` is a real,
      // correctly-spelled key. Telling this caller it does not exist would
      // send them looking for a different name that is not there.
      const id = await createTask("on_deck");
      const error = await failedTransition({
        id,
        to: "executing",
        fields: { blocked_reason: "waiting on review" },
      });

      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("blocked");
      expect(error.message).toContain("executing");
      expect(error.message).not.toContain("did you mean");
      expect(error.message).not.toContain("is not a field this transition accepts");
    });
  });

  describe("the accepted keys still work — the half that stops this becoming refuse-everything", () => {
    it("still accepts the four blocked keys and writes them", async () => {
      const id = await createTask("executing");
      await runtime.call("transition_item", {
        id,
        to: "blocked",
        fields: {
          blocked_reason: "waiting on an upstream fix",
          blocked_on_type: "time",
          unblock_at: "2027-01-01T00:00:00.000Z",
        },
      });

      const after = await prisma.item.findUniqueOrThrow({ where: { id } });
      expect(after.state).toBe("blocked");
      expect(after.blockedReason).toBe("waiting on an upstream fix");
      expect(after.blockedOnType).toBe("time");
    });

    it("still accepts the two paused keys and writes them", async () => {
      const id = await createTask("executing");
      await runtime.call("transition_item", {
        id,
        to: "paused",
        fields: { pause_reason: "parked for the week", resume_condition: "when design lands" },
      });

      const after = await prisma.item.findUniqueOrThrow({ where: { id } });
      expect(after.state).toBe("paused");
      expect(after.pauseReason).toBe("parked for the week");
      expect(after.resumeCondition).toBe("when design lands");
    });

    it("still accepts fields.summary on a cancel — the UI cancel button's exact shape", async () => {
      // `src/lib/item-detail/cancel-state.ts`'s `cancelRequestBody()` posts
      // `{to: "cancelled", fields: {summary}}` through this ordinary
      // transition route. A six-key table derived from the UPDATE statement
      // would refuse this and break a live control.
      const id = await createTask("executing");
      const result = (await runtime.call("transition_item", {
        id,
        to: "cancelled",
        fields: {
          summary: {
            shipped: [],
            not_done: [],
            user_facing: false,
            how_verified: "Not applicable — cancelled before any work started.",
            watch_for: [],
            decision: "Superseded by another item covering the same ground.",
          },
        },
      })) as { outcome: { allowed: boolean } };

      expect(result.outcome.allowed).toBe(true);
      const after = await prisma.item.findUniqueOrThrow({ where: { id } });
      expect(after.state).toBe("cancelled");
    });

    it("still accepts merge_rationale, the other key no column stores", async () => {
      // Reaches the merge guard rather than the door. Proof that the key
      // passes the accepted-set check is that the refusal, if any, comes
      // from a guard — never `invalid_input` naming the key.
      const id = await createTask("in_review");
      await prisma.item.update({
        where: { id },
        data: { mergeAuthority: "agent_judgement" as never },
      });

      const error = await failedTransition({
        id,
        to: "merged",
        fields: { merge_rationale: "Low-risk doc change, reviewed and green." },
      });

      // Whatever else the merge guards want, they must not be complaining
      // about `merge_rationale` being an unacceptable key.
      expect(error.code).not.toBe("invalid_input");
      expect(error.fields ?? []).not.toContain("merge_rationale");
    });
  });

  describe("complete_item enforces the same set, against the caller's fields only", () => {
    it("refuses an unknown key on complete_item", async () => {
      const id = await createTask("in_review");
      const error = (await runtime
        .call("complete_item", {
          id,
          to: "wont_do",
          summary: {
            shipped: [],
            not_done: [],
            user_facing: false,
            how_verified: "Not applicable — abandoned before implementation.",
            watch_for: [],
            decision: "Overtaken by events; the underlying need went away.",
          },
          fields: { mergeAuthority: "pre-approved" },
        })
        .catch((e: unknown) => e)) as CaughtError;

      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("update_item");
    });

    it("still completes normally — the injected summary is not refused as a caller key", async () => {
      // The subtlety the whole per-operation design exists for.
      // `complete_item` merges its top-level `summary` into `fields` before
      // calling `applyTransition`. Checking the MERGED record instead of
      // the caller's would refuse this operation's own injected key and
      // make every completion impossible. This test fails loudly if that
      // ordering is ever inverted.
      const id = await createTask("in_review");
      await runtime.call("complete_item", {
        id,
        to: "wont_do",
        summary: {
          shipped: [],
          not_done: [],
          user_facing: false,
          how_verified: "Not applicable — abandoned before implementation.",
          watch_for: [],
          decision: "Overtaken by events; the underlying need went away.",
        },
      });

      const after = await prisma.item.findUniqueOrThrow({ where: { id } });
      expect(after.state).toBe("wont_do");
    });
  });
});
