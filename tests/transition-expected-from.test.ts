// `transition_item`'s optimistic-concurrency precondition — `expectedFrom`.
//
// The condition this exists for: `applyTransition` re-reads the item's state
// inside its own transaction, but an unconditional call never tells it what
// state the *caller* believed the item was in. Absent a precondition, two
// agents moving one item resolve as last-writer-wins and neither is told.
// The board is written concurrently by many sessions on many machines, so
// that is a live race rather than a theoretical one.
//
// Driven against a real Postgres, for the reason every DB-backed file here
// gives: what is claimed below is about **what actually got written** — a
// refused stale move must leave the row untouched, and no assertion on a
// returned object can settle that. Skips without TEST_DATABASE_URL.
//
// Both seams are covered deliberately, because they can fail independently:
//   - the service layer, where the precondition is evaluated;
//   - the HTTP route, where `conflict` must surface as 409 *carrying the
//     actual current state*. The status maps for free (every adapter's
//     STATUS_BY_CODE already has `conflict: 409`), but the state does not:
//     `toRejection()` excludes `details` by construction, so the route
//     asserting only on the status would pass while the body omitted the
//     one fact a caller needs to recover.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ServiceRuntime,
  isServiceError,
  guardRegistry,
  prismaTransactionRunner,
} from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { defaultSnapshot } from "@/lib/settings";
import { authenticatedRequest, stubAuthEnvironment } from "./helpers/authenticated-requests";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("transition_item expectedFrom precondition", () => {
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("transition_expected_from");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let transitionRoute: typeof import("@/app/api/items/[id]/transition/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // Set before importing the route module: `service/live.ts` builds its
    // singleton on module load, so a later assignment would be read too late.
    process.env.DATABASE_URL = scratchUrl;
    transitionRoute = await import("@/app/api/items/[id]/transition/route");
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });

    // The real production guard set, not a scratch stand-in — a precondition
    // that only held against a registry with no guards in it would prove
    // nothing about the path a real call takes.
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

  let taskCounter = 0;

  async function createTask(state = "executing"): Promise<string> {
    const id = randomUUID();
    taskCounter += 1;
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

  async function readState(itemId: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    return row.state;
  }

  async function eventsFor(itemId: string): Promise<{ type: string }[]> {
    return prisma.$queryRawUnsafe(
      `SELECT "type" FROM "Event" WHERE "itemId" = $1 ORDER BY "id" ASC`,
      itemId,
    );
  }

  function jsonRequest(url: string, body: unknown): Request {
    return authenticatedRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("AC1 — a non-matching expectedFrom is refused, naming the actual current state", () => {
    // The mutation target. Deleting the two-line precondition in
    // `state-machine/transition.ts`'s `evaluate()` turns this red: without
    // it the move is simply applied, so the call resolves instead of
    // throwing and `expect.fail` fires on the line below.
    it("throws conflict, and the refusal carries where the item actually is", async () => {
      const id = await createTask("executing");

      // The caller believes the item is still `on_deck`; it has since moved
      // to `executing`. This is the exact shape of the race: a second agent
      // acting on a copy of the board that has gone stale.
      const error = await runtime
        .call("transition_item", { id, to: "someday", expectedFrom: "on_deck" })
        .then(
          () => {
            throw new Error("expected the stale transition to be refused, but it resolved");
          },
          (thrown: unknown) => thrown,
        );

      if (!isServiceError(error)) throw new Error(`not a ServiceError: ${String(error)}`);
      expect(error.code).toBe("conflict");
      // "Naming the actual current state" is the acceptance criterion, so
      // it is asserted as a fact about the payload rather than left to the
      // message: `executing` is where the item really is.
      expect(error.details).toMatchObject({
        itemId: id,
        expectedFrom: "on_deck",
        currentState: "executing",
      });
      // And in the human-readable text too, since that is what an operator
      // reads first.
      expect(error.message).toContain("executing");
      expect(error.fields).toContain("expectedFrom");
    });

    it("leaves the row and the event ledger untouched — the refusal is not a partial write", async () => {
      const id = await createTask("executing");

      await runtime
        .call("transition_item", { id, to: "merged", expectedFrom: "on_deck" })
        .catch(() => undefined);

      expect(await readState(id)).toBe("executing");
      expect(await eventsFor(id)).toHaveLength(0);
    });

    it("refuses before the guards run, so a stale call is not answered with a guard verdict computed from an expired premise", async () => {
      // `executing -> blocked` without `blocked_reason` is rejected by
      // `state-machine.blocked_required_fields` (guard_rejected/422)
      // whenever the guards run. With a mismatched `expectedFrom` the answer
      // must be `conflict` instead: the guard set is selected by the item's
      // real `from`, so its verdict describes a move the caller did not
      // ask about, while the item's actual state is what the caller can
      // act on.
      const id = await createTask("executing");

      const error = await runtime
        .call("transition_item", { id, to: "blocked", expectedFrom: "on_deck" })
        .then(
          () => {
            throw new Error("expected a refusal");
          },
          (thrown: unknown) => thrown,
        );

      if (!isServiceError(error)) throw new Error(`not a ServiceError: ${String(error)}`);
      expect(error.code).toBe("conflict");
      expect(error.code).not.toBe("guard_rejected");
    });

    it("applies the move when expectedFrom matches — the precondition permits, it does not merely block", async () => {
      const id = await createTask("executing");

      const result = (await runtime.call("transition_item", {
        id,
        to: "someday",
        expectedFrom: "executing",
      })) as { item: { state: string }; outcome: { from: string; to: string } };

      expect(result.item.state).toBe("someday");
      expect(result.outcome.from).toBe("executing");
      expect(await readState(id)).toBe("someday");
    });

    it("is honoured on the dry_run path too — a rehearsal against an expired premise reports the conflict rather than `allowed`", async () => {
      const id = await createTask("executing");

      const error = await runtime
        .call("transition_item", { id, to: "someday", expectedFrom: "on_deck", dryRun: true })
        .then(
          () => {
            throw new Error("expected the stale rehearsal to be refused");
          },
          (thrown: unknown) => thrown,
        );

      if (!isServiceError(error)) throw new Error(`not a ServiceError: ${String(error)}`);
      expect(error.code).toBe("conflict");
      expect(await readState(id)).toBe("executing");
    });
  });

  describe("AC2 — a call omitting expectedFrom applies unconditionally", () => {
    it("moves the item with no precondition supplied, from a state no caller declared", async () => {
      const id = await createTask("executing");

      const result = (await runtime.call("transition_item", { id, to: "someday" })) as {
        item: { state: string };
      };

      expect(result.item.state).toBe("someday");
      expect(await readState(id)).toBe("someday");
    });

    it("still rejects on the guards when the precondition is absent — omitting it disables the precondition, not the rest of the write path", async () => {
      const id = await createTask("executing");

      const error = await runtime.call("transition_item", { id, to: "blocked" }).then(
        () => {
          throw new Error("expected a guard rejection");
        },
        (thrown: unknown) => thrown,
      );

      if (!isServiceError(error)) throw new Error(`not a ServiceError: ${String(error)}`);
      expect(error.code).toBe("guard_rejected");
      expect(await readState(id)).toBe("executing");
    });
  });

  describe("AC1 over HTTP — the route answers 409 with the current state in the body", () => {
    it("returns 409 and a body naming the actual current state", async () => {
      const id = await createTask("executing");

      const response = await transitionRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/transition`, {
          to: "someday",
          expectedFrom: "on_deck",
        }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(409);
      const payload = (await response.json()) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };
      expect(payload.error.code).toBe("conflict");
      // The status alone is not the criterion — a 409 that does not say
      // where the item is leaves the caller unable to decide anything.
      expect(payload.error.details).toMatchObject({ currentState: "executing" });
      expect(payload.error.message).toContain("executing");
      expect(await readState(id)).toBe("executing");
    });

    it("returns 200 over HTTP when expectedFrom matches", async () => {
      const id = await createTask("executing");

      const response = await transitionRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/transition`, {
          to: "someday",
          expectedFrom: "executing",
        }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(200);
      expect(await readState(id)).toBe("someday");
    });

    it("returns 200 over HTTP when expectedFrom is omitted, exactly as before", async () => {
      const id = await createTask("executing");

      const response = await transitionRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/transition`, { to: "someday" }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(200);
      expect(await readState(id)).toBe("someday");
    });
  });
});
