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
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem } from "@/lib/claims";
import { MAX_FLAGS_PER_ROW } from "@/lib/service/operations/progress-report";
import { MAX_FLAGS_PER_REPORT } from "@/lib/progress-report";
import type { ToolContract } from "@/lib/service/operations/describe-tool";
import type { ProgressReport } from "@/lib/progress-report";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { registerSessions } from "./helpers/register-sessions";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("progress_report against Postgres", () => {
  const dbName = scratchDatabaseName("progress_report");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
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

  describe("the reference, and the link it will not fabricate", () => {
    /** Records a `pull_request` artifact on `itemId`, as a crew opening one would. */
    async function recordPr(itemId: string, ref: string, body?: string): Promise<void> {
      await runtime.call("record_artifact", {
        itemId,
        kind: "pull_request",
        ref,
        ...(body === undefined ? {} : { body }),
        createdByType: "agent",
        createdById: "a-crew-session",
      });
    }

    it("links to the PR when one has been recorded and is open", async () => {
      // The half of the row that makes it actionable. Fails if the artifact
      // lookup is dropped and a row with a live PR renders only its branch.
      const sessionId = "session-pr-open";
      const itemId = await heldItem(sessionId);
      await prisma.item.update({ where: { id: itemId }, data: { branch: "feat/linked" } });
      await recordPr(itemId, "https://example.com/org/repo/pull/12");

      const result = await report(sessionId);
      expect(result.rows[0]?.reference.prUrl).toBe("https://example.com/org/repo/pull/12");
      expect(result.report).toContain("[`feat/linked`](https://example.com/org/repo/pull/12)");
    });

    it("emits NO link when no PR was ever opened", async () => {
      // The never-opened case. This is the one a composed URL would get
      // wrong, and it is why the URL is recorded rather than derived: the
      // branch is present here exactly as it is on the row above. Fails if
      // the report ever starts composing a link from repo + branch.
      const sessionId = "session-pr-never";
      const itemId = await heldItem(sessionId);
      await prisma.item.update({ where: { id: itemId }, data: { branch: "feat/no-pr" } });

      const result = await report(sessionId);
      expect(result.rows[0]?.reference.prUrl).toBeNull();
      expect(result.report).toContain("`feat/no-pr`");
      expect(result.report).not.toContain("](");
    });

    it("stops linking once the PR is recorded as closed", async () => {
      // The closed case, and the reason closure is a NEWER row rather than an
      // edit: artifacts are append-only. Fails if the report reads any
      // `pull_request` row rather than the newest, which would keep linking
      // to a PR that has closed — the dead link the format forbids.
      const sessionId = "session-pr-closed";
      const itemId = await heldItem(sessionId);
      await prisma.item.update({ where: { id: itemId }, data: { branch: "feat/closed" } });
      await recordPr(itemId, "https://example.com/org/repo/pull/13");
      await recordPr(itemId, "https://example.com/org/repo/pull/13", "closed");

      const result = await report(sessionId);
      expect(result.rows[0]?.reference.prUrl).toBeNull();
      expect(result.report).not.toContain("](");
    });

    it("links again when a closed PR is superseded by a newly opened one", async () => {
      // Re-proposed work. Proves the read really is newest-wins rather than
      // "closed anywhere means never link" — fails if closure is treated as
      // a permanent property of the item instead of the state of a row.
      const sessionId = "session-pr-reopened";
      const itemId = await heldItem(sessionId);
      await recordPr(itemId, "https://example.com/org/repo/pull/14");
      await recordPr(itemId, "https://example.com/org/repo/pull/14", "closed");
      await recordPr(itemId, "https://example.com/org/repo/pull/15", "open");

      const result = await report(sessionId);
      expect(result.rows[0]?.reference.prUrl).toBe("https://example.com/org/repo/pull/15");
    });

    it("resolves a same-millisecond open/closed tie to CLOSED, not to a coin flip", async () => {
      // The tie that `createdAt DESC, id DESC` alone could not settle.
      // `createdAt` is Timestamptz(3), so two back-to-back writes really do
      // share a millisecond, and `Artifact.id` is a random uuid — so before
      // the status term in the ORDER BY, an open/closed pair at one
      // timestamp linked to the CLOSED row about half the time.
      //
      // The timestamps are forced equal rather than raced, so this fails
      // deterministically rather than 51% of the time. Fails if the CASE
      // term is dropped from the query: the winner then depends on which
      // uuid sorts higher, which is why the assertion below is run against
      // BOTH id orderings.
      const sessionId = "session-pr-tie-closed";
      const itemId = await heldItem(sessionId);
      await prisma.item.update({ where: { id: itemId }, data: { branch: "feat/tie" } });
      await recordPr(itemId, "https://example.com/org/repo/pull/20");
      await recordPr(itemId, "https://example.com/org/repo/pull/20", "closed");

      const tied = new Date("2026-01-01T00:00:00.000Z");
      await prisma.artifact.updateMany({
        where: { itemId, kind: "pull_request" },
        data: { createdAt: tied },
      });

      // Both rows now sit on the identical millisecond. Whichever uuid is
      // larger, the closed row has to win.
      const result = await report(sessionId);
      expect(result.rows[0]?.reference.prUrl).toBeNull();
      expect(result.report).not.toContain("](");
      expect(result.report).toContain("`feat/tie`");
    });

    it("keeps the link when BOTH tied rows say open, so the tiebreak is not just 'never link'", async () => {
      // The other half, and the one that stops the fix being overfitted: a
      // tie is resolved pessimistically only when the rows actually
      // disagree. Two `open` rows at one millisecond still link.
      //
      // Fails if the CASE term is written to suppress links on any tie, or
      // if `closed` and `open` are ranked the wrong way round such that the
      // ordering stops distinguishing them at all.
      const sessionId = "session-pr-tie-open";
      const itemId = await heldItem(sessionId);
      await recordPr(itemId, "https://example.com/org/repo/pull/21");
      await recordPr(itemId, "https://example.com/org/repo/pull/21", "open");

      await prisma.artifact.updateMany({
        where: { itemId, kind: "pull_request" },
        data: { createdAt: new Date("2026-01-01T00:00:00.000Z") },
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.reference.prUrl).toBe("https://example.com/org/repo/pull/21");
    });

    it("still takes a strictly newer open row over an older closed one", async () => {
      // The tiebreak must only apply WITHIN a millisecond. A closed row that
      // is genuinely older must not outrank a later re-open, or re-proposed
      // work would permanently lose its link.
      //
      // Fails if the status term is placed BEFORE `createdAt` in the ORDER
      // BY — the ordering error that would make `closed` sticky forever.
      const sessionId = "session-pr-tie-ordering";
      const itemId = await heldItem(sessionId);
      await recordPr(itemId, "https://example.com/org/repo/pull/22", "closed");
      await prisma.artifact.updateMany({
        where: { itemId, kind: "pull_request" },
        data: { createdAt: new Date("2026-01-01T00:00:00.000Z") },
      });
      await recordPr(itemId, "https://example.com/org/repo/pull/23", "open");
      await prisma.artifact.updateMany({
        where: { itemId, kind: "pull_request", ref: "https://example.com/org/repo/pull/23" },
        data: { createdAt: new Date("2026-01-02T00:00:00.000Z") },
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.reference.prUrl).toBe("https://example.com/org/repo/pull/23");
    });

    it("refuses a pull_request artifact that records no URL", async () => {
      // The write-side half of the promise: the report cannot render a link
      // it was never given, so the only way a link exists is a recorded URL.
      const itemId = await heldItem("session-pr-refuse-null");
      const error = await runtime
        .call("record_artifact", {
          itemId,
          kind: "pull_request",
          createdByType: "agent",
          createdById: "a-crew-session",
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields?: string[] }).fields).toContain("ref");
      // The MESSAGE, not just the code: the URL-scheme guard below also
      // refuses this call and also names `ref`, so asserting only the code
      // would pass with this guard deleted — the mutant that proved it. A
      // caller who omitted the field needs to be told the field is missing,
      // not that its (absent) value is the wrong scheme.
      expect((error as { message: string }).message).toContain("must record the PR's URL");
    });

    it("refuses a pull_request artifact whose ref is not an http(s) URL", async () => {
      // `ref` is a generic column shared with screenshots, so a path or a
      // bare PR number is a realistic value — and a markdown link to a
      // `javascript:` target is an injection into whatever renders the
      // report. Fails if the URL check is dropped from the write.
      const itemId = await heldItem("session-pr-refuse-scheme");
      for (const ref of ["javascript:alert(1)", "not a url", "/org/repo/pull/9"]) {
        const error = await runtime
          .call("record_artifact", {
            itemId,
            kind: "pull_request",
            ref,
            createdByType: "agent",
            createdById: "a-crew-session",
          })
          .catch((e: unknown) => e);
        expect((error as { code: string }).code, ref).toBe("invalid_input");
      }
    });

    it("refuses a pull_request status it does not recognise", async () => {
      // Coercing unrecognised prose to `open` is how a closed PR keeps
      // rendering as a live link — "closed by review" would read as open.
      // Fails if the status vocabulary stops being enforced at the write.
      const itemId = await heldItem("session-pr-refuse-status");
      const error = await runtime
        .call("record_artifact", {
          itemId,
          kind: "pull_request",
          ref: "https://example.com/p/1",
          body: "closed by review",
          createdByType: "agent",
          createdById: "a-crew-session",
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields?: string[] }).fields).toContain("body");
    });

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

    it("drops a loop once it is deleted", async () => {
      // A deleted loop must vanish from EVERY read that surfaces loops, and
      // this report is one of them. It shipped broken: the query here sliced
      // only `open_loop`/`open_loop_closed` while the fold understood four
      // types, so a retracted loop kept being flagged as live work.
      //
      // Killed by narrowing `loopEventsForMany`'s `IN` list back to two
      // labels — which is exactly the mutation that reached main, and which
      // the whole DB suite tolerated because nothing asserted this.
      const sessionId = "session-loops-deleted";
      const itemId = await heldItem(sessionId);
      await runtime.call("loop_add", {
        itemId,
        sessionId,
        loopId: "loop-mistaken",
        text: "A loose end recorded against the wrong item.",
      });
      await runtime.call("loop_delete", {
        itemId,
        sessionId,
        loopId: "loop-mistaken",
        reason: "a duplicate of the loop on the sibling task",
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.flags).toEqual([]);
      expect(result.report).not.toContain("recorded against the wrong item");
    });

    it("holds a note out of the flags, and keeps one blocked on a person in", async () => {
      // The counting fix, on the surface that was missing it. This report is
      // read to judge how much is still outstanding, so a flag list padded
      // with references and status markers overstates the work left — which
      // is the whole harm the kind exists to fix.
      //
      // Both halves are asserted in one case because they are one decision:
      // the rule is `countsAsWork`, not "only work counts". A loop waiting on
      // a human is the most pending thing an item can carry, so dropping it
      // would misreport in the opposite direction and would be just as wrong.
      //
      // Killed by deleting this operation's `countsAsWork` filter — the
      // note reappears as a flag; and by weakening that filter to
      // `kind === "work"` — the blocked-on-person loop vanishes. Nothing
      // else in the suite caught either mutation.
      const sessionId = "session-loops-kind";
      const itemId = await heldItem(sessionId);
      await runtime.call("loop_add", {
        itemId,
        sessionId,
        loopId: "loop-a-note",
        kind: "note",
        text: "The rollout runbook lives in the deploy guide.",
      });
      await runtime.call("loop_add", {
        itemId,
        sessionId,
        loopId: "loop-awaiting-answer",
        kind: "blocked_on_person",
        text: "Waiting on a decision about the retention window.",
      });

      const result = await report(sessionId);
      expect(result.rows[0]?.flags).toEqual(["Waiting on a decision about the retention window."]);
      expect(result.report).not.toContain("rollout runbook");
    });

    it("flags an edited loop with its current wording, not the original", async () => {
      // The other half of the same defect: a two-type slice cannot see the
      // edit, so the report serves text the loop does not carry. Killed by
      // the same narrowing — the assertion pins the exact flag list, so a
      // fold returning both wordings fails too.
      const sessionId = "session-loops-edited";
      const itemId = await heldItem(sessionId);
      await runtime.call("loop_add", {
        itemId,
        sessionId,
        loopId: "loop-refined",
        text: "The retry path is untested.",
      });
      await runtime.call("loop_edit", {
        itemId,
        sessionId,
        loopId: "loop-refined",
        text: "The retry path is untested on a cold boot.",
      });

      const result = await report(sessionId);
      // `toEqual` on the whole array, not `toContain`: the edited wording has
      // the original as a prefix, so an absence assertion on that substring
      // would be vacuous. Exact equality is what proves the superseded
      // wording is not also present as a second flag.
      expect(result.rows[0]?.flags).toEqual(["The retry path is untested on a cold boot."]);
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

    it("budgets flags across the whole report, not merely per row", async () => {
      // "Sparingly" is a property of the REPORT. Three rows carrying two
      // flags each satisfies every per-row cap and still leaves six flags,
      // at which point nothing stands out and the one row that needs a
      // person reads like the two that do not.
      //
      // The seeded counts and the expected total are LITERALS, for the same
      // reason the per-row case spells its numbers out: deriving them from
      // MAX_FLAGS_PER_REPORT makes the assertion move with the constant, so
      // raising the cap would still pass. Fails if the budget is ever
      // applied per row instead of per report.
      const sessionId = "session-report-budget";
      for (let item = 0; item < 3; item += 1) {
        const itemId = await heldItem(sessionId);
        for (let i = 0; i < 2; i += 1) {
          await runtime.call("loop_add", {
            itemId,
            sessionId,
            loopId: `budget-${item}-${i}`,
            text: `A loose end on item ${item}, number ${i}.`,
          });
        }
      }

      const result = await report(sessionId);
      const total = result.rows.reduce((sum, r) => sum + r.flags.length, 0);
      expect(total).toBe(3);
      // And the earliest-claimed rows are the ones that kept them.
      expect(result.rows[0]?.flags).toHaveLength(2);
      expect(result.rows[1]?.flags).toHaveLength(1);
      expect(result.rows[2]?.flags).toHaveLength(0);
    });

    it("says at the foot how many flags it withheld", async () => {
      // Truncation is announced, never silent — a quietly dropped flag is
      // worse than one too many, because the report is trusted without
      // audit. Fails if the withheld count stops reaching the renderer.
      const sessionId = "session-budget-footer";
      const itemId = await heldItem(sessionId);
      for (let i = 0; i < 5; i += 1) {
        await runtime.call("loop_add", {
          itemId,
          sessionId,
          loopId: `footer-${i}`,
          text: `A loose end numbered ${i}.`,
        });
      }

      const result = await report(sessionId);
      // Two survive the per-row cap of 2, which is inside the report budget
      // of 3 — so the three withheld are the ones the ROW cap dropped.
      expect(result.rows[0]?.flags).toHaveLength(2);
      expect(result.report).toContain("3 further flags withheld");
      expect(result.report).toContain("open_loops");
    });

    it("spends the budget on listed rows, not on ones the filter dropped", async () => {
      // Completed work is filtered out of the list; if it had already spent
      // the budget, the in-flight rows the reader asked about would lose
      // flags to rows they cannot see, and the footer would explain a
      // truncation with no visible cause. Fails if the budget is applied
      // before the completed filter.
      const sessionId = "session-budget-after-filter";
      const done = await heldItem(sessionId);
      const open = await heldItem(sessionId);
      for (const [itemId, tag] of [
        [done, "done"],
        [open, "open"],
      ] as const) {
        for (let i = 0; i < 2; i += 1) {
          await runtime.call("loop_add", {
            itemId,
            sessionId,
            loopId: `filter-${tag}-${i}`,
            text: `A loose end on the ${tag} item, number ${i}.`,
          });
        }
      }
      await prisma.item.update({ where: { id: done }, data: { state: "merged" } });

      const result = await report(sessionId);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.itemId).toBe(open);
      // Both of the open item's flags survive: the merged row is not listed,
      // so it spends nothing.
      expect(result.rows[0]?.flags).toHaveLength(2);
      expect(result.report).not.toContain("withheld");
    });
  });

  describe("what describe_tool tells a caller about the budget", () => {
    it("states both caps, so sparingly is discoverable rather than folklore", async () => {
      // The brief's requirement, asserted where a caller would actually read
      // it. A cap nobody is told about is one every caller discovers by
      // having their flag silently dropped. Fails if the rule is removed or
      // stops naming the numbers.
      const contract = (await runtime.call("describe_tool", {
        tool: "progress_report",
      })) as ToolContract;

      const flagRule = contract.rules.find((r) => r.rule.includes("Sub-bullets"));
      expect(flagRule).toBeDefined();
      expect(flagRule!.rule).toContain(String(MAX_FLAGS_PER_ROW));
      expect(flagRule!.rule).toContain(String(MAX_FLAGS_PER_REPORT));
      // And it says how to raise one, since flags are not authored here.
      // Spelled as the folded tool's action rather than `loop_add`, which is
      // waived off MCP — the rule has to name a call the reader can make.
      expect(flagRule!.rule).toContain('action: "add"');
      expect(flagRule!.rule).not.toContain("loop_add");
    });

    it("states that a PR link is recorded, never composed", async () => {
      // The rule a caller needs in order to GET a link at all — without it,
      // the feature looks broken to every crew that never records one.
      const contract = (await runtime.call("describe_tool", {
        tool: "progress_report",
      })) as ToolContract;

      const refRule = contract.rules.find((r) => r.rule.includes("pull request"));
      expect(refRule).toBeDefined();
      expect(refRule!.rule).toContain("pull_request");
      expect(refRule!.rule).toContain("record_artifact");
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
