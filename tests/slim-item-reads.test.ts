// MILESTONES.md #107 — the slim read is the default, and a headline is what
// it returns.
//
// **What would make this file hollow, stated first so it can be checked.**
// Asserting that a slim read *contains* `id`, `title`, `state` and
// `headline` proves nothing: a thirty-column response contains all four too,
// so an assertion of that shape is satisfied by exactly the payload this row
// exists to stop shipping. So the load-bearing assertions are all about
// **absence** —
// that `body` and `customFields`, the two columns that were 99% of the
// measured payload, are not on the response at all — and about the opt-in
// **restoring** them. A test that only ever asserted presence would go green
// against a `full`-by-default implementation, which is precisely the bug.
//
// **Every surface, not just the service.** #107's own row says an opt-in
// that exists in the service layer but not in the MCP tool is not an opt-in
// for the agents it exists to help, so the shape is asserted at the service,
// over HTTP through the real route handlers, and through the CLI's two
// bindings. The MCP surface has its own assertions in
// `tests/mcp-read-tools.test.ts`, next to the other MCP read tests.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  BOARD_ITEM_SUMMARY_COLUMNS,
  HEADLINE_MAX_CHARS,
  ITEM_COLUMNS,
  ITEM_SUMMARY_COLUMNS,
  itemColumnsFor,
} from "@/lib/service/items/row";
import {
  CHECKPOINT_HEADLINE_MAX_CHARS,
  deriveHeadlineFromBody,
} from "@/lib/service/items/checkpoint-headline";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { registerSessions } from "./helpers/register-sessions";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** The two columns that were the overwhelming majority of the measured payload. */
const HEAVY_FIELDS = ["body", "customFields"] as const;

describe("the slim read's column lists", () => {
  // A cheap structural guard: the whole saving comes from these lists being
  // short. If someone adds `body` to either — the single easiest way to
  // silently undo this row while every behavioural test still passes,
  // because a wider response satisfies every "contains" assertion — this
  // goes red immediately and by name.
  it("names exactly the four fields the slim item read returns", () => {
    expect(ITEM_SUMMARY_COLUMNS).toBe("id, title, state, headline");
  });

  it("keeps the heavy columns out of both projections", () => {
    for (const field of HEAVY_FIELDS) {
      expect(ITEM_SUMMARY_COLUMNS).not.toContain(field);
      expect(BOARD_ITEM_SUMMARY_COLUMNS).not.toContain(field);
    }
  });

  // These four are the assertions that catch the defect nothing else can
  // see. `toItemSummaryRecord` strips the heavy fields out of the *response*
  // whatever the query fetched, so an operation that selected all thirty
  // columns and then mapped four would return a byte-identical payload while
  // doing exactly the work this row exists to stop — every behavioural
  // assertion in this file passes against it. The column choice has to be
  // asserted directly, which is why it is a callable function.
  it("selects the slim item columns when full is off", () => {
    expect(itemColumnsFor(false)).toBe(ITEM_SUMMARY_COLUMNS);
  });

  it("selects the board's columns when full is off and the board asked", () => {
    expect(itemColumnsFor(false, "board")).toBe(BOARD_ITEM_SUMMARY_COLUMNS);
  });

  it("selects the whole row when full is on, for either variant", () => {
    expect(itemColumnsFor(true)).toBe(ITEM_COLUMNS);
    expect(itemColumnsFor(true, "board")).toBe(ITEM_COLUMNS);
  });

  it("returns something genuinely shorter when full is off", () => {
    // Not a tautology against the constants above: this is the invariant
    // that has to hold whatever those lists become.
    expect(itemColumnsFor(false).length).toBeLessThan(itemColumnsFor(true).length);
    expect(itemColumnsFor(false, "board").length).toBeLessThan(itemColumnsFor(true).length);
  });

  it("gives the board the fields a card renders, and nothing beyond them", () => {
    // Exact rather than "contains": the board's shape being *wider* than
    // the item read's is a deliberate, bounded exception (a card cannot be
    // drawn from four fields), and the bound is what stops it drifting back
    // towards the whole row one plausible field at a time.
    expect(BOARD_ITEM_SUMMARY_COLUMNS).toBe(
      'id, title, state, headline, kind, priority, area, repo, "blockedReason", ' +
        '"blockedOnType", "blockedOnPersonId", "pauseReason", "originType"',
    );
  });
});

describe("deriving a checkpoint headline from its prose", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(deriveHeadlineFromBody("  Migrations are in.  \nThen the routes.")).toBe(
      "Migrations are in.",
    );
  });

  it("skips leading blank lines rather than returning an empty headline", () => {
    expect(deriveHeadlineFromBody("\n\n   \nActually started here.")).toBe(
      "Actually started here.",
    );
  });

  it("returns null for prose that is empty or entirely whitespace", () => {
    expect(deriveHeadlineFromBody("")).toBeNull();
    expect(deriveHeadlineFromBody("   \n\t\n ")).toBeNull();
    expect(deriveHeadlineFromBody(null)).toBeNull();
  });

  it("caps the derived headline at the documented 200 characters", () => {
    // Pinned to the literal, not to the constant. A test written as
    // `repeat(CHECKPOINT_HEADLINE_MAX_CHARS + 50)` and asserting
    // `toHaveLength(CHECKPOINT_HEADLINE_MAX_CHARS)` follows the constant
    // wherever it moves and can never fail on a changed cap — it asserts
    // only that the function is self-consistent, which was never in doubt.
    expect(CHECKPOINT_HEADLINE_MAX_CHARS).toBe(200);
    expect(deriveHeadlineFromBody("x".repeat(400))).toHaveLength(200);
  });

  it("marks a capped headline as truncated rather than silently shortening it", () => {
    const long = "x".repeat(CHECKPOINT_HEADLINE_MAX_CHARS + 50);
    const derived = deriveHeadlineFromBody(long);
    // The cap is the whole reason this function exists rather than
    // `body.split("\n")[0]`: a checkpoint written as one unbroken paragraph
    // has a "first line" that is the entire checkpoint, which would put the
    // payload the slim read exists to bound straight back into it.
    expect(derived).toHaveLength(CHECKPOINT_HEADLINE_MAX_CHARS);
    expect(derived?.endsWith("…")).toBe(true);
  });

  it("leaves a line exactly at the cap alone, ellipsising nothing", () => {
    const exact = "y".repeat(CHECKPOINT_HEADLINE_MAX_CHARS);
    expect(deriveHeadlineFromBody(exact)).toBe(exact);
  });
});

describeIfDb("the slim read against Postgres", () => {
  const dbName = scratchDatabaseName("slim_reads");
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
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (scratchUrl) await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** A big item — a realistic brief and a realistic custom-field bag. */
  async function makeHeavyItem(overrides: Record<string, unknown> = {}) {
    return (await runtime.call("create_item", {
      title: "A heavy item",
      headline: "One line about the heavy item",
      body: "b".repeat(20_000),
      area: "slim-reads",
      originType: "auto",
      customFields: { brief: "c".repeat(20_000) },
      ...overrides,
    })) as unknown as { id: string };
  }

  describe("get_item", () => {
    it("returns the four slim fields and nothing heavy, by default", async () => {
      const created = await makeHeavyItem();
      const read = (await runtime.call("get_item", { id: created.id })) as unknown as Record<
        string,
        unknown
      >;

      expect(read.id).toBe(created.id);
      expect(read.title).toBe("A heavy item");
      expect(read.headline).toBe("One line about the heavy item");
      expect(typeof read.state).toBe("string");
      // The assertion that can actually fail if the default regresses.
      for (const field of HEAVY_FIELDS) {
        expect(read).not.toHaveProperty(field);
      }
    });

    it("is dramatically smaller than the full record", async () => {
      const created = await makeHeavyItem();
      const slim = await runtime.call("get_item", { id: created.id });
      const full = await runtime.call("get_item", { id: created.id, full: true });

      const slimSize = JSON.stringify(slim).length;
      const fullSize = JSON.stringify(full).length;
      // An order of magnitude, not a percentage point. The measured case
      // this row was written from was 0.2%; asserting a 20x floor leaves
      // room for a modestly-sized item without the assertion ever passing
      // on an implementation that quietly returns the whole row.
      expect(fullSize).toBeGreaterThan(slimSize * 20);
    });

    it("restores every heavy field when full is passed", async () => {
      const created = await makeHeavyItem();
      const read = (await runtime.call("get_item", {
        id: created.id,
        full: true,
      })) as unknown as Record<string, unknown>;
      for (const field of HEAVY_FIELDS) {
        expect(read).toHaveProperty(field);
      }
      expect(read.body).toHaveLength(20_000);
    });

    it("still refuses an unknown id on the slim path, not just the full one", async () => {
      // The two paths are separate queries; a not_found that only fired on
      // one of them would be a real hole, and this is the cheap proof it
      // does not exist.
      const slimError = await runtime
        .call("get_item", { id: "no-such-slim-item" })
        .catch((e: unknown) => e);
      expect((slimError as { code: string }).code).toBe("not_found");
    });

    it("carries the latest checkpoint's headline, and null when there is none", async () => {
      const created = await makeHeavyItem({ title: "Checkpointed" });
      const before = (await runtime.call("get_item", { id: created.id })) as unknown as {
        checkpointHeadline: string | null;
      };
      expect(before.checkpointHeadline).toBeNull();

      // A claim is refused from a session that has not registered a hook
      // protocol version (SCHEMA.md §21). That rule is not what this test is
      // about, so it is satisfied the way a real session satisfies it rather
      // than switched off — see the helper's own header.
      await registerSessions(prisma, ["session-slim-1"]);
      const claimed = (await runtime.call("claim", {
        itemId: created.id,
        sessionId: "session-slim-1",
        role: "builder",
        holderType: "agent",
        holderId: "crew-a",
        machine: "laptop",
      })) as unknown;
      expect(claimed).toBeTruthy();

      await runtime.call("checkpoint", {
        itemId: created.id,
        sessionId: "session-slim-1",
        body: "Migration is applied.\nRoutes next.",
      });
      const after = (await runtime.call("get_item", { id: created.id })) as unknown as {
        checkpointHeadline: string | null;
      };
      expect(after.checkpointHeadline).toBe("Migration is applied.");

      // The *latest*, not the first — an implementation ordering ascending
      // would pass the assertion above and fail this one.
      await runtime.call("checkpoint", {
        itemId: created.id,
        sessionId: "session-slim-1",
        body: "Routes are in too.",
      });
      const latest = (await runtime.call("get_item", { id: created.id })) as unknown as {
        checkpointHeadline: string | null;
      };
      expect(latest.checkpointHeadline).toBe("Routes are in too.");
    });

    it("prefers a checkpoint's stored headline over the line its prose would derive", async () => {
      // The precedence case, reached through `get_item` rather than through
      // `checkpointHeadline` directly.
      //
      // Worth its own test because this is the one path neither half of the
      // work covered alone: a checkpoint may carry a stored headline, and
      // the slim read reaches it through a *different* entry point
      // (`latestCheckpointHeadline`, which makes the query) than the one
      // whose precedence is unit-tested (`checkpointHeadline`, which takes a
      // row). A version of the query that selected only `body` would satisfy
      // every other assertion in this file — all of which write checkpoints
      // with no stored headline — and silently answer with the derivation
      // wherever a writer had actually supplied a line.
      const created = await makeHeavyItem({ title: "Stored over derived" });
      await registerSessions(prisma, ["session-slim-2"]);
      await runtime.call("claim", {
        itemId: created.id,
        sessionId: "session-slim-2",
        role: "builder",
        holderType: "agent",
        holderId: "crew-b",
        machine: "laptop",
      });
      await runtime.call("checkpoint", {
        itemId: created.id,
        sessionId: "session-slim-2",
        body: "An opening line that is not the headline.",
        headline: "What the writer meant",
      });

      const read = (await runtime.call("get_item", { id: created.id })) as unknown as {
        checkpointHeadline: string | null;
      };
      expect(read.checkpointHeadline).toBe("What the writer meant");
      expect(read.checkpointHeadline).not.toBe("An opening line that is not the headline.");
    });
  });

  describe("list_items", () => {
    it("returns slim rows by default and heavy ones only on request", async () => {
      const created = await makeHeavyItem({ area: "slim-list" });

      const slim = (await runtime.call("list_items", {
        area: "slim-list",
      })) as unknown as unknown as {
        items: Record<string, unknown>[];
      };
      expect(slim.items.map((i) => i.id)).toContain(created.id);
      for (const item of slim.items) {
        for (const field of HEAVY_FIELDS) {
          expect(item).not.toHaveProperty(field);
        }
      }

      const full = (await runtime.call("list_items", {
        area: "slim-list",
        full: true,
      })) as unknown as unknown as {
        items: Record<string, unknown>[];
      };
      for (const field of HEAVY_FIELDS) {
        expect(full.items[0]).toHaveProperty(field);
      }
    });

    it("paginates identically in both shapes, so a cursor composes across them", async () => {
      // The projection must not touch the ordering key. If the slim query
      // had dropped `createdAt` from the ORDER BY along with the SELECT,
      // these two id sequences would diverge.
      for (let n = 0; n < 5; n++) {
        await makeHeavyItem({ area: "slim-paging", title: `Paged ${n}`, body: "small" });
      }
      const slim = (await runtime.call("list_items", {
        area: "slim-paging",
        limit: 3,
      })) as unknown as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      const full = (await runtime.call("list_items", {
        area: "slim-paging",
        limit: 3,
        full: true,
      })) as unknown as { items: { id: string }[]; nextCursor: string | null };

      expect(slim.items.map((i) => i.id)).toEqual(full.items.map((i) => i.id));
      expect(slim.nextCursor).toBe(full.nextCursor);
      expect(slim.nextCursor).not.toBeNull();

      const slimPage2 = (await runtime.call("list_items", {
        area: "slim-paging",
        limit: 3,
        cursor: slim.nextCursor!,
      })) as unknown as { items: { id: string }[] };
      const fullPage2 = (await runtime.call("list_items", {
        area: "slim-paging",
        limit: 3,
        cursor: full.nextCursor!,
        full: true,
      })) as unknown as { items: { id: string }[] };
      expect(slimPage2.items.map((i) => i.id)).toEqual(fullPage2.items.map((i) => i.id));
      // And a cursor from the slim page really does move past page one.
      expect(slimPage2.items.map((i) => i.id)).not.toEqual(slim.items.map((i) => i.id));
    });
  });

  describe("get_board", () => {
    it("gives each card what it draws — including the headline — and nothing heavy", async () => {
      const created = await makeHeavyItem({ area: "slim-board", title: "Board card" });
      // `column: "backlog"` because an empty project derives to backlog,
      // which a default read withholds (MILESTONES.md #109). The subject
      // here is the projection, not the default slice.
      const board = (await runtime.call("get_board", {
        area: "slim-board",
        column: "backlog",
      })) as unknown as {
        columns: Record<string, { entries: { item: Record<string, unknown> }[] }>;
      };
      const entry = Object.values(board.columns)
        .flatMap((section) => section.entries)
        .find((e) => e.item.id === created.id);
      expect(entry).toBeDefined();

      // What the card renders — a card missing `priority` or `kind` would
      // render wrong or land in the wrong column entirely.
      expect(entry!.item.headline).toBe("One line about the heavy item");
      expect(entry!.item.priority).toBe("P2");
      expect(entry!.item.kind).toBe("project");
      expect(entry!.item.area).toBe("slim-board");
      // What it does not.
      for (const field of HEAVY_FIELDS) {
        expect(entry!.item).not.toHaveProperty(field);
      }
    });

    it("restores whole records when full is passed", async () => {
      const created = await makeHeavyItem({ area: "slim-board-full" });
      const board = (await runtime.call("get_board", {
        area: "slim-board-full",
        full: true,
        column: "backlog",
      })) as unknown as {
        columns: Record<string, { entries: { item: Record<string, unknown> }[] }>;
      };
      const entry = Object.values(board.columns)
        .flatMap((section) => section.entries)
        .find((e) => e.item.id === created.id);
      expect(entry?.item).toHaveProperty("body");
      expect(entry?.item).toHaveProperty("customFields");
    });

    it("puts a project in the column its children imply, in the slim shape too", async () => {
      // `kind` is why the board's projection is wider than the item read's.
      // Drop it and every project derives as a task, landing in whatever
      // column its meaningless stored state maps to — a wrong answer no
      // "contains the fields" assertion would ever see.
      const project = await makeHeavyItem({ area: "slim-board-tree", title: "Parent" });
      const child = (await runtime.call("create_item", {
        title: "Child",
        body: "x",
        area: "slim-board-tree",
        originType: "auto",
        parentId: project.id,
      })) as unknown as { id: string };
      await runtime.call("transition_item", { id: child.id, to: "planning" });

      const board = (await runtime.call("get_board", {
        area: "slim-board-tree",
      })) as unknown as { columns: Record<string, { entries: { item: { id: string } }[] }> };
      expect((board.columns.in_progress?.entries ?? []).map((e) => e.item.id)).toContain(
        project.id,
      );
      // Read backlog explicitly: a default read withholds it, so asserting
      // absence against the default would pass whether or not the project
      // was misfiled there — the exact vacuous assertion this case exists
      // to avoid.
      const backlog = (await runtime.call("get_board", {
        area: "slim-board-tree",
        column: "backlog",
      })) as unknown as { columns: Record<string, { entries: { item: { id: string } }[] }> };
      expect((backlog.columns.backlog?.entries ?? []).map((e) => e.item.id)).not.toContain(
        project.id,
      );
    });
  });

  describe("the headline field itself", () => {
    it("is null on an item minted without one, not an empty string", async () => {
      const created = (await runtime.call("create_item", {
        title: "No headline",
        body: "x",
        area: "slim-headline",
        originType: "auto",
      })) as unknown as { id: string };
      const read = (await runtime.call("get_item", { id: created.id })) as unknown as {
        headline: string | null;
      };
      // "Nobody has written one" and "someone wrote an empty one" are
      // different facts; a caller falling back to the title needs to tell
      // them apart.
      expect(read.headline).toBeNull();
    });

    it("is editable, and clearable back to null", async () => {
      const created = await makeHeavyItem({ area: "slim-headline-edit" });
      await runtime.call("update_item", { id: created.id, headline: "Rewritten as it moved" });
      const edited = (await runtime.call("get_item", { id: created.id })) as unknown as {
        headline: string | null;
      };
      expect(edited.headline).toBe("Rewritten as it moved");

      await runtime.call("update_item", { id: created.id, headline: null });
      const cleared = (await runtime.call("get_item", { id: created.id })) as unknown as {
        headline: string | null;
      };
      expect(cleared.headline).toBeNull();
    });

    it("records an edit in the ledger, like every other field change", async () => {
      const created = await makeHeavyItem({ area: "slim-headline-ledger" });
      await runtime.call("update_item", { id: created.id, headline: "A new line" });
      const events = await prisma.event.findMany({
        where: { itemId: created.id, type: "field_change" },
      });
      const headlineChange = events.find(
        (e) => (e.payload as { field?: string }).field === "headline",
      );
      // SCHEMA.md §3: "Every mutating call appends a row." A new editable
      // field that skipped the ledger would be a hole in it.
      expect(headlineChange).toBeDefined();
      expect((headlineChange!.payload as { to?: string }).to).toBe("A new line");
    });

    it("refuses a headline longer than the documented 200 characters", async () => {
      // Pinned to a literal for the same reason as the derived cap above: an
      // assertion phrased purely in terms of `HEADLINE_MAX_CHARS` moves with
      // it and can never catch the cap being widened.
      expect(HEADLINE_MAX_CHARS).toBe(200);
      const error = await runtime
        .call("create_item", {
          title: "Too much",
          headline: "z".repeat(201),
          body: "x",
          area: "slim-headline-cap",
          originType: "auto",
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields: string[] }).fields).toContain("headline");
    });

    it("accepts a headline exactly at the cap, so the refusal is a boundary and not an off-by-one", async () => {
      const atCap = "z".repeat(HEADLINE_MAX_CHARS);
      const created = (await runtime.call("create_item", {
        title: "Exactly at the cap",
        headline: atCap,
        body: "x",
        area: "slim-headline-cap",
        originType: "auto",
      })) as unknown as { id: string };
      const read = (await runtime.call("get_item", { id: created.id })) as unknown as {
        headline: string;
      };
      expect(read.headline).toBe(atCap);
    });
  });
});
