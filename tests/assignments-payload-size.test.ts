// The size question T3 has to answer honestly: `get_board` has already
// overflowed a context window once, so adding a field to every card is
// exactly the change that must not quietly reinflate it.
//
// This measures the serialized response over a board shaped like a real one
// and asserts a **ceiling on the added share**, not a fixed byte count — a
// byte count would be a snapshot that breaks on any unrelated field and
// tells a reader nothing about whether the addition was affordable.
//
// **What would make this hollow.** Asserting the response is "not too big"
// against a board of three cards proves nothing. So the corpus is sized
// like the one #123 measured, most cards are held (the expensive case, not
// the average one), and the assertion is on the *ratio* of ownership bytes
// to the whole response.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem } from "@/lib/claims";
import type { BoardOutput } from "@/lib/service/operations/get-board";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** How many cards. Sized to a real in-progress column, not a toy one. */
const CARDS = 68;
/** How many of them are held. Deliberately most — the expensive case. */
const HELD = 60;

describeIfDb("ownership does not reinflate the board response", () => {
  const dbName = scratchDatabaseName("assignments_payload");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  const AREA = "payload-tests";

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      AREA,
    );
    for (let i = 0; i < CARDS; i++) {
      const id = `payload-${i}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Item" ("id", "kind", "title", "body", "state", "priority", "area", "originType", "driveMode", "mergeAuthority", "createdAt", "updatedAt")
         VALUES ($1, 'task'::"ItemKind", $2, $3, 'executing'::"ItemState", 'P2'::"Priority", $4, 'auto'::"OriginType", 'autonomous'::"DriveMode", 'agent_judgement'::"MergeAuthority", now(), now())`,
        id,
        // A realistic title and a realistic body, because the added share is
        // measured against the rest of the card and a card of empty strings
        // would flatter the result.
        `A piece of work with a title of about the length a real one has (${i})`,
        "A body of the length an imported brief has. ".repeat(40),
        AREA,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        id,
        AREA,
      );
      if (i < HELD) {
        await prisma.$transaction((tx) =>
          claimItem(tx, {
            itemId: id,
            role: "builder",
            holderType: "agent",
            holderId: `a-crew-name-${i}`,
            sessionId: `payload-session-${i}`,
            machine: "desktop",
            branch: "feat/a-branch-name-of-realistic-length",
            worktree: "/a/path/to/a/worktree/of/realistic/length",
            model: "a-model-identifier",
            effort: "medium",
            pid: 10000 + i,
          }),
        );
      }
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function board(): Promise<BoardOutput> {
    return (await runtime.call("get_board", {
      column: "in_progress",
      limit: 200,
    })) as BoardOutput;
  }

  /** The response as an adapter would send it — what a caller actually pays for. */
  function bytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }

  it("adds a bounded, measured share — and the slim shape is what keeps it bounded", async () => {
    // The honest measurement: the whole response with ownership, against the
    // same response with the field stripped — which is byte-for-byte what
    // the read returned before this change, because nothing else moved.
    const withOwnership = await board();
    const entries = withOwnership.columns.in_progress.entries;
    expect(entries.length).toBe(CARDS);
    // The corpus really is mostly held, or the measurement is of the cheap
    // case rather than the expensive one.
    expect(entries.filter((e) => e.assignments.length > 0)).toHaveLength(HELD);

    const withoutOwnership = {
      ...withOwnership,
      columns: {
        ...withOwnership.columns,
        in_progress: {
          ...withOwnership.columns.in_progress,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          entries: entries.map(({ assignments, ...rest }) => rest),
        },
      },
    };

    const after = bytes(withOwnership);
    const before = bytes(withoutOwnership);
    const addedShare = (after - before) / before;

    // The same response as it would be with the **full** shape per card —
    // the alternative that was actually on the table. Measured rather than
    // asserted about, because "slim matters" is a claim with a number behind
    // it and the number is the argument.
    const asFullShape = {
      ...withOwnership,
      columns: {
        ...withOwnership.columns,
        in_progress: {
          ...withOwnership.columns.in_progress,
          entries: entries.map((entry) => ({
            ...entry,
            assignments: entry.assignments.map((a) => ({
              ...a,
              id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
              machine: "desktop",
              branch: "feat/a-branch-name-of-realistic-length",
              worktree: "/a/path/to/a/worktree/of/realistic/length",
              model: "a-model-identifier",
              effort: "medium",
              sessionId: "a-session-identifier",
              rootSessionId: "a-session-identifier",
              pid: 10000,
              claimedAt: a.lastActive,
              releasedAt: null,
            })),
          })),
        },
      },
    };
    const full = bytes(asFullShape);

    // Reported rather than merely asserted, so a run of this file prints the
    // numbers a reviewer would otherwise have to take on trust.
    console.log(
      `get_board payload over ${CARDS} cards (${HELD} held): before=${before}B after=${after}B ` +
        `added=${after - before}B (+${(addedShare * 100).toFixed(1)}%) — ` +
        `the full shape would have been ${full}B (+${(((full - before) / before) * 100).toFixed(1)}%)`,
    );

    // **This is a real increase and the bound says so.** A slim board card
    // carries no `body` and no `customFields` (#107), so it is only a few
    // hundred bytes — which makes seven ownership fields a large *relative*
    // add even though it is small in absolute terms. Stating the honest
    // ceiling is worth more than a flattering one: a reader of this number
    // should know the board grew by about half on a mostly-held column.
    //
    // Breaks if: the board is switched to the full assignment shape — that
    // is roughly three times the slim cost per held card and lands well past
    // this bound. That is the regression this ceiling exists to catch, and
    // the `full` figure above is what it is being kept away from.
    expect(addedShare).toBeLessThan(0.7);
    // And the slim shape is decisively cheaper than the full one, which is
    // the whole reason there are two shapes. A mutant that pointed the board
    // at the full form would collapse this.
    expect(full - before).toBeGreaterThan((after - before) * 2);
  }, 120_000);

  it("costs an unheld card almost nothing", async () => {
    // The empty array is 18 bytes of `"assignments":[]` per card. Stated as
    // a bound so "the field is free when nobody holds the item" is a checked
    // claim rather than an assumption — a board of mostly-unheld backlog is
    // the common case.
    const result = await board();
    const unheld = result.columns.in_progress.entries.filter((e) => e.assignments.length === 0);
    expect(unheld.length).toBe(CARDS - HELD);
    for (const entry of unheld) {
      expect(bytes(entry.assignments)).toBeLessThanOrEqual(2);
    }
  }, 60_000);
});
