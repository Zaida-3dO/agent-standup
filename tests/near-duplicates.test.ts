// isNearDuplicate is pure — unit-tested directly, no database needed. The
// DB-backed findNearDuplicateAreas suite below follows the same real-Postgres,
// TEST_DATABASE_URL-gated pattern as tests/repos.test.ts and tests/areas.test.ts.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findNearDuplicateAreas, isNearDuplicate } from "@/lib/near-duplicates";
import { ensureArea } from "@/lib/areas";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

describe("isNearDuplicate", () => {
  it("flags a one-character-dropped typo of a real word as a near-duplicate", () => {
    // "dashbord" is "dashboard" missing one letter — edit distance 1 on a
    // 9-character word, well inside the 20%-of-length threshold.
    expect(isNearDuplicate("dashbord", "dashboard")).toBe(true);
  });

  it("flags a singular/plural pair", () => {
    expect(isNearDuplicate("api", "apis")).toBe(true);
  });

  // The negative case the task brief calls out explicitly: something close
  // but which must NOT be flagged, so this test can actually fail if the
  // threshold logic is wrong in the permissive direction.
  it("does NOT flag two short, legitimately different areas that happen to be edit-distance 2 apart", () => {
    // "db" -> "cd" is 2 substitutions on a 2-character string — 100% of the
    // string changed, nothing in common with "near". Two genuinely
    // different two-letter areas must not be flagged as duplicates of each
    // other just for being short.
    expect(isNearDuplicate("db", "cd")).toBe(false);
  });

  it("does NOT flag two unrelated real words of similar length", () => {
    expect(isNearDuplicate("web", "infra")).toBe(false);
    expect(isNearDuplicate("frontend", "database")).toBe(false);
  });

  it("does NOT flag the documented synonym gap — normalizeAreaKey's own accepted limit", () => {
    // "web" and "website" are 4 edits apart on a 3–7 char string — a real
    // synonym pair, deliberately NOT caught by edit distance either. This
    // pins that near-duplicate surfacing does not silently solve the
    // synonym problem SCHEMA.md §23.1 explicitly leaves open.
    expect(isNearDuplicate("web", "website")).toBe(false);
  });

  it("returns false for identical strings", () => {
    expect(isNearDuplicate("web", "web")).toBe(false);
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("findNearDuplicateAreas", () => {
  const dbName = scratchDatabaseName("near-dup");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("surfaces a real near-duplicate pair created through ensureArea, alongside a negative control that must not appear", async () => {
    await ensureArea(prisma, "dashbord"); // typo, deliberately — missing one letter
    await ensureArea(prisma, "dashboard");
    // The negative control: a genuinely distinct area sharing no near-miss
    // relationship with either of the above. If findNearDuplicateAreas were
    // broken to just "return every pair", this would be the entry that
    // catches it — the assertion below requires its ABSENCE, not merely
    // the presence of the real pair.
    await ensureArea(prisma, "infrastructure");

    const pairs = await findNearDuplicateAreas(prisma);
    const ids = pairs.map((p) => [p.a.id, p.b.id].sort().join("|"));

    expect(ids).toContain(["dashbord", "dashboard"].sort().join("|"));
    expect(pairs.some((p) => p.a.id === "infrastructure" || p.b.id === "infrastructure")).toBe(
      false,
    );
  });

  it("never surfaces the same area against itself and never surfaces an archived area", async () => {
    await ensureArea(prisma, "archived-dup-source");
    await ensureArea(prisma, "archived-dup-sourcx"); // near-miss of the above
    await prisma.area.update({
      where: { id: "archived-dup-sourcx" },
      data: { archivedAt: new Date() },
    });

    const pairs = await findNearDuplicateAreas(prisma);
    expect(pairs.every((p) => p.a.id !== p.b.id)).toBe(true);
    expect(
      pairs.some((p) => p.a.id === "archived-dup-sourcx" || p.b.id === "archived-dup-sourcx"),
    ).toBe(false);
  });
});
