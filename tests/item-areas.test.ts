// An item's areas, against a real Postgres — SCHEMA.md §23.1.
//
// The behaviour under test is that an item can sit in several areas, that
// the two representations of that fact never disagree, and that filtering by
// area finds an item by ANY of its areas rather than only its primary one.
//
// Each rejection case names, in a comment above it, a single source change
// that would make it pass wrongly — so a test that cannot fail is visible as
// such rather than counted as coverage.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface Created {
  id: string;
  area: string;
  areas: string[];
  title: string;
}

interface Rejection {
  code: string;
  fields?: string[];
  guard?: string;
  message: string;
}

describeIfDb("item areas", () => {
  const dbName = scratchDatabaseName("item_areas");
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

  function base(title: string) {
    return { title, body: "The brief.", originType: "auto" as const };
  }

  async function call(name: string, input: unknown): Promise<Created> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(name, input)) as Created;
  }

  async function rejectionOf(name: string, input: unknown): Promise<Rejection> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await (runtime.call as any)(name, input).catch((e: unknown) => e);
    return error as Rejection;
  }

  /**
   * The migration's seed statement, extracted from the committed migration
   * file — the `INSERT INTO "ItemArea" ... SELECT ... FROM "Item"` at its
   * end.
   *
   * Read from disk rather than retyped so the assertions below are about the
   * migration that actually ships. A copy pasted into this file would keep
   * passing after the real one stopped seeding anything.
   */
  function seedStatement(): string {
    const sql = readFileSync(
      join(import.meta.dirname, "../prisma/migrations/20260815120000_item_areas/migration.sql"),
      "utf8",
    );
    const match = sql.match(/INSERT INTO "ItemArea"[\s\S]*?;/);
    if (!match) {
      throw new Error("The item_areas migration contains no ItemArea seed statement.");
    }
    return match[0];
  }

  /** The `ItemArea` rows for an item, read straight from the table. */
  async function linkedAreas(itemId: string): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<{ areaId: string }[]>(
      `SELECT "areaId" FROM "ItemArea" WHERE "itemId" = $1 ORDER BY "areaId"`,
      itemId,
    );
    return rows.map((row) => row.areaId);
  }

  /** The `Item.area` column — the primary area — read straight from the table. */
  async function primaryArea(itemId: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ area: string }[]>(
      `SELECT "area" FROM "Item" WHERE "id" = $1`,
      itemId,
    );
    return rows[0]!.area;
  }

  describe("resolving an area set", () => {
    it("puts an item in several areas, primary first", async () => {
      const item = await call("create_project", {
        ...base("Spans two areas"),
        areas: ["web", "infra"],
      });

      // Fails if `insertItem` stops passing the whole list to
      // `setItemAreas` — write `[resolvedArea]` instead of `resolvedAreas`
      // in create-core.ts and the second area is dropped, leaving one row.
      expect(item.areas).toEqual(["web", "infra"]);
      expect(await linkedAreas(item.id)).toEqual(["infra", "web"]);
    });

    it("keeps Item.area and ItemArea in agreement — the primary is areas[0]", async () => {
      const item = await call("create_project", {
        ...base("Primary is the first"),
        areas: ["infra", "web"],
      });

      // Fails on a single-character change in `setItemAreas`: make `primary`
      // read `areaIds[1]` and the column disagrees with the list's head
      // while the join table still holds both.
      expect(await primaryArea(item.id)).toBe("infra");
      expect(item.area).toBe("infra");
      expect(item.areas[0]).toBe("infra");
      // The join table holds the PRIMARY too, not just the extras — so a
      // reader never has to union the column and the table to get the set.
      expect(await linkedAreas(item.id)).toEqual(["infra", "web"]);
    });

    it("accepts the singular spelling and stores a one-element set", async () => {
      const item = await call("create_project", { ...base("Just one area"), area: "web" });

      expect(item.area).toBe("web");
      // Fails if the singular path stops writing the join table at all —
      // the row would exist with `Item.area` set and no `ItemArea` row,
      // which is exactly the drift the one-writer rule exists to prevent.
      expect(await linkedAreas(item.id)).toEqual(["web"]);
      expect(item.areas).toEqual(["web"]);
    });

    it("normalises each area and de-duplicates within one call", async () => {
      const item = await call("create_project", {
        ...base("Same area twice"),
        areas: ["Web Platform", "web-platform", "infra"],
      });

      // Fails if the `resolved.includes(id)` guard is dropped from
      // `resolveAreasRaw`: the two spellings both normalise to
      // `web-platform`, so without de-duplication this is three entries —
      // and the second insert would be swallowed by `ON CONFLICT DO
      // NOTHING`, leaving `areas` disagreeing with the table.
      expect(item.areas).toEqual(["web-platform", "infra"]);
      expect(await linkedAreas(item.id)).toEqual(["infra", "web-platform"]);
    });

    it("auto-creates an area that does not exist yet (SCHEMA.md §23.1)", async () => {
      const before = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Area" WHERE "id" = $1`,
        "brand-new-area",
      );
      expect(before).toHaveLength(0);

      const item = await call("create_project", {
        ...base("Names an unseen area"),
        area: "Brand New Area",
      });

      // §23.1 makes areas auto-create on first use, unlike repos: an area is
      // required on every item, so refusing an unrecognised one would be
      // friction on the most common operation in the system. Fails if
      // `resolveAreasRaw` is changed to look an area up and refuse a miss.
      expect(item.area).toBe("brand-new-area");
      const after = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Area" WHERE "id" = $1`,
        "brand-new-area",
      );
      expect(after).toHaveLength(1);
    });
  });

  describe("refusals", () => {
    // Fails if `areaSpellingCheck` in create-core.ts is dropped: with
    // neither spelling supplied the create would proceed to
    // `resolveAreasRaw([])`, or — worse, if that guard also went — insert an
    // item with a null area against a NOT NULL column.
    it("refuses a create naming no area at all", async () => {
      const rejection = await rejectionOf("create_project", base("No area anywhere"));

      expect(rejection.code).toBe("invalid_input");
      expect(rejection.message).toContain("exactly one of area or areas");
    });

    // Fails if `areaSpellingCheck`'s `!==` is loosened to a `||`-style
    // "at least one" check: both-supplied would then be accepted and
    // silently resolved by precedence, which is the outcome the exclusive
    // check exists to rule out.
    it("refuses a create supplying both area and areas", async () => {
      const rejection = await rejectionOf("create_project", {
        ...base("Both spellings"),
        area: "web",
        areas: ["infra"],
      });

      expect(rejection.code).toBe("invalid_input");
      expect(rejection.message).toContain("exactly one of area or areas");
    });

    // Fails if `.min(1)` is dropped from the `areas` array schema — an
    // empty list would reach `resolveAreasRaw` and the "at least one area"
    // guard, but as a guard rejection rather than an input rejection.
    it("refuses an empty areas list", async () => {
      const rejection = await rejectionOf("create_project", {
        ...base("Empty list"),
        areas: [],
      });

      expect(rejection.code).toBe("invalid_input");
    });

    // Fails if the empty-normalisation guard is removed from
    // `ensureAreaRaw`: `"---"` collapses to the empty string, which would
    // then be inserted as an `Area` row with an empty id and used as a
    // perfectly valid area on every future item.
    it("refuses an area label that normalises to nothing", async () => {
      const rejection = await rejectionOf("create_project", {
        ...base("Punctuation only"),
        area: "---",
      });

      expect(rejection.guard).toBe("items.area.normalises_to_empty");
    });

    // The all-or-nothing rule. Fails if `resolveAreasRaw` is changed to skip
    // an area it cannot resolve instead of throwing — the item would be
    // created carrying only the areas that happened to work, with nothing
    // telling the caller the rest were dropped.
    it("refuses the whole create when one area in the list is unusable", async () => {
      const rejection = await rejectionOf("create_project", {
        ...base("One bad area among good ones"),
        areas: ["web", "   ", "infra"],
      });

      expect(rejection.code).toBe("invalid_input");

      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Item" WHERE "title" = $1`,
        "One bad area among good ones",
      );
      // Nothing was written: the resolve happens before the insert, so a
      // bad area fails the call rather than leaving a half-filed item.
      expect(rows).toHaveLength(0);
    });

    // Fails if `update-item.ts`'s `.refine()` is dropped — both spellings
    // would be accepted and `edits.areas ?? [edits.area]` would silently
    // prefer `areas`, discarding what the caller said in `area`.
    it("refuses an update supplying both area and areas", async () => {
      const item = await call("create_project", { ...base("To be edited"), area: "web" });

      const rejection = await rejectionOf("update_item", {
        id: item.id,
        area: "web",
        areas: ["infra"],
      });

      expect(rejection.code).toBe("invalid_input");
      expect(rejection.message).toContain("not both");
    });
  });

  describe("all four creation paths carry the area set", () => {
    it("create_item, create_project, create_task and create_subtask each write ItemArea", async () => {
      const project = await call("create_project", {
        ...base("Paths: project"),
        areas: ["web", "infra"],
      });
      const task = await call("create_task", {
        ...base("Paths: task"),
        projectId: project.id,
        areas: ["web", "infra"],
      });
      const subtask = await call("create_subtask", {
        ...base("Paths: subtask"),
        taskId: task.id,
        areas: ["web", "infra"],
      });
      const legacy = await call("create_item", {
        ...base("Paths: create_item"),
        areas: ["web", "infra"],
      });

      // The whole point of putting the resolution in the shared core rather
      // than in one operation: all four reach it. Fails if the area write
      // is moved back out of `insertItem` into a single create operation —
      // three of these four would then come back with one area.
      for (const created of [project, task, subtask, legacy]) {
        expect(created.areas).toEqual(["web", "infra"]);
        expect(await linkedAreas(created.id)).toEqual(["infra", "web"]);
      }
    });
  });

  describe("the auto-created inbox project carries its area", () => {
    // The MEDIUM-1 regression, reproduced end to end through the public
    // service API exactly as the review found it: `resolveInboxProject`
    // writes `Item.area` in a raw INSERT and, before the fix, never called
    // `setItemAreas` — so the inbox project it minted had `Item.area` set
    // correctly but ZERO `ItemArea` rows, making it invisible to
    // `areaFilterCondition`, which deliberately reads only that table.
    //
    // Asserting `item.areas` on the read alone would NOT have caught this —
    // the `COALESCE`/`?? [row.area]` fallbacks make that read correct even
    // when the join table is empty, which is exactly why this survived.
    // The assertion has to go through `list_items`'s actual filter.
    it("is findable by area filter after create_task(projectId: 'inbox', area: ...)", async () => {
      const task = await call("create_task", {
        ...base("Filed to the inbox"),
        projectId: "inbox",
        area: "inbox-filter-area",
      });

      const inboxProjectId = await (async () => {
        const rows = await prisma.$queryRawUnsafe<{ parentId: string | null }[]>(
          `SELECT "parentId" FROM "Item" WHERE "id" = $1`,
          task.id,
        );
        return rows[0]!.parentId!;
      })();

      // Fails if `resolveInboxProject` stops calling `setItemAreas` after
      // its insert: the inbox project would have `Item.area` set but no
      // `ItemArea` row at all.
      expect(await linkedAreas(inboxProjectId)).toEqual(["inbox-filter-area"]);

      // The load-bearing assertion, matching the exact reproduction in the
      // review: filtering to the area the task named must surface the
      // INBOX PROJECT itself, not just the task inside it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listed = (await (runtime.call as any)("list_items", {
        area: "inbox-filter-area",
      })) as { items: { id: string }[] };
      expect(listed.items.map((i) => i.id)).toContain(inboxProjectId);
    });

    it("finding the existing inbox project on a second call does not touch its area link", async () => {
      // The inbox is a process-wide singleton found by title (see
      // `resolveInboxProject`'s own header on the find-or-create race), so
      // by the time this test runs another test in this suite has already
      // minted it. That is exactly the case this test wants: call
      // `create_task(projectId: "inbox")` again, with a DIFFERENT area, and
      // confirm the inbox project's own area link is untouched — the write
      // only happens on the branch that actually inserts the project row.
      const first = await call("create_task", {
        ...base("Primes the inbox project for this test"),
        projectId: "inbox",
        area: "inbox-reuse-priming-area",
      });
      const primedParentId = await (async () => {
        const rows = await prisma.$queryRawUnsafe<{ parentId: string | null }[]>(
          `SELECT "parentId" FROM "Item" WHERE "id" = $1`,
          first.id,
        );
        return rows[0]!.parentId!;
      })();
      const before = await linkedAreas(primedParentId);

      const second = await call("create_task", {
        ...base("Reuses the inbox project with a different area"),
        projectId: "inbox",
        area: "inbox-reuse-should-not-appear",
      });
      const secondParentId = await (async () => {
        const rows = await prisma.$queryRawUnsafe<{ parentId: string | null }[]>(
          `SELECT "parentId" FROM "Item" WHERE "id" = $1`,
          second.id,
        );
        return rows[0]!.parentId!;
      })();

      expect(secondParentId).toBe(primedParentId);
      // Fails if `resolveInboxProject` called `setItemAreas` unconditionally
      // instead of only on the branch that inserts a new row: the second
      // task's area would leak into the (already-existing) inbox project's
      // link, changing `before` into something containing
      // "inbox-reuse-should-not-appear".
      expect(await linkedAreas(primedParentId)).toEqual(before);
    });
  });

  describe("filtering matches any of an item's areas", () => {
    it("finds an item by its non-primary area in list_items and get_board", async () => {
      const item = await call("create_project", {
        ...base("Findable by its second area"),
        areas: ["filter-primary", "filter-secondary"],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listed = (await (runtime.call as any)("list_items", {
        area: "filter-secondary",
      })) as { items: { id: string }[] };
      // The board answers per column, each holding a page of
      // `{ item, column }` entries plus that column's total. `backlog` is
      // named explicitly because an empty project derives to backlog, which
      // a default read withholds (MILESTONES.md #109) — the subject here is
      // the area filter, not the default slice.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const board = (await (runtime.call as any)("get_board", {
        area: "filter-secondary",
        column: "backlog",
      })) as { columns: Record<string, { entries: { item: { id: string } }[] }> };

      // THE read-path decision, and the one most likely to be quietly
      // reverted. Fails the moment either filter goes back to
      // `"area" = $n`: `filter-secondary` is not the primary area, so a
      // single-area filter returns nothing and the second area is
      // decorative.
      expect(listed.items.map((i) => i.id)).toContain(item.id);
      const onBoard = Object.values(board.columns)
        .flatMap((section) => section.entries)
        .map((entry) => entry.item.id);
      expect(onBoard).toContain(item.id);
    });

    it("still finds an item by its primary area", async () => {
      const item = await call("create_project", {
        ...base("Findable by its first area"),
        areas: ["filter-primary-only", "filter-other"],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listed = (await (runtime.call as any)("list_items", {
        area: "filter-primary-only",
      })) as { items: { id: string }[] };

      // The widened filter must not have traded one direction for the
      // other. Fails if `areaFilterCondition` were written against a
      // "non-primary areas only" table — which is precisely why
      // `setItemAreas` writes the primary into `ItemArea` as well.
      expect(listed.items.map((i) => i.id)).toContain(item.id);
    });

    it("does not return an item for an area it does not carry", async () => {
      await call("create_project", {
        ...base("Carries neither filtered area"),
        areas: ["unrelated-area"],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listed = (await (runtime.call as any)("list_items", {
        area: "an-area-nothing-has",
      })) as { items: { id: string }[] };

      // The filter still filters. Fails if `areaFilterCondition` is
      // weakened to a condition that is true for every row — an `EXISTS`
      // with the `areaId` comparison dropped would return the whole table
      // and every other test in this describe would still pass.
      expect(listed.items).toHaveLength(0);
    });
  });

  describe("editing an item's areas", () => {
    it("writes a whole new set and moves the primary with it", async () => {
      const item = await call("create_project", {
        ...base("Edited to a new set"),
        areas: ["edit-a", "edit-b"],
      });

      const updated = await call("update_item", {
        id: item.id,
        areas: ["edit-c", "edit-d"],
      });

      // Fails if `setItemAreas`'s `DELETE` is removed: both the incoming
      // rows and the ones already there would survive, making this four
      // areas rather than two.
      expect(updated.areas).toEqual(["edit-c", "edit-d"]);
      expect(await linkedAreas(item.id)).toEqual(["edit-c", "edit-d"]);
      expect(await primaryArea(item.id)).toBe("edit-c");
    });

    it("adds an area without changing the primary, and still reports the change", async () => {
      const item = await call("create_project", {
        ...base("Gains a second area"),
        area: "keep-primary",
      });

      const updated = await call("update_item", {
        id: item.id,
        areas: ["keep-primary", "added-later"],
      });

      // The case the column diff cannot see on its own: `Item.area` is
      // unchanged, so `setClauses` is empty. Fails if the `areasChanged`
      // branch is removed from update-item.ts — the early return would
      // treat this as a no-op and discard the new area entirely.
      expect(updated.areas).toEqual(["keep-primary", "added-later"]);
      expect(await linkedAreas(item.id)).toEqual(["added-later", "keep-primary"]);
      expect(await primaryArea(item.id)).toBe("keep-primary");
    });

    it("narrows a multi-area item to one when the singular spelling is edited", async () => {
      const item = await call("create_project", {
        ...base("Narrowed by the singular spelling"),
        areas: ["narrow-a", "narrow-b"],
      });

      const updated = await call("update_item", { id: item.id, area: "narrow-a" });

      // `area` means the same thing on a read and on a write: one area.
      // Fails if the singular path stops collapsing to a one-element set —
      // if `edits.area` were written straight to the column without
      // touching the join table, `narrow-b` would survive in `ItemArea`
      // and the two representations would disagree.
      expect(updated.areas).toEqual(["narrow-a"]);
      expect(await linkedAreas(item.id)).toEqual(["narrow-a"]);
    });

    it("records an areas field_change when only the set moved", async () => {
      const item = await call("create_project", {
        ...base("Set-only edit is on the ledger"),
        area: "ledger-primary",
      });

      await call("update_item", {
        id: item.id,
        areas: ["ledger-primary", "ledger-extra"],
      });

      const events = await prisma.$queryRawUnsafe<{ payload: { field: string } }[]>(
        `SELECT "payload" FROM "Event" WHERE "itemId" = $1 AND "type" = 'field_change'`,
        item.id,
      );

      // "Every mutating call appends a row" (SCHEMA.md §3). Fails if the
      // `recordFieldChanges` call in the set-only branch is dropped: the
      // area set would change with nothing on the ledger saying so.
      expect(events.map((e) => e.payload.field)).toContain("areas");
    });

    it("leaves the area set alone when an update says nothing about areas", async () => {
      const item = await call("create_project", {
        ...base("Untouched areas"),
        areas: ["untouched-a", "untouched-b"],
      });

      await call("update_item", { id: item.id, priority: "P0" });

      // An update patches only what it names. Fails if `rawAreas` were
      // defaulted to something non-undefined when neither spelling is
      // supplied — the set would be rewritten (or emptied) by an edit that
      // never mentioned areas.
      expect(await linkedAreas(item.id)).toEqual(["untouched-a", "untouched-b"]);
      expect(await primaryArea(item.id)).toBe("untouched-a");
    });
  });

  describe("the migration's seed", () => {
    it("gives every pre-existing item an area set of exactly its old area", async () => {
      // An item written the way one existed BEFORE `ItemArea` did: the
      // `Item.area` column set, and no join row at all. Inserted directly
      // rather than through the service, because the service is what this
      // is proving the migration did not depend on.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
        "legacy-area",
      );
      const legacyId = "00000000-0000-4000-8000-00000000ffff";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Item" (
           "id", "parentId", "kind", "title", "body", "state", "priority",
           "originType", "area", "needsVisualReview", "driveMode",
           "mergeAuthority", "updatedAt"
         ) VALUES (
           $1, NULL, 'project'::"ItemKind", 'Written before ItemArea existed', '',
           'on_deck'::"ItemState", 'P2'::"Priority", 'auto'::"OriginType", $2,
           false, 'autonomous'::"DriveMode", 'needs_approval'::"MergeAuthority",
           CURRENT_TIMESTAMP
         )`,
        legacyId,
        "legacy-area",
      );

      // The migration's OWN seed statement, read out of the committed
      // migration file rather than retyped here. Retyping it would test a
      // copy: the migration could stop seeding entirely and a hand-written
      // duplicate would go on passing, which is precisely the hollow test
      // this repo mutation-tests for.
      await prisma.$executeRawUnsafe(seedStatement());

      // Fails if the seed's SELECT stops covering every item — add a
      // `WHERE false`, or narrow it to a subset, and this row keeps its
      // `Item.area` while gaining no `ItemArea` row at all.
      expect(await linkedAreas(legacyId)).toEqual(["legacy-area"]);

      // And re-running is a no-op rather than an error. Fails if
      // `ON CONFLICT DO NOTHING` is dropped from the migration: the second
      // run raises a unique-violation instead, which is what would leave a
      // re-applied migration half-applied.
      await prisma.$executeRawUnsafe(seedStatement());
      expect(await linkedAreas(legacyId)).toEqual(["legacy-area"]);
    });

    it("reads a pre-migration row's areas as its primary area rather than nothing", async () => {
      // A row with `Item.area` set and NO `ItemArea` row — the state the
      // fallback in `toItemRecord` exists for.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
        "unseeded-area",
      );
      const unseededId = "00000000-0000-4000-8000-00000000fffe";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Item" (
           "id", "parentId", "kind", "title", "body", "state", "priority",
           "originType", "area", "needsVisualReview", "driveMode",
           "mergeAuthority", "updatedAt"
         ) VALUES (
           $1, NULL, 'project'::"ItemKind", 'Never seeded', '',
           'on_deck'::"ItemState", 'P2'::"Priority", 'auto'::"OriginType", $2,
           false, 'autonomous'::"DriveMode", 'needs_approval'::"MergeAuthority",
           CURRENT_TIMESTAMP
         )`,
        unseededId,
        "unseeded-area",
      );

      // `full`, because `areas` is part of the whole record — the slim read
      // is deliberately id/title/state/headline only.
      const item = await call("get_item", { id: unseededId, full: true });

      // `array_agg` returns SQL NULL, not an empty array, when the subquery
      // matches no rows, so without a fallback `areas` is null here.
      //
      // Two mechanisms supply that fallback — the `COALESCE` in
      // `ITEM_COLUMNS` and the `?? [row.area]` in `toItemRecord` — and this
      // asserts the OUTCOME rather than either one, so it stays honest
      // about what it protects: removing both makes it fail; removing
      // either alone leaves the behaviour correct and it rightly passes.
      expect(item.areas).toEqual(["unseeded-area"]);
    });
  });

  describe("the vocabulary is shared, not per-item", () => {
    it("reuses one Area row across items that name it", async () => {
      const first = await call("create_project", { ...base("First namer"), area: "shared-area" });
      const second = await call("create_project", { ...base("Second namer"), area: "Shared Area" });

      expect(first.area).toBe("shared-area");
      expect(second.area).toBe("shared-area");

      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Area" WHERE "id" = $1`,
        "shared-area",
      );
      // Fails if `ensureAreaRaw`'s `ON CONFLICT DO NOTHING` became a plain
      // INSERT (the second create would raise) or if normalisation stopped
      // being applied (there would be two rows, `shared-area` and
      // `Shared Area`, and the filter would split between them).
      expect(rows).toHaveLength(1);
    });
  });
});
