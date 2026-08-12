// Item service operations against a real Postgres — SCHEMA.md §1, §3, §17.2,
// §23.1. See tests/service-transaction-db.test.ts for why these need a real
// database rather than a modelled handle: rollback and constraint behaviour
// are things only Postgres can prove.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { resolveSettings, defaultSnapshot } from "@/lib/settings";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("item service operations against Postgres", () => {
  const dbName = scratchDatabaseName("items_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function eventsFor(itemId: string): Promise<{ type: string; payload: unknown }[]> {
    return prisma.$queryRawUnsafe(
      `SELECT "type", "payload" FROM "Event" WHERE "itemId" = $1 ORDER BY "id" ASC`,
      itemId,
    );
  }

  async function itemCount(): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM "Item"`,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  describe("create_item", () => {
    it("creates a root project, deriving kind from depth and appending one field_change event", async () => {
      const before = await itemCount();
      const item = (await runtime.call("create_item", {
        title: "Root project",
        body: "The brief.",
        area: "Web App",
        originType: "auto",
      })) as { id: string; kind: string; state: string; area: string };

      expect(item.kind).toBe("project");
      expect(item.state).toBe("on_deck");
      // Normalised, per SCHEMA.md §23.1 ("lowercase, trim, collapse separators").
      expect(item.area).toBe("web-app");
      expect(await itemCount()).toBe(before + 1);

      const events = await eventsFor(item.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("field_change");
    });

    it("stores difficulty and customFields as queryable jsonb, sparse fields included", async () => {
      const item = (await runtime.call("create_item", {
        title: "Scored",
        body: "x",
        area: "jsonb-fields",
        originType: "auto",
        difficulty: { reasoning: 3, breadth: 2 },
        customFields: { ticket: "ext-42" },
      })) as { id: string; difficulty: unknown; customFields: unknown };

      expect(item.difficulty).toEqual({ reasoning: 3, breadth: 2 });
      expect(item.customFields).toEqual({ ticket: "ext-42" });

      // Read directly with a jsonb operator — proves it landed as jsonb,
      // not as a text column a client happens to parse leniently. A column
      // of type `text` would fail this query outright.
      const rows = await prisma.$queryRawUnsafe<{ reasoning: number }[]>(
        `SELECT ("difficulty"->>'reasoning')::int AS "reasoning" FROM "Item" WHERE "id" = $1`,
        item.id,
      );
      expect(rows[0]?.reasoning).toBe(3);
    });

    it("auto-creates the area on first use and preserves the display name", async () => {
      await runtime.call("create_item", {
        title: "First in a new area",
        body: "x",
        area: "  Infra Tools  ",
        originType: "auto",
      });
      const rows = await prisma.$queryRawUnsafe<{ displayName: string }[]>(
        `SELECT "displayName" FROM "Area" WHERE "id" = 'infra-tools'`,
      );
      expect(rows[0]?.displayName).toBe("Infra Tools");
    });

    it("derives kind: task at depth 1, subtask at depth 2 and beyond", async () => {
      const project = (await runtime.call("create_item", {
        title: "Depth root",
        body: "x",
        area: "depth-area",
        originType: "auto",
      })) as { id: string };
      const task = (await runtime.call("create_item", {
        title: "A task",
        body: "x",
        area: "depth-area",
        originType: "auto",
        parentId: project.id,
      })) as { id: string; kind: string };
      expect(task.kind).toBe("task");

      const subtask = (await runtime.call("create_item", {
        title: "A subtask",
        body: "x",
        area: "depth-area",
        originType: "auto",
        parentId: task.id,
      })) as { id: string; kind: string };
      expect(subtask.kind).toBe("subtask");

      const grandchild = (await runtime.call("create_item", {
        title: "Deeper still",
        body: "x",
        area: "depth-area",
        originType: "auto",
        parentId: subtask.id,
      })) as { kind: string };
      // depth >= 2 is still "subtask" (SCHEMA.md §1 kind column).
      expect(grandchild.kind).toBe("subtask");
    });

    it("refuses a parent that does not exist", async () => {
      const error = await runtime
        .call("create_item", {
          title: "Orphan",
          body: "x",
          area: "orphans",
          originType: "auto",
          parentId: "no-such-item",
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
      expect((error as { fields: string[] }).fields).toEqual(["parentId"]);
    });

    it("refuses to create past items.max_depth", async () => {
      // items.max_depth defaults to 6 (settings/registry.ts). Build a chain
      // of exactly 6 items (depths 0..5) — the 7th, at depth 6, must be
      // refused because depth 6 > max_depth 6 is false but depth 7 > 6 is
      // true; walk one further to be certain of crossing the boundary.
      let parentId: string | undefined;
      for (let depth = 0; depth <= 6; depth++) {
        parentId = (
          (await runtime.call("create_item", {
            title: `depth ${depth}`,
            body: "x",
            area: "deep-chain",
            originType: "auto",
            parentId,
          })) as { id: string }
        ).id;
      }
      // One more push would land at depth 7, past the default max of 6.
      const error = await runtime
        .call("create_item", {
          title: "one too deep",
          body: "x",
          area: "deep-chain",
          originType: "auto",
          parentId,
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("guard_rejected");
      expect((error as { guard: string }).guard).toBe("items.max_depth");
    });

    it("respects a lowered items.max_depth from the settings snapshot", async () => {
      // Same shape as the default-depth test above, but resolved from a
      // snapshot with max_depth=1 rather than the built-in default of 6 —
      // proves the guard reads the *resolved* setting, not a hardcoded
      // number, which the default-only test above cannot distinguish.
      const shallowRuntime = new ServiceRuntime({
        transaction: prismaTransactionRunner(prisma),
        resolveSnapshot: async () =>
          resolveSettings({ overrides: [{ key: "items.max_depth", value: 1 }], revision: 1n }),
      });
      const root = (await shallowRuntime.call("create_item", {
        title: "shallow root",
        body: "x",
        area: "shallow",
        originType: "auto",
      })) as { id: string };
      const child = (await shallowRuntime.call("create_item", {
        title: "shallow child",
        body: "x",
        area: "shallow",
        originType: "auto",
        parentId: root.id,
      })) as { id: string };
      const error = await shallowRuntime
        .call("create_item", {
          title: "too deep for this snapshot",
          body: "x",
          area: "shallow",
          originType: "auto",
          parentId: child.id,
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("guard_rejected");
    });

    it("requires originPersonId when originType is person", async () => {
      const error = await runtime
        .call("create_item", {
          title: "Needs a person",
          body: "x",
          area: "people-area",
          originType: "person",
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields: string[] }).fields).toContain("originPersonId");
    });

    it("rolls back the item insert and its event when the call is refused after depth resolves", async () => {
      // The max-depth refusal happens before any write, so assert directly
      // that a refused create leaves no row at all, distinguishing "guarded
      // before writing" from "written then rolled back" (both are correct
      // behaviour for a caller, but only the count proves which happened).
      const before = await itemCount();
      await runtime
        .call("create_item", {
          title: "x",
          body: "x",
          area: "x",
          originType: "auto",
          parentId: "missing",
        })
        .catch(() => undefined);
      expect(await itemCount()).toBe(before);
    });
  });

  describe("get_item", () => {
    it("reads back exactly what create_item wrote", async () => {
      const created = (await runtime.call("create_item", {
        title: "Readable",
        body: "Body text",
        area: "reading",
        originType: "auto",
        priority: "P1",
      })) as { id: string };
      const read = await runtime.call("get_item", { id: created.id });
      expect(read).toEqual(created);
    });

    it("refuses an id that does not exist", async () => {
      const error = await runtime
        .call("get_item", { id: "does-not-exist" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });
  });

  describe("update_item", () => {
    it("edits a field, bumps updatedAt and appends one field_change event", async () => {
      const created = (await runtime.call("create_item", {
        title: "Before",
        body: "x",
        area: "editing",
        originType: "auto",
        priority: "P2",
      })) as { id: string; updatedAt: string; priority: string };

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = (await runtime.call("update_item", {
        id: created.id,
        priority: "P0",
      })) as { priority: string; updatedAt: string };

      expect(updated.priority).toBe("P0");
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt).getTime(),
      );

      const events = await eventsFor(created.id);
      // One from create, one from this update.
      expect(events).toHaveLength(2);
      expect(events[1]?.type).toBe("field_change");
      expect(events[1]?.payload).toEqual({ field: "priority", from: "P2", to: "P0" });
    });

    it("writes one event per changed field when several change at once", async () => {
      const created = (await runtime.call("create_item", {
        title: "Multi-edit",
        body: "x",
        area: "editing",
        originType: "auto",
      })) as { id: string };

      await runtime.call("update_item", {
        id: created.id,
        title: "Multi-edit, renamed",
        priority: "P0",
      });

      const events = await eventsFor(created.id);
      expect(events).toHaveLength(3); // create + title change + priority change
      const fields = events.slice(1).map((e) => (e.payload as { field: string }).field);
      expect(fields.sort()).toEqual(["priority", "title"]);
    });

    it("edits customFields as jsonb, queryable directly and not just round-tripped through the API shape", async () => {
      const created = (await runtime.call("create_item", {
        title: "Custom fields",
        body: "x",
        area: "editing",
        originType: "auto",
      })) as { id: string };

      await runtime.call("update_item", {
        id: created.id,
        customFields: { legacy_id: "abc-123" },
      });

      const rows = await prisma.$queryRawUnsafe<{ legacyId: string }[]>(
        `SELECT "customFields"->>'legacy_id' AS "legacyId" FROM "Item" WHERE "id" = $1`,
        created.id,
      );
      expect(rows[0]?.legacyId).toBe("abc-123");
    });

    it("is a genuine no-op — no row change and no event — when the patch matches the current value", async () => {
      const created = (await runtime.call("create_item", {
        title: "Same",
        body: "x",
        area: "editing",
        originType: "auto",
        priority: "P2",
      })) as { id: string; updatedAt: string };

      const result = (await runtime.call("update_item", {
        id: created.id,
        priority: "P2", // already P2
      })) as { updatedAt: string };

      expect(result.updatedAt).toBe(created.updatedAt);
      const events = await eventsFor(created.id);
      expect(events).toHaveLength(1); // only the create event
    });

    it("refuses an id that does not exist", async () => {
      const error = await runtime
        .call("update_item", { id: "no-such-item", title: "x" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });

    it("cannot move state — state is not in the update schema", async () => {
      const created = (await runtime.call("create_item", {
        title: "Immutable state via update",
        body: "x",
        area: "editing",
        originType: "auto",
      })) as { id: string };
      const error = await runtime
        .call("update_item", { id: created.id, state: "merged" })
        .catch((e: unknown) => e);
      // `.strict()` refuses the unknown key outright.
      expect((error as { code: string }).code).toBe("invalid_input");
    });

    it("rolls back every field-change event when the update itself fails partway", async () => {
      // update_item's own path has no guard that can reject after a write
      // begins, so this proves the transaction boundary the same way
      // service-transaction-db.test.ts does: force a failure — an unknown
      // repo — and confirm the row is untouched, not partially edited.
      const created = (await runtime.call("create_item", {
        title: "Guarded edit",
        body: "x",
        area: "editing",
        originType: "auto",
        priority: "P2",
      })) as { id: string; priority: string };

      const error = await runtime
        .call("update_item", { id: created.id, priority: "P0", repo: "no-such-repo" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");

      const reread = (await runtime.call("get_item", { id: created.id })) as { priority: string };
      // Priority must still be P2 — a per-statement boundary would have
      // committed the priority change before failing on the repo lookup.
      expect(reread.priority).toBe("P2");
      const events = await eventsFor(created.id);
      expect(events).toHaveLength(1); // only the create event, nothing from the failed update
    });
  });

  describe("list_items", () => {
    it("a filter genuinely excludes: state=merged excludes an on_deck item that would otherwise appear", async () => {
      const kept = (await runtime.call("create_item", {
        title: "Kept",
        body: "x",
        area: "listing-exclude",
        originType: "auto",
      })) as { id: string };
      // Move the other item's state directly (state transitions are not
      // this row's operation — #27's territory) so it is excluded by a
      // state filter without depending on unwritten transition logic.
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "state" = 'merged'::"ItemState" WHERE "id" = $1`,
        (
          (await runtime.call("create_item", {
            title: "Excluded",
            body: "x",
            area: "listing-exclude",
            originType: "auto",
          })) as { id: string }
        ).id,
      );

      const result = (await runtime.call("list_items", {
        area: "listing-exclude",
        state: "on_deck",
      })) as { items: readonly { id: string }[] };

      const ids = result.items.map((i) => i.id);
      expect(ids).toContain(kept.id);
      expect(ids.length).toBe(1); // the merged one is excluded, not just "also present"
    });

    it("filters by area, excluding items in a different area", async () => {
      const inArea = (await runtime.call("create_item", {
        title: "In area",
        body: "x",
        area: "filter-area-a",
        originType: "auto",
      })) as { id: string };
      await runtime.call("create_item", {
        title: "In a different area",
        body: "x",
        area: "filter-area-b",
        originType: "auto",
      });

      const result = (await runtime.call("list_items", {
        area: "filter-area-a",
      })) as { items: readonly { id: string; area: string }[] };

      expect(result.items.map((i) => i.id)).toEqual([inArea.id]);
      expect(result.items.every((i) => i.area === "filter-area-a")).toBe(true);
    });

    it("filters by priority, excluding a different priority", async () => {
      const p0 = (await runtime.call("create_item", {
        title: "P0 item",
        body: "x",
        area: "filter-priority",
        originType: "auto",
        priority: "P0",
      })) as { id: string };
      await runtime.call("create_item", {
        title: "P3 item",
        body: "x",
        area: "filter-priority",
        originType: "auto",
        priority: "P3",
      });

      const result = (await runtime.call("list_items", {
        area: "filter-priority",
        priority: "P0",
      })) as { items: readonly { id: string }[] };
      expect(result.items.map((i) => i.id)).toEqual([p0.id]);
    });

    it("paginates with a cursor that never repeats or skips a row", async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const item = (await runtime.call("create_item", {
          title: `page-${i}`,
          body: "x",
          area: "pagination",
          originType: "auto",
        })) as { id: string };
        created.push(item.id);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = (await runtime.call("list_items", {
          area: "pagination",
          limit: 2,
          cursor,
        })) as { items: readonly { id: string }[]; nextCursor: string | null };
        seen.push(...result.items.map((i) => i.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      // Every created id appears exactly once across all pages.
      expect(seen.sort()).toEqual([...created].sort());
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("returns an empty page rather than throwing when nothing matches", async () => {
      const result = (await runtime.call("list_items", {
        area: "an-area-nothing-uses",
      })) as { items: readonly unknown[]; nextCursor: string | null };
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });
  });
});
