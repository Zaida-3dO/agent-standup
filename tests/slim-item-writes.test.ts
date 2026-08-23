// The write path returns the slim shape by default — MILESTONES.md #107's
// convention, carried across from the reads.
//
// PR #224 bounded the reads and made slim their default. The **writes** were
// not in that audit, so a successful write kept echoing the complete record
// — `body` and `customFields` included — for changing one enum field.
// Measured on a live store: four `transition_item` calls and two
// `update_item` calls returned roughly 20,000 characters of body text the
// caller had authored minutes earlier.
//
// ── What would make this file hollow, stated first so it can be checked ──
//
//   1. **Asserting presence rather than absence.** A slim response contains
//      `id`, `title` and `state` — but so does the thirty-column one this
//      row exists to stop shipping, so an assertion of that shape passes
//      against exactly the bug. Every load-bearing assertion below is
//      therefore about `body`/`customFields` being **absent**, and about
//      `full: true` **restoring** them.
//   2. **Measuring the object rather than the wire.** What lands in a
//      caller's context is the serialised form, so the size assertions
//      measure `JSON.stringify(...).length` — the same thing
//      `response-size.ts` measures — not a key count.
//   3. **A ratio loose enough to pass on a full response.** The floors below
//      are order-of-magnitude (20x), not a few percent. A write that
//      quietly returned the whole record would fail them by a wide margin
//      rather than squeaking under.
//   4. **Testing only the service layer.** An opt-in that exists in the
//      service but not on the surface an agent calls is not an opt-in for
//      the agents it exists to help, so `describe_tool` is asserted to
//      advertise `full` on each write it applies to.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { toItemWriteRecord, type ItemRecord } from "@/lib/service/items/row";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** The two columns that were the overwhelming majority of the measured payload. */
const HEAVY_FIELDS = ["body", "customFields"] as const;

/** The identity fields a write's response must keep, so a caller can confirm the right row moved. */
const IDENTITY_FIELDS = ["id", "title", "state"] as const;

/**
 * The ceiling a slim write response must stay under.
 *
 * Chosen against the *shape*, not the measurement: the slim shape is five
 * short scalars, so a few hundred characters is generous for any realistic
 * title and headline while being a small fraction of the ~20,000 characters
 * a single measured `transition_item` returned. A write that regressed to
 * echoing a real brief would blow through this immediately.
 */
const SLIM_WRITE_CEILING = 1_000;

/** The size of a response as a caller actually receives it — the serialised form. */
function wireSize(value: unknown): number {
  return JSON.stringify(value).length;
}

describe("narrowing a record to what a write returns", () => {
  // The pure half, which runs with or without a database. `toItemWriteRecord`
  // is the single function every slimmed write goes through, so its
  // behaviour is worth pinning independently of any one operation's wiring.
  const record = {
    id: "item-1",
    title: "A title",
    state: "executing",
    headline: "One line",
    body: "b".repeat(20_000),
    customFields: { brief: "c".repeat(20_000) },
    updatedAt: "2026-08-23T00:00:00.000Z",
    priority: "P1",
    area: "an-area",
  } as unknown as ItemRecord;

  it("keeps the identity fields a caller needs to confirm the right row moved", () => {
    const slim = toItemWriteRecord(record);
    expect(slim.id).toBe("item-1");
    expect(slim.title).toBe("A title");
    expect(slim.state).toBe("executing");
  });

  it("keeps the headline, so the cheap response still says what the work is", () => {
    expect(toItemWriteRecord(record).headline).toBe("One line");
  });

  it("keeps updatedAt, which is what makes the response a receipt", () => {
    expect(toItemWriteRecord(record).updatedAt).toBe("2026-08-23T00:00:00.000Z");
  });

  // THE assertion of this describe block: absence, not presence.
  it("drops the heavy fields entirely rather than truncating them", () => {
    const slim = toItemWriteRecord(record) as unknown as Record<string, unknown>;
    for (const field of HEAVY_FIELDS) {
      expect(slim).not.toHaveProperty(field);
    }
  });

  it("drops every field beyond the five it names, so the shape cannot grow by accident", () => {
    expect(Object.keys(toItemWriteRecord(record)).sort()).toEqual([
      "headline",
      "id",
      "state",
      "title",
      "updatedAt",
    ]);
  });

  it("is an order of magnitude smaller than what it narrowed", () => {
    expect(wireSize(record)).toBeGreaterThan(wireSize(toItemWriteRecord(record)) * 20);
  });

  // A null headline is a real value the reads distinguish ("nobody has
  // written one"), so it must survive rather than being dropped as falsy —
  // a caller cannot tell a dropped key from an absent headline.
  it("carries a null headline through rather than dropping the key", () => {
    const slim = toItemWriteRecord({ ...record, headline: null } as ItemRecord);
    expect(slim).toHaveProperty("headline");
    expect(slim.headline).toBeNull();
  });
});

describeIfDb("the slim write against Postgres", () => {
  const dbName = scratchDatabaseName("slim_writes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  /** The project every heavy fixture below hangs off, so each one is a task. */
  let parentProjectId: string;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    parentProjectId = (
      (await runtime.call("create_item", {
        title: "Parent project for the slim-write fixtures",
        body: "Holds the tasks these cases transition.",
        area: "slim-writes",
        originType: "auto",
      })) as unknown as { id: string }
    ).id;
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (scratchUrl) await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /**
   * A big **task** — a realistic brief and a realistic custom-field bag, as
   * the measured case had.
   *
   * Created under a parent on purpose. A parentless item is a *project*,
   * whose state is derived from its children (DECISIONS.md §13c) and which
   * therefore cannot be transitioned at all — so a fixture without a parent
   * would make every transition case here fail on the wrong thing.
   */
  async function makeHeavyItem(overrides: Record<string, unknown> = {}) {
    return (await runtime.call("create_item", {
      title: "A heavy item",
      headline: "One line about the heavy item",
      body: "b".repeat(20_000),
      area: "slim-writes",
      originType: "auto",
      customFields: { brief: "c".repeat(20_000) },
      parentId: parentProjectId,
      ...overrides,
    })) as unknown as { id: string };
  }

  describe("transition_item", () => {
    it("returns the slim item and the outcome, with nothing heavy, by default", async () => {
      const created = await makeHeavyItem();
      const result = (await runtime.call("transition_item", {
        id: created.id,
        to: "planning",
      })) as unknown as { item: Record<string, unknown>; outcome: Record<string, unknown> };

      for (const field of IDENTITY_FIELDS) {
        expect(result.item).toHaveProperty(field);
      }
      expect(result.item.state).toBe("planning");
      // The assertion that fails if the default regresses.
      for (const field of HEAVY_FIELDS) {
        expect(result.item).not.toHaveProperty(field);
      }
      // The outcome was already compact and must stay beside the item.
      expect(result.outcome.to).toBe("planning");
      expect(result.outcome.allowed).toBe(true);
    });

    // The size pin this row asks for, on the operation it was measured on.
    it("answers a state change in a few hundred characters, not twenty thousand", async () => {
      const created = await makeHeavyItem();
      const result = await runtime.call("transition_item", { id: created.id, to: "planning" });
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    it("is an order of magnitude smaller than the same call with full", async () => {
      const slimItem = await makeHeavyItem();
      const fullItem = await makeHeavyItem();
      const slim = await runtime.call("transition_item", { id: slimItem.id, to: "planning" });
      const full = await runtime.call("transition_item", {
        id: fullItem.id,
        to: "planning",
        full: true,
      });
      expect(wireSize(full)).toBeGreaterThan(wireSize(slim) * 20);
    });

    it("restores every heavy field when full is passed", async () => {
      const created = await makeHeavyItem();
      const result = (await runtime.call("transition_item", {
        id: created.id,
        to: "planning",
        full: true,
      })) as unknown as { item: Record<string, unknown> };
      for (const field of HEAVY_FIELDS) {
        expect(result.item).toHaveProperty(field);
      }
      expect(result.item.body).toHaveLength(20_000);
    });

    // Not in scope to make the refusals quieter — this is the proof that
    // slimming the success path left the rejection path alone.
    it("still refuses an illegal move, and the refusal is unchanged", async () => {
      const created = await makeHeavyItem();
      await expect(
        runtime.call("transition_item", { id: created.id, to: "merged" }),
      ).rejects.toBeDefined();
    });
  });

  describe("update_item", () => {
    it("returns the slim record by default, with nothing heavy", async () => {
      const created = await makeHeavyItem();
      const result = (await runtime.call("update_item", {
        id: created.id,
        priority: "P0",
      })) as unknown as Record<string, unknown>;

      for (const field of IDENTITY_FIELDS) {
        expect(result).toHaveProperty(field);
      }
      for (const field of HEAVY_FIELDS) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it("answers a one-field edit in a few hundred characters", async () => {
      const created = await makeHeavyItem();
      const result = await runtime.call("update_item", { id: created.id, priority: "P0" });
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    // The sharpest case of all: a caller that has just *sent* a 20,000
    // character body should not be charged for reading it back.
    it("does not echo a body the caller just sent", async () => {
      const created = await makeHeavyItem();
      const result = (await runtime.call("update_item", {
        id: created.id,
        body: "d".repeat(20_000),
      })) as unknown as Record<string, unknown>;
      expect(result).not.toHaveProperty("body");
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    // The two no-op paths return early, before the main return — they are
    // the calls most likely to be made in a loop, and the easiest to miss.
    it("stays slim on a no-op patch, which returns down an earlier path", async () => {
      const created = await makeHeavyItem();
      const result = (await runtime.call("update_item", {
        id: created.id,
        title: "A heavy item",
      })) as unknown as Record<string, unknown>;
      for (const field of HEAVY_FIELDS) {
        expect(result).not.toHaveProperty(field);
      }
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    it("restores every heavy field when full is passed", async () => {
      const created = await makeHeavyItem();
      const result = (await runtime.call("update_item", {
        id: created.id,
        priority: "P0",
        full: true,
      })) as unknown as Record<string, unknown>;
      for (const field of HEAVY_FIELDS) {
        expect(result).toHaveProperty(field);
      }
      expect(result.body).toHaveLength(20_000);
    });

    // `full` is a response-shaping flag, not an editable column. If it ever
    // leaked into the field-change diff it would write a phantom ledger
    // entry for a field the item does not have.
    it("does not record full as an edited field", async () => {
      const created = await makeHeavyItem();
      await runtime.call("update_item", { id: created.id, priority: "P0", full: true });
      const events = await prisma.event.findMany({ where: { itemId: created.id } });
      const changed = events.flatMap((event) => {
        const payload = event.payload as { field?: unknown } | null;
        return typeof payload?.field === "string" ? [payload.field] : [];
      });
      expect(changed).not.toContain("full");
    });
  });

  describe("complete_item", () => {
    /**
     * A valid `wont_do` summary. Closing as `wont_do` requires a `decision`
     * and an EMPTY `shipped` — nothing was delivered, so the reasoning goes
     * in `decision` instead. That refusal is correct and out of scope here;
     * this fixture satisfies it rather than working around it.
     */
    const WONT_DO_SUMMARY = {
      shipped: [],
      not_done: [],
      user_facing: false,
      how_verified: "Nothing was built, so there was nothing to verify.",
      watch_for: [],
      decision: "Withdrawn: this fixture exists only to reach a completed state.",
    };

    /** Drives an item to `in_review`, the state a completion is reached from. */
    async function readyToComplete() {
      const created = await makeHeavyItem();
      await runtime.call("transition_item", { id: created.id, to: "planning" });
      return created;
    }

    it("returns the slim item, with nothing heavy, by default", async () => {
      const created = await readyToComplete();
      const result = (await runtime.call("complete_item", {
        id: created.id,
        to: "wont_do",
        summary: WONT_DO_SUMMARY,
      })) as unknown as { item: Record<string, unknown> };

      for (const field of IDENTITY_FIELDS) {
        expect(result.item).toHaveProperty(field);
      }
      for (const field of HEAVY_FIELDS) {
        expect(result.item).not.toHaveProperty(field);
      }
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    it("restores every heavy field when full is passed", async () => {
      const created = await readyToComplete();
      const result = (await runtime.call("complete_item", {
        id: created.id,
        to: "wont_do",
        full: true,
        summary: WONT_DO_SUMMARY,
      })) as unknown as { item: Record<string, unknown> };
      for (const field of HEAVY_FIELDS) {
        expect(result.item).toHaveProperty(field);
      }
      expect(result.item.body).toHaveLength(20_000);
    });
  });

  // -- The two writes #231's audit classified as "already compact" ---------
  //
  // They were not. Both return whatever `applyMove` hands back, which is the
  // whole row: measured at 40,775 (`reparent_item`) and 40,780
  // (`retype_to_task`) characters against an item carrying a 20,000-char
  // `body` and an equally large `customFields` -- twice the ~20,000 that
  // motivated the original row, and with no flag to opt out of.
  //
  // Reparenting is where this bites hardest, because emptying a project is
  // one call per child. The cases below therefore pin the per-call shape AND
  // the bulk case, since the bulk case is the reason the row exists.
  describe("reparent_item", () => {
    /** A fresh destination project, so no case depends on another's leftovers. */
    async function destination(title: string) {
      return (await runtime.call("create_item", {
        title,
        body: "Somewhere to move things to.",
        area: "slim-writes",
        originType: "auto",
      })) as unknown as { id: string };
    }

    it("returns the slim record by default, with nothing heavy", async () => {
      const created = await makeHeavyItem();
      const to = await destination("Reparent destination");
      const result = (await runtime.call("reparent_item", {
        id: created.id,
        parentId: to.id,
      })) as unknown as Record<string, unknown>;

      for (const field of IDENTITY_FIELDS) {
        expect(result).toHaveProperty(field);
      }
      // THE assertion: absence, not presence. A truncated `body` would still
      // satisfy a presence check on `id`/`title`/`state`.
      for (const field of HEAVY_FIELDS) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it("answers a move in a few hundred characters, not forty thousand", async () => {
      const created = await makeHeavyItem();
      const to = await destination("Reparent size destination");
      const result = await runtime.call("reparent_item", { id: created.id, parentId: to.id });
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    it("is an order of magnitude smaller than the same call with full", async () => {
      const slimItem = await makeHeavyItem();
      const fullItem = await makeHeavyItem();
      const to = await destination("Reparent ratio destination");
      const slim = await runtime.call("reparent_item", { id: slimItem.id, parentId: to.id });
      const full = await runtime.call("reparent_item", {
        id: fullItem.id,
        parentId: to.id,
        full: true,
      });
      expect(wireSize(full)).toBeGreaterThan(wireSize(slim) * 20);
    });

    it("restores every heavy field when full is passed", async () => {
      const created = await makeHeavyItem();
      const to = await destination("Reparent full destination");
      const result = (await runtime.call("reparent_item", {
        id: created.id,
        parentId: to.id,
        full: true,
      })) as unknown as Record<string, unknown>;
      for (const field of HEAVY_FIELDS) {
        expect(result).toHaveProperty(field);
      }
      expect(result.body).toHaveLength(20_000);
    });

    // The `parentId: null` branch returns down a *different* path -- it never
    // resolves a parent -- so slimming the main return alone would leave this
    // one echoing the whole record. Same trap as `update_item`'s no-op paths.
    it("stays slim on the parentId: null branch, which returns down an earlier path", async () => {
      const created = await makeHeavyItem();
      const result = (await runtime.call("reparent_item", {
        id: created.id,
        parentId: null,
      })) as unknown as Record<string, unknown>;
      for (const field of HEAVY_FIELDS) {
        expect(result).not.toHaveProperty(field);
      }
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    // The `"inbox"` sentinel resolves its parent through a different function
    // before reaching the same return, so it is exercised rather than assumed
    // to be covered by the named-parent case.
    it("stays slim when the parent is resolved from the inbox sentinel", async () => {
      const created = await makeHeavyItem();
      const result = (await runtime.call("reparent_item", {
        id: created.id,
        parentId: "inbox",
      })) as unknown as Record<string, unknown>;
      for (const field of HEAVY_FIELDS) {
        expect(result).not.toHaveProperty(field);
      }
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    // The bulk case the parent row describes, asserted as one number rather
    // than per call: emptying a project of heavily-briefed children used to
    // cost ~40k characters *per child*.
    it("keeps emptying a project cheap across every child moved", async () => {
      const from = await destination("Bulk source");
      const to = await destination("Bulk destination");
      const children = [
        await makeHeavyItem({ parentId: from.id, title: "Bulk child one" }),
        await makeHeavyItem({ parentId: from.id, title: "Bulk child two" }),
        await makeHeavyItem({ parentId: from.id, title: "Bulk child three" }),
      ];

      let total = 0;
      for (const child of children) {
        total += wireSize(await runtime.call("reparent_item", { id: child.id, parentId: to.id }));
      }

      // Three moves. At the measured ~40,775 characters per unslimmed move,
      // the same loop costs ~122,000 characters.
      expect(total).toBeLessThan(SLIM_WRITE_CEILING * children.length);
    });

    // Slimming the success path must not have touched the refusals; a move
    // under the item itself is still refused.
    it("still refuses a move under the item itself, and the refusal is unchanged", async () => {
      const created = await makeHeavyItem();
      await expect(
        runtime.call("reparent_item", { id: created.id, parentId: created.id }),
      ).rejects.toBeDefined();
    });
  });

  describe("retype_to_task", () => {
    /**
     * A childless **project** -- what a retype needs. Parentless on purpose:
     * that is what makes it a project, and a project with no children is the
     * stuck row `retype_to_task` exists to rescue.
     */
    async function makeHeavyProject(title: string) {
      return (await runtime.call("create_item", {
        title,
        headline: "One line about the stuck project",
        body: "b".repeat(20_000),
        area: "slim-writes",
        originType: "auto",
        customFields: { brief: "c".repeat(20_000) },
      })) as unknown as { id: string };
    }

    it("returns the slim record by default, with nothing heavy", async () => {
      const stuck = await makeHeavyProject("Stuck, slim");
      const result = (await runtime.call("retype_to_task", {
        id: stuck.id,
        projectId: parentProjectId,
      })) as unknown as Record<string, unknown>;

      for (const field of IDENTITY_FIELDS) {
        expect(result).toHaveProperty(field);
      }
      for (const field of HEAVY_FIELDS) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it("answers a retype in a few hundred characters, not forty thousand", async () => {
      const stuck = await makeHeavyProject("Stuck, sized");
      const result = await runtime.call("retype_to_task", {
        id: stuck.id,
        projectId: parentProjectId,
      });
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    it("is an order of magnitude smaller than the same call with full", async () => {
      const slimProject = await makeHeavyProject("Stuck, ratio slim");
      const fullProject = await makeHeavyProject("Stuck, ratio full");
      const slim = await runtime.call("retype_to_task", {
        id: slimProject.id,
        projectId: parentProjectId,
      });
      const full = await runtime.call("retype_to_task", {
        id: fullProject.id,
        projectId: parentProjectId,
        full: true,
      });
      expect(wireSize(full)).toBeGreaterThan(wireSize(slim) * 20);
    });

    it("restores every heavy field when full is passed", async () => {
      const stuck = await makeHeavyProject("Stuck, full");
      const result = (await runtime.call("retype_to_task", {
        id: stuck.id,
        projectId: parentProjectId,
        full: true,
      })) as unknown as Record<string, unknown>;
      for (const field of HEAVY_FIELDS) {
        expect(result).toHaveProperty(field);
      }
      expect(result.body).toHaveLength(20_000);
    });

    it("stays slim when the parent is resolved from the inbox sentinel", async () => {
      const stuck = await makeHeavyProject("Stuck, inbox-bound");
      const result = (await runtime.call("retype_to_task", {
        id: stuck.id,
        projectId: "inbox",
      })) as unknown as Record<string, unknown>;
      for (const field of HEAVY_FIELDS) {
        expect(result).not.toHaveProperty(field);
      }
      expect(wireSize(result)).toBeLessThan(SLIM_WRITE_CEILING);
    });

    // The guard that refuses a project with children is the operation's
    // whole reason for existing beside `reparent_item`; slimming must not
    // have quietened it.
    it("still refuses a project that has children, and the refusal is unchanged", async () => {
      const parent = await makeHeavyProject("Stuck, has a child");
      await makeHeavyItem({ parentId: parent.id, title: "In the way" });
      await expect(
        runtime.call("retype_to_task", { id: parent.id, projectId: parentProjectId }),
      ).rejects.toBeDefined();
    });
  });

  // Acceptance #4. `describe_tool` derives its field list from each
  // operation's own input schema, so this asserts the flag reached the
  // surface an agent actually reads rather than only the service layer.
  describe("describe_tool advertises the flag", () => {
    for (const tool of [
      "transition_item",
      "update_item",
      "complete_item",
      "reparent_item",
      "retype_to_task",
    ] as const) {
      it(`names full among ${tool}'s fields`, async () => {
        const contract = (await runtime.call("describe_tool", { tool })) as unknown as {
          fields: { name: string }[];
        };
        expect(contract.fields.map((field) => field.name)).toContain("full");
      });
    }

    // The negative control: a write with no record to echo never grew the
    // flag, so this proves the assertion above is discriminating rather
    // than passing on every tool.
    it("does not name full on a write that never returned a record", async () => {
      const contract = (await runtime.call("describe_tool", { tool: "note" })) as unknown as {
        fields: { name: string }[];
      };
      expect(contract.fields.map((field) => field.name)).not.toContain("full");
    });
  });
});
