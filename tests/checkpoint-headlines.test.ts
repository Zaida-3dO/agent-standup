// MILESTONES.md #108 — checkpoint headlines.
//
// **What would make this file hollow, stated first so it can be checked.**
// A checkpoint's headline has two sources — a stored column and a fallback
// derived from the prose — and the easy mistake is a suite that only ever
// exercises one of them. A test that always supplies a headline never proves
// the fallback exists; a test that never supplies one never proves the
// stored value is read at all, because the derivation would answer both
// cases plausibly. So every assertion below names which source it is
// testing, and the **precedence** between them (stored always wins) has its
// own case, because that is the single behaviour neither source's tests can
// see on their own.
//
// The pure half — the derivation and the precedence rule — needs no database
// and is asserted first. Everything after it is a real round trip through
// Postgres, because what is being proved is that a column is written and
// read back, and skips without TEST_DATABASE_URL like every other DB-backed
// file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  CHECKPOINT_HEADLINE_MAX_CHARS,
  checkpointHeadline,
  deriveHeadlineFromBody,
} from "@/lib/service/items/checkpoint-headline";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describe("deriving a headline from checkpoint prose", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(deriveHeadlineFromBody("  Migration is applied.  \nRoutes next.")).toBe(
      "Migration is applied.",
    );
  });

  it("skips leading blank lines rather than returning an empty headline", () => {
    expect(deriveHeadlineFromBody("\n\n   \nActually started here.")).toBe(
      "Actually started here.",
    );
  });

  it("returns null for prose that is empty, whitespace, or absent", () => {
    // Three distinct inputs that all mean "nothing to derive". A caller
    // shows nothing rather than an empty line, so they have to be null and
    // not "".
    expect(deriveHeadlineFromBody("")).toBeNull();
    expect(deriveHeadlineFromBody("   \n\t\n ")).toBeNull();
    expect(deriveHeadlineFromBody(null)).toBeNull();
  });

  it("caps the derived line at the documented 200 characters", () => {
    // Pinned to literals, not to the constant. `repeat(MAX + 50)` asserted
    // against `toHaveLength(MAX)` follows the constant wherever it moves and
    // so can never fail on a widened cap — it asserts only that the function
    // agrees with itself, which was never in doubt.
    expect(CHECKPOINT_HEADLINE_MAX_CHARS).toBe(200);
    expect(deriveHeadlineFromBody("x".repeat(500))).toHaveLength(200);
  });

  it("marks a capped line as truncated rather than silently shortening it", () => {
    const derived = deriveHeadlineFromBody("x".repeat(CHECKPOINT_HEADLINE_MAX_CHARS + 50));
    expect(derived?.endsWith("…")).toBe(true);
  });

  it("leaves a line exactly at the cap alone, so the cap is a boundary and not an off-by-one", () => {
    const exact = "y".repeat(CHECKPOINT_HEADLINE_MAX_CHARS);
    expect(deriveHeadlineFromBody(exact)).toBe(exact);
  });
});

describe("which source a checkpoint's headline comes from", () => {
  it("uses the stored headline when there is one", () => {
    expect(checkpointHeadline({ headline: "Stored line", body: "Prose line\nmore" })).toBe(
      "Stored line",
    );
  });

  it("falls back to the prose when there is no stored headline", () => {
    expect(checkpointHeadline({ headline: null, body: "Prose line\nmore" })).toBe("Prose line");
  });

  it("prefers the stored headline even when the prose would derive a different one", () => {
    // The precedence case. Both sources are populated and they disagree, so
    // an implementation that read the wrong one — or that derived first and
    // only used the column as *its* fallback — fails here and nowhere else.
    const picked = checkpointHeadline({
      headline: "What the writer meant",
      body: "An unrelated opening line",
    });
    expect(picked).toBe("What the writer meant");
    expect(picked).not.toBe("An unrelated opening line");
  });

  it("returns null only when neither source has anything", () => {
    expect(checkpointHeadline({ headline: null, body: null })).toBeNull();
    expect(checkpointHeadline({ headline: null, body: "   " })).toBeNull();
  });
});

describeIfDb("checkpoint headlines against Postgres", () => {
  const dbName = scratchDatabaseName("ckpt_headlines");
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
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (scratchUrl) await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  let seq = 0;

  /** An item with a live claim, so `checkpoint` has an assignment to attribute to. */
  async function itemWithSession(): Promise<{ itemId: string; sessionId: string }> {
    seq += 1;
    const sessionId = `session-ckpt-${seq}`;
    const item = (await runtime.call("create_item", {
      title: `Checkpointed ${seq}`,
      body: "x",
      area: "checkpoint-headlines",
      originType: "auto",
    })) as { id: string };
    await runtime.call("claim", {
      itemId: item.id,
      sessionId,
      role: "builder",
      holderType: "agent",
      holderId: `crew-${seq}`,
      machine: "laptop",
    });
    return { itemId: item.id, sessionId };
  }

  async function storedHeadline(itemId: string): Promise<string | null> {
    const rows = await prisma.$queryRawUnsafe<{ headline: string | null }[]>(
      `SELECT "headline" FROM "Event" WHERE "itemId" = $1 AND "type" = 'checkpoint'::"EventType" ORDER BY "id" DESC LIMIT 1`,
      itemId,
    );
    return rows[0]?.headline ?? null;
  }

  describe("writing one", () => {
    it("stores the headline on the event row, beside the prose", async () => {
      const { itemId, sessionId } = await itemWithSession();
      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        body: "Long prose about what was tried.",
        headline: "Migration applied",
      });
      // Read straight off the column, not through any operation: the point
      // of this assertion is that the value reached the database at all.
      expect(await storedHeadline(itemId)).toBe("Migration applied");
    });

    it("stores null when none is given, rather than inventing one at write time", async () => {
      const { itemId, sessionId } = await itemWithSession();
      await runtime.call("checkpoint", { itemId, sessionId, body: "First line.\nSecond." });
      // Deriving at *write* time would look identical to a reader and be
      // wrong: it would freeze a guess into the ledger, where a later
      // improvement to the derivation could never reach it, and it would
      // make "the writer supplied a headline" unanswerable forever after.
      expect(await storedHeadline(itemId)).toBeNull();
    });

    it("keeps the prose intact — a headline is beside `body`, not instead of it", async () => {
      const { itemId, sessionId } = await itemWithSession();
      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        body: "The full account of what happened.",
        headline: "Short version",
      });
      const rows = await prisma.$queryRawUnsafe<{ body: string | null }[]>(
        `SELECT "body" FROM "Event" WHERE "itemId" = $1 AND "type" = 'checkpoint'::"EventType" ORDER BY "id" DESC LIMIT 1`,
        itemId,
      );
      expect(rows[0]?.body).toBe("The full account of what happened.");
    });

    it("refuses a headline longer than the documented 200 characters", async () => {
      const { itemId, sessionId } = await itemWithSession();
      expect(CHECKPOINT_HEADLINE_MAX_CHARS).toBe(200);
      const error = await runtime
        .call("checkpoint", { itemId, sessionId, body: "x", headline: "z".repeat(201) })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields: string[] }).fields).toContain("headline");
    });

    it("accepts one exactly at the cap", async () => {
      const { itemId, sessionId } = await itemWithSession();
      const atCap = "z".repeat(CHECKPOINT_HEADLINE_MAX_CHARS);
      await runtime.call("checkpoint", { itemId, sessionId, body: "x", headline: atCap });
      expect(await storedHeadline(itemId)).toBe(atCap);
    });

    it("still refuses a checkpoint with no live assignment, headline or not", async () => {
      // The new optional field must not have widened what the operation
      // accepts. A guard that stopped firing because an input schema grew is
      // the kind of regression an additive change makes easy.
      const item = (await runtime.call("create_item", {
        title: "Unclaimed",
        body: "x",
        area: "checkpoint-headlines",
        originType: "auto",
      })) as { id: string };
      const error = await runtime
        .call("checkpoint", {
          itemId: item.id,
          sessionId: "a-session-holding-nothing",
          body: "x",
          headline: "Should not land",
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("conflict");
    });
  });

  describe("reading it back through orientation", () => {
    it("returns the stored headline", async () => {
      const { itemId, sessionId } = await itemWithSession();
      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        body: "Prose that opens with something else entirely.",
        headline: "Routes are wired",
      });
      const result = (await runtime.call("orientation", { itemId })) as {
        checkpoint: { headline: string | null; body: string | null } | null;
      };
      expect(result.checkpoint?.headline).toBe("Routes are wired");
      // And the prose is still there — a read that swapped one for the other
      // would satisfy the assertion above on its own.
      expect(result.checkpoint?.body).toBe("Prose that opens with something else entirely.");
    });

    it("derives one from the prose when the checkpoint carries none", async () => {
      const { itemId, sessionId } = await itemWithSession();
      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        body: "Derived from this line.\nAnd not from this one.",
      });
      const result = (await runtime.call("orientation", { itemId })) as {
        checkpoint: { headline: string | null } | null;
      };
      // The fallback is what makes this field useful over checkpoints
      // recorded before it existed, which is most of any real corpus.
      expect(result.checkpoint?.headline).toBe("Derived from this line.");
    });

    it("reads the latest checkpoint's headline, not the first", async () => {
      const { itemId, sessionId } = await itemWithSession();
      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        body: "x",
        headline: "First thing recorded",
      });
      await runtime.call("checkpoint", {
        itemId,
        sessionId,
        body: "x",
        headline: "Second thing recorded",
      });
      const result = (await runtime.call("orientation", { itemId })) as {
        checkpoint: { headline: string | null } | null;
      };
      // An ordering that read ascending would pass every other assertion in
      // this file and answer "where is this up to" with a stale line.
      expect(result.checkpoint?.headline).toBe("Second thing recorded");
    });

    it("returns no checkpoint at all for an item that has never had one", async () => {
      const item = (await runtime.call("create_item", {
        title: "Never checkpointed",
        body: "x",
        area: "checkpoint-headlines",
        originType: "auto",
      })) as { id: string };
      const result = (await runtime.call("orientation", { itemId: item.id })) as {
        checkpoint: unknown;
      };
      expect(result.checkpoint).toBeNull();
    });
  });
});

// The HTTP surface gets its own block because `service/live.ts`'s exported
// `service` is process-global: `DATABASE_URL` has to point at the scratch
// database *before* the route module is imported. That ordering constraint
// is the same one `tests/claims-routes.test.ts` and `tests/items-routes.test.ts`
// document, and it cannot be satisfied from inside a block that has already
// built its own runtime.
describeIfDb("a checkpoint headline over HTTP", () => {
  const dbName = scratchDatabaseName("ckpt_headline_route");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let checkpointRoute: typeof import("@/app/api/checkpoints/route");
  let claimRoute: typeof import("@/app/api/claims/route");
  let itemsRoute: typeof import("@/app/api/items/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    checkpointRoute = await import("@/app/api/checkpoints/route");
    claimRoute = await import("@/app/api/claims/route");
    itemsRoute = await import("@/app/api/items/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (scratchUrl) await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function post(url: string, body: unknown): Request {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("carries a headline through POST /api/checkpoints onto the event row", async () => {
    // Driven through the real route handler rather than the service,
    // because an optional field the adapter silently dropped would be
    // invisible to every service-level test above — and HTTP is how
    // anything outside this process writes a checkpoint at all.
    const created = (await itemsRoute
      .POST(
        post("http://localhost/api/items", {
          title: "Over the wire",
          body: "x",
          area: "ckpt-route",
          originType: "auto",
        }),
      )
      .then((r) => r.json())) as { item: { id: string } };

    const claimed = await claimRoute.POST(
      post("http://localhost/api/claims", {
        itemId: created.item.id,
        sessionId: "session-route-1",
        role: "builder",
        holderType: "agent",
        holderId: "crew-route",
        machine: "laptop",
      }),
    );
    expect(claimed.status).toBe(201);

    const response = await checkpointRoute.POST(
      post("http://localhost/api/checkpoints", {
        itemId: created.item.id,
        sessionId: "session-route-1",
        body: "Over HTTP.",
        headline: "Wire-level",
      }),
    );
    expect(response.status).toBe(201);

    const rows = await prisma.$queryRawUnsafe<{ headline: string | null }[]>(
      `SELECT "headline" FROM "Event" WHERE "itemId" = $1 AND "type" = 'checkpoint'::"EventType" ORDER BY "id" DESC LIMIT 1`,
      created.item.id,
    );
    expect(rows[0]?.headline).toBe("Wire-level");
  });

  it("refuses an over-long headline through the route with a 400, not a 500", async () => {
    // The cap is enforced in the operation's schema; this proves the
    // adapter surfaces that as `invalid_input` rather than swallowing it
    // into an internal error, which is the difference between a caller who
    // can fix their input and one who cannot.
    const created = (await itemsRoute
      .POST(
        post("http://localhost/api/items", {
          title: "Over the wire, too long",
          body: "x",
          area: "ckpt-route",
          originType: "auto",
        }),
      )
      .then((r) => r.json())) as { item: { id: string } };

    const response = await checkpointRoute.POST(
      post("http://localhost/api/checkpoints", {
        itemId: created.item.id,
        sessionId: "session-route-2",
        body: "x",
        headline: "z".repeat(201),
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; fields: string[] } };
    expect(payload.error.code).toBe("invalid_input");
    expect(payload.error.fields).toContain("headline");
  });
});
