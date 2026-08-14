// Real Postgres only, per CLAUDE.md's testing tenet. See tests/repos.test.ts
// for the scratch-database setup this mirrors. Skips without TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureArea, InvalidAreaNameError, listActiveAreas, normalizeAreaKey } from "@/lib/areas";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

describe("normalizeAreaKey", () => {
  // Each case below asserts on inputs that normalise DIFFERENTLY from each
  // other or from an obvious wrong implementation — not round-trips of the
  // same value, which would pass even with normalisation deleted entirely.

  it("lowercases", () => {
    expect(normalizeAreaKey("Web")).toBe("web");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeAreaKey("  web  ")).toBe("web");
  });

  it("collapses internal separator runs (space, hyphen, underscore, slash) to a single hyphen", () => {
    expect(normalizeAreaKey("web  site")).toBe("web-site");
    expect(normalizeAreaKey("web__site")).toBe("web-site");
    expect(normalizeAreaKey("web//site")).toBe("web-site");
    expect(normalizeAreaKey("web---site")).toBe("web-site");
  });

  it("makes case-and-separator variants of the SAME name collide on one id", () => {
    // The load-bearing property: these four spellings must all produce the
    // identical key, because that identity is what makes ensureArea's
    // find-or-create actually find instead of always creating.
    const variants = ["Web Site", "web-site", "WEB_SITE", "  web/site  "];
    const keys = variants.map(normalizeAreaKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("web-site");
  });

  it("does NOT collapse different words onto the same id — the documented limit, not a bug", () => {
    // "web" and "website" are a genuine synonym pair, not a separator
    // variant. Normalisation must leave them distinct — that gap is what
    // near-duplicates.ts exists to surface instead of hide.
    expect(normalizeAreaKey("web")).not.toBe(normalizeAreaKey("website"));
  });

  it("normalises a name that is only separators to an empty string", () => {
    expect(normalizeAreaKey("   ---   ")).toBe("");
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("ensureArea — auto-create with normalisation", () => {
  const dbName = scratchDatabaseName("areas");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("creates an area on first use with no prior row required — the auto-create half", async () => {
    const before = await prisma.area.findUnique({ where: { id: "web" } });
    expect(before).toBeNull();

    const result = await ensureArea(prisma, "Web");
    expect(result).toEqual({ id: "web", displayName: "Web" });

    const after = await prisma.area.findUniqueOrThrow({ where: { id: "web" } });
    expect(after.displayName).toBe("Web");
  });

  it("a second call with a differently-spelled variant of the SAME name reuses the row rather than creating a second one", async () => {
    await ensureArea(prisma, "Infra Tools");
    const secondCall = await ensureArea(prisma, "  infra_tools  ");

    expect(secondCall.id).toBe("infra-tools");

    const rows = await prisma.area.findMany({ where: { id: "infra-tools" } });
    expect(rows).toHaveLength(1);
    // The FIRST write's display name is preserved, not overwritten by the
    // second call's differently-cased spelling — proves this is a real
    // find-then-keep, not a blind upsert that would clobber a name that may
    // have been deliberately edited since.
    expect(rows[0]?.displayName).toBe("Infra Tools");
  });

  it("concurrent first-use calls for the same normalised name still produce exactly one row", async () => {
    const [a, b, c] = await Promise.all([
      ensureArea(prisma, "concurrent area"),
      ensureArea(prisma, "Concurrent Area"),
      ensureArea(prisma, "CONCURRENT-AREA"),
    ]);

    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);

    const rows = await prisma.area.findMany({ where: { id: "concurrent-area" } });
    expect(rows).toHaveLength(1);
  });

  it("rejects a name that normalises to empty rather than creating a blank-id row", async () => {
    await expect(ensureArea(prisma, "   ---   ")).rejects.toBeInstanceOf(InvalidAreaNameError);

    const rows = await prisma.area.findMany({ where: { id: "" } });
    expect(rows).toHaveLength(0);
  });

  it("listActiveAreas excludes archived areas", async () => {
    await ensureArea(prisma, "to-archive");
    await prisma.area.update({ where: { id: "to-archive" }, data: { archivedAt: new Date() } });

    const active = await listActiveAreas(prisma);
    expect(active.some((a) => a.id === "to-archive")).toBe(false);
    expect(active.some((a) => a.id === "web")).toBe(true);
  });

  it("an item can be written against an area created only by ensureArea's auto-create path — proves the FK is really wired, not just the table", async () => {
    await ensureArea(prisma, "fk-check-area");

    const item = await prisma.item.create({
      data: {
        id: "item-fk-check",
        kind: "task",
        title: "t",
        body: "b",
        state: "someday",
        originType: "auto",
        area: "fk-check-area",
        mergeAuthority: "needs_approval",
      },
    });

    expect(item.area).toBe("fk-check-area");
  });
});
