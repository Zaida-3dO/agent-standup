#!/usr/bin/env node
// Scratch-only fixture for measuring the board at narrow widths (row
// 74ef86fb-9da8-4ab1-9b63-9eb84bd43ee6). NOT part of the product's seed —
// this is throwaway data for one crew's own scratch database, deleted with
// it. Run with DATABASE_URL pointed at that scratch DB.
//
// Self-sufficient: also upserts the two `Person` rows (`user-a` / `user-b`)
// via `prisma/seed.mjs`'s exported `seed()`, the same idempotent upsert
// `npm run db:seed` uses. Without one of them, `/board` never gets past the
// `ProfilePicker` and `measure-board-mobile.mjs`'s default `--profile
// "User A"` has no row to click — the harness then correctly reports "zero
// tap targets" rather than a false clean sweep, but the page never renders
// what this fixture exists to measure.
//
// One prerequisite this script cannot satisfy itself: the server it measures
// against must be started with `STANDUP_TOKENS=browser:<any-value>` set, or
// `/api/people` fail-closes with a 503 ("The front end has no credential to
// call the API with") and the picker shows nothing to click either. See
// README.md's Authentication section for the token format.
import { PrismaClient } from "@prisma/client";
import { seed } from "../prisma/seed.mjs";

const prisma = new PrismaClient();

const AREAS = ["web", "infra", "docs"];
const REPOS = ["agent-standup"];
const STATES = [
  "someday",
  "on_deck",
  "planning",
  "plan_review",
  "executing",
  "in_review",
  "paused",
  "blocked",
  "merged",
];
const PRIORITIES = ["P0", "P1", "P2", "P3"];

async function main() {
  await seed(prisma);

  for (const id of AREAS) {
    await prisma.area.upsert({
      where: { id },
      update: {},
      create: { id, displayName: id },
    });
  }
  for (const id of REPOS) {
    await prisma.repo.upsert({
      where: { id },
      update: {},
      create: { id, displayName: id },
    });
  }

  let n = 0;
  for (const state of STATES) {
    for (let i = 0; i < 6; i++) {
      n += 1;
      const id = `scratch-fixture-${n}`;
      await prisma.item.upsert({
        where: { id },
        update: {},
        create: {
          id,
          kind: "task",
          // The board's DEFAULT level filter is `include: [1]`
          // (`defaultLevelFilter` in `@/lib/board/filters`) — a task with no
          // explicit `depth` inherits the schema default of 0 and is
          // invisible on first load. Set explicitly so this fixture actually
          // renders under the query the board opens with.
          depth: 1,
          title: `Fixture item ${n} — ${state.replace(/_/g, " ")} sample title for width measurement`,
          body: "Fixture body for touch-target measurement.",
          state,
          priority: PRIORITIES[n % PRIORITIES.length],
          originType: "auto",
          area: AREAS[n % AREAS.length],
          repo: REPOS[0],
          mergeAuthority: "needs_approval",
        },
      });
    }
  }
  console.log(`Seeded ${n} scratch board items.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
