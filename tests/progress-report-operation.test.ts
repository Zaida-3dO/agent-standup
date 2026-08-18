// `progress_report` against a real Postgres — MILESTONES.md #136.
//
// The shape itself is proved in `tests/progress-report-shape.test.ts`, which
// needs no database. What needs one is the half this file is for: that the
// report is assembled from facts the server already holds, and assembled
// *honestly*. The row asks for a PR link and a dependency-graph blocker, and
// the schema has neither — so the assertions below pin what the report does
// instead, because an undocumented substitution is the thing most likely to
// be quietly replaced later by a fabricated one.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem } from "@/lib/claims";
import { MAX_FLAGS_PER_ROW } from "@/lib/service/operations/progress-report";
import type { ProgressReport } from "@/lib/progress-report";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { registerSessions } from "./helpers/register-sessions";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("progress_report against Postgres", () => {
  const dbName = scratchDatabaseName("progress_report");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  let seq = 0;

  /** An item, claimed by `sessionId`, so it appears in that session's report. */
  async function heldItem(
    sessionId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    seq += 1;
    const item = (await runtime.call("create_task", {
      title: `Report subject number ${seq}`,
      body: "x",
      area: "reporting",
      originType: "auto",
      projectId: "inbox",
      ...overrides,
    })) as { id: string };

    await registerSessions(prisma, [sessionId]);
    await prisma.$transaction((tx) =>
      claimItem(tx, {
        itemId: item.id,
        role: "builder",
        holderType: "agent",
        holderId: sessionId,
        sessionId,
        rootSessionId: sessionId,
        machine: "test-machine",
      }),
    );
    return item.id;
  }

  async function report(sessionId: string, input: Record<string, unknown> = {}) {
    return (await runtime.call("progress_report", { sessionId, ...input })) as ProgressReport;
  }

  it("gives a session holding nothing an empty report rather than a refusal", async () => {
    // Holding nothing is a real answer to "how is it going". Fails if the
    // operation ever refuses an idle session, which would make the report
    // unusable as the thing you ask constantly.
    const result = await report("session-empty");
    expect(result.rows).toEqual([]);
    expect(result.summary).toBe("Nothing claimed by this session.");
    expect(result.report).toBe("Nothing claimed by this session.");
  });

  it("refuses an empty sessionId", async () => {
    const error = await runtime.call("progress_report", { sessionId: "" }).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("invalid_input");
  });

  it("reports only what this session holds, not another session's work", async () => {
    // The report is session-scoped, which is the property that makes the
    // numbering local and the summary meaningful. Fails if the query stops
    // filtering on sessionId.
    await heldItem("session-mine");
    await heldItem("session-theirs");

    const mine = await report("session-mine");
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]?.title).toContain("Report subject");
  });

  it("drops an item once its claim is released", async () => {
    // Fails if `releasedAt IS NULL` is dropped from the query — a session
    // would accumulate every item it had ever touched, and the report's
    // headline count would grow without anything being in flight.
    const sessionId = "session-released";
    const itemId = await heldItem(sessionId);
    await prisma.assignment.updateMany({
      where: { itemId, sessionId },
      data: { releasedAt: new Date() },
    });
    expect((await report(sessionId)).rows).toEqual([]);
  });

  it("numbers rows from one, in claim order", async () => {
    const sessionId = "session-numbering";
    await heldItem(sessionId);
    await heldItem(sessionId);
    await heldItem(sessionId);

    const result = await report(sessionId);
    expect(result.rows.map((r) => r.n)).toEqual([1, 2, 3]);
  });

  it("lists one row per item, which the one-live-row-per-session index guarantees", async () => {
    // Worth pinning because the opposite is easy to assume: several sessions
    // work one item at once (SCHEMA.md §2), so an item-keyed join would
    // duplicate. This join is keyed on one session, and
    // `Assignment_one_live_row_per_session_per_item` makes one live row per
    // session per item a database-level fact — so the report needs no
    // deduplication, and a second claim by the same session is refused rather
    // than producing a duplicate row.
    const sessionId = "session-two-roles";
    const itemId = await heldItem(sessionId);

    const conflict = await prisma
      .$transaction((tx) =>
        claimItem(tx, {
          itemId,
          role: "reviewer",
          holderType: "agent",
          holderId: sessionId,
          sessionId,
          rootSessionId: sessionId,
          machine: "test-machine",
        }),
      )
      .catch((e: unknown) => e);
    expect((conflict as { code?: string }).code).toBe("conflict");

    const result = await report(sessionId);
    expect(result.rows).toHaveLength(1);
    expect(result.summary).toContain("1 item");
  });

  describe("the reference, given no PR field exists", () => {
    it("uses the branch when the item has one", async () => {
      const sessionId = "session-branch";
      await heldItem(sessionId);
      await prisma.item.updateMany({
        where: { area: "reporting", branch: null },
        data: { branch: "feat/some-branch" },
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.reference.branch).toBe("feat/some-branch");
      expect(result.report).toContain("`feat/some-branch`");
    });

    it("falls back to the item id, so a row is never unactionable", async () => {
      // Fails if the fallback is dropped: a branchless row would render a
      // reference a reader cannot use, which is worse than a plain id.
      const sessionId = "session-no-branch";
      const itemId = await heldItem(sessionId);
      const result = await report(sessionId);
      expect(result.rows[0]?.reference.branch).toBeNull();
      expect(result.report).toContain(`\`${itemId}\``);
    });
  });

  describe("blocked-on, given no dependency graph exists", () => {
    it("reports the reason and type the item itself records", async () => {
      const sessionId = "session-blocked";
      const itemId = await heldItem(sessionId);
      await prisma.item.update({
        where: { id: itemId },
        data: {
          state: "blocked",
          blockedReason: "a decision from the owner",
          blockedOnType: "person",
        },
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.blockedOn).toContain("a decision from the owner");
      expect(result.rows[0]?.blockedOn).toContain("person");
    });

    it("reports a pause with the condition that would resume it", async () => {
      // A paused item is stopped and waiting too, and `resumeCondition` is
      // the nearest thing the schema has to "what it is waiting for". Fails
      // if only `blocked` is handled and a paused row reads as unblocked.
      const sessionId = "session-paused";
      const itemId = await heldItem(sessionId);
      await prisma.item.update({
        where: { id: itemId },
        data: {
          state: "paused",
          pauseReason: "waiting on an upstream release",
          resumeCondition: "the release ships",
        },
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.blockedOn).toContain("waiting on an upstream release");
      expect(result.rows[0]?.blockedOn).toContain("the release ships");
    });

    it("leaves blockedOn null for work that is simply proceeding", async () => {
      const sessionId = "session-unblocked";
      await heldItem(sessionId);
      const result = await report(sessionId);
      expect(result.rows[0]?.blockedOn).toBeNull();
      expect(result.report).not.toContain("Blocked on");
    });
  });

  describe("the bullets, read from what sessions already recorded", () => {
    it("uses a checkpoint headline as the row's first bullet", async () => {
      // The bullets are derived rather than authored — that is the variance
      // the row exists to remove. Fails if the checkpoint lookup is dropped
      // and every row falls back to its state.
      const sessionId = "session-checkpoint";
      const itemId = await heldItem(sessionId);

      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        headline: "Initial review found issues and returned it to the builder.",
        body: "Longer prose about the round.",
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.bullets[0]).toBe(
        "Initial review found issues and returned it to the builder.",
      );
    });

    it("takes the NEWEST checkpoint, not the first one written", async () => {
      // Two checkpoints, deliberately. A single-checkpoint case cannot tell
      // newest from oldest — it passes just as happily against `ORDER BY id
      // ASC`, which was how this ordering originally shipped unpinned. The
      // ordering is what the report's whole "where is this up to" claim
      // rests on: an item that has moved three times would otherwise be
      // described by the state it was in first.
      const sessionId = "session-checkpoint-order";
      const itemId = await heldItem(sessionId);

      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        headline: "The oldest checkpoint on this item.",
        body: "Written first.",
      });
      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        headline: "The newest checkpoint on this item.",
        body: "Written second.",
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.bullets[0]).toBe("The newest checkpoint on this item.");
    });

    it("says so plainly when no checkpoint has been recorded", async () => {
      // The fallback exists so a row is never blank. Fails if a row with no
      // checkpoint renders zero bullets, which would break the fixed shape.
      const sessionId = "session-no-checkpoint";
      await heldItem(sessionId);
      const result = await report(sessionId);
      expect(result.rows[0]?.bullets).toHaveLength(1);
      expect(result.rows[0]?.bullets[0]).toContain("No checkpoint recorded yet");
    });

    it("counts open subtasks as what is left", async () => {
      const sessionId = "session-children";
      const parentId = await heldItem(sessionId);
      for (const title of ["First remaining piece", "Second remaining piece"]) {
        await runtime.call("create_subtask", {
          title,
          body: "x",
          area: "reporting",
          originType: "auto",
          taskId: parentId,
        });
      }

      const result = await report(sessionId);
      expect(result.rows[0]?.bullets.join(" ")).toContain("2 open subtasks remaining");
    });

    it("does not count a finished subtask as remaining", async () => {
      // Fails if the child count stops excluding terminal states — a report
      // would keep claiming work is left after it all landed.
      const sessionId = "session-children-done";
      const parentId = await heldItem(sessionId);
      const child = (await runtime.call("create_subtask", {
        title: "A finished piece of work",
        body: "x",
        area: "reporting",
        originType: "auto",
        taskId: parentId,
      })) as { id: string };
      await prisma.item.update({ where: { id: child.id }, data: { state: "merged" } });

      const result = await report(sessionId);
      expect(result.rows[0]?.bullets.join(" ")).not.toContain("remaining");
    });
  });

  describe("the flags, which are the open loops", () => {
    it("surfaces an open loop as a sub-bullet", async () => {
      // This is the line the format exists for — the owner's example carries
      // "the decision was controversial, option B is still viable". A loop is
      // where a session already records exactly that.
      const sessionId = "session-loops";
      const itemId = await heldItem(sessionId);
      await runtime.call("loop_add", {
        itemId,
        sessionId,
        loopId: "loop-option-b",
        text: "Went with option A to unblock; option B is still viable.",
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.flags).toContain(
        "Went with option A to unblock; option B is still viable.",
      );
      expect(result.report).toContain("  - Went with option A to unblock");
    });

    it("drops a loop once it is closed", async () => {
      // Fails if the fold is replaced by "every open_loop event" — closed
      // loops would pile up as flags and bury the live ones.
      const sessionId = "session-loops-closed";
      const itemId = await heldItem(sessionId);
      await runtime.call("loop_add", {
        itemId,
        sessionId,
        loopId: "loop-settled",
        text: "A question that has since been answered.",
      });
      await runtime.call("loop_close", { itemId, sessionId, loopId: "loop-settled" });

      const result = await report(sessionId);
      expect(result.rows[0]?.flags).toEqual([]);
    });

    it("caps flags per row, because sparingly is the point", async () => {
      // The seeded count and the expected ceiling are **literals**, not
      // `MAX_FLAGS_PER_ROW`. Deriving both from the constant makes the
      // assertion move with it: raising the cap to 99 would then still pass,
      // which is precisely the mutation this test exists to catch. Proved by
      // mutating the source rather than by inspection — a derived expectation
      // survived that mutant, these literals do not.
      //
      // The constant is asserted separately below, so a deliberate change to
      // the cap fails here loudly and is corrected in one obvious place.
      const sessionId = "session-many-loops";
      const itemId = await heldItem(sessionId);
      for (let i = 0; i < 5; i += 1) {
        await runtime.call("loop_add", {
          itemId,
          sessionId,
          loopId: `loop-${i}`,
          text: `A loose end numbered ${i}.`,
        });
      }

      const result = await report(sessionId);
      expect(result.rows[0]?.flags).toHaveLength(2);
    });

    it("keeps the cap at the value the report is designed around", async () => {
      // Guards the literals above: if the cap is deliberately changed, this
      // says so in one line rather than leaving the count assertion looking
      // like an unrelated failure.
      expect(MAX_FLAGS_PER_ROW).toBe(2);
    });
  });

  describe("completed work", () => {
    it("omits finished work from the list but still counts it", async () => {
      // The default answers "what is being worked on", and the summary keeps
      // the finished work visible so nothing disappears silently. Fails if
      // the filter also removed it from the count.
      const sessionId = "session-completed";
      const open = await heldItem(sessionId);
      const done = await heldItem(sessionId);
      await prisma.item.update({ where: { id: done }, data: { state: "merged" } });

      const result = await report(sessionId);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.itemId).toBe(open);
      expect(result.summary).toContain("1 done");
    });

    it("lists finished work when it is asked for explicitly", async () => {
      const sessionId = "session-completed-included";
      await heldItem(sessionId);
      const done = await heldItem(sessionId);
      await prisma.item.update({ where: { id: done }, data: { state: "merged" } });

      const result = await report(sessionId, { includeCompleted: true });
      expect(result.rows).toHaveLength(2);
    });

    it("renumbers after filtering, so the list runs 1..n with no gaps", async () => {
      // A number is a handle for conversation ("what's the story on 3?"), and
      // a list skipping from 2 to 5 invites the wrong question. Fails if the
      // filter keeps the pre-filter numbering.
      const sessionId = "session-renumber";
      await heldItem(sessionId);
      const done = await heldItem(sessionId);
      await prisma.item.update({ where: { id: done }, data: { state: "merged" } });
      await heldItem(sessionId);

      const result = await report(sessionId);
      expect(result.rows.map((r) => r.n)).toEqual([1, 2]);
    });
  });

  it("returns the rendered report beside the rows it was built from", async () => {
    // Both halves travel together on purpose: a caller wanting its own view
    // has the data, and a caller wanting the report does not have to build
    // one. Fails if either is dropped.
    const sessionId = "session-both-halves";
    await heldItem(sessionId);

    const result = await report(sessionId);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.report).toContain(result.summary);
    expect(result.report).toContain(result.rows[0]!.title);
  });
});
