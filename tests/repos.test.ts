// Real Postgres only, per CLAUDE.md's testing tenet — a fresh scratch
// database, migrated for real with `prisma migrate deploy`, then exercised
// through a real PrismaClient. No mocked client.
//
// Needs TEST_DATABASE_URL (see tests/boot.test.ts for why that's not
// DATABASE_URL). Skips rather than fails without it.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepo, listActiveRepos, RepoAlreadyExistsError } from "@/lib/repos";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("repos — deliberate create only", () => {
  const dbName = scratchDatabaseName("repos");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("creates a repo with the fields supplied, applying the documented defaults for the rest", async () => {
    const created = await createRepo(prisma, {
      id: "web",
      displayName: "Web",
      defaultBranch: "main",
    });

    expect(created).toEqual({ id: "web", displayName: "Web", defaultBranch: "main" });

    const row = await prisma.repo.findUniqueOrThrow({ where: { id: "web" } });
    // Pins the actual defaults a bare createRepo call gets, not just the
    // subset the return value happens to echo back — needsVisualReview
    // false and host null are both load-bearing (SCHEMA.md §23.1 lists
    // `needs_visual_review` as a real column, and flipping this default to
    // `true` would silently gate every new repo on visual review).
    expect(row.needsVisualReview).toBe(false);
    expect(row.host).toBeNull();
    expect(row.archivedAt).toBeNull();
  });

  it("stores a supplied host and needsVisualReview rather than discarding them", async () => {
    await createRepo(prisma, {
      id: "infra",
      displayName: "Infra",
      defaultBranch: "main",
      host: "example-host",
      needsVisualReview: true,
    });

    const row = await prisma.repo.findUniqueOrThrow({ where: { id: "infra" } });
    expect(row.host).toBe("example-host");
    expect(row.needsVisualReview).toBe(true);
  });

  it("refuses to create a repo whose id already exists, and does not overwrite it", async () => {
    await createRepo(prisma, { id: "desktop", displayName: "Desktop", defaultBranch: "main" });

    await expect(
      createRepo(prisma, {
        id: "desktop",
        displayName: "Desktop (renamed)",
        defaultBranch: "trunk",
      }),
    ).rejects.toBeInstanceOf(RepoAlreadyExistsError);

    // The rejected call must not have mutated the existing row — proves
    // this is a real pre-check-and-refuse, not a create-then-throw that
    // still wrote first.
    const row = await prisma.repo.findUniqueOrThrow({ where: { id: "desktop" } });
    expect(row.displayName).toBe("Desktop");
    expect(row.defaultBranch).toBe("main");
  });

  it("has no auto-create path: an item referencing an unknown repo id is rejected by the foreign key, not silently backed by a new row", async () => {
    // This is the test that proves deliberate-create is structural, not
    // just "createRepo is the function we happen to call" — it exercises
    // the actual constraint an accidental auto-create path would have to
    // route around. If a future change added e.g. an upsert-on-write path
    // for repo the way areas.ts has for area, this would go from rejecting
    // to silently succeeding and creating a phantom repo row.
    await expect(
      prisma.item.create({
        data: {
          id: "item-unknown-repo",
          kind: "task",
          title: "t",
          body: "b",
          state: "someday",
          originType: "auto",
          area: "unlinked-area-should-not-exist",
          repo: "nonexistent-repo",
          mergeAuthority: "needs_approval",
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.repo.findUnique({ where: { id: "nonexistent-repo" } })).toBeNull();
  });

  it("listActiveRepos excludes archived repos", async () => {
    await createRepo(prisma, {
      id: "archived-repo",
      displayName: "Archived",
      defaultBranch: "main",
    });
    await prisma.repo.update({
      where: { id: "archived-repo" },
      data: { archivedAt: new Date() },
    });

    const active = await listActiveRepos(prisma);
    expect(active.some((r) => r.id === "archived-repo")).toBe(false);
    expect(active.some((r) => r.id === "web")).toBe(true);
  });
});
