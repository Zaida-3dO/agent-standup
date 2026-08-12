#!/usr/bin/env node
// Seeds the fixed, small reference data every installation needs before it
// is useful: two user profiles (docs/plans/SCHEMA.md §8a — "seeded with two
// rows, nothing in the schema is capped at two"), the starting crew-name
// roster (§9), and an example account (§15). Everything else — items,
// events, artifacts — starts empty; a fresh database boots fully working
// with no configuration at all (§17.2), and seed data is the one exception
// to that because these three tables have no other way to get their first
// rows: nobody "creates" the profile picker's first profile from the UI.
//
// Placeholders only — this repository is public (CLAUDE.md). `user-a` /
// `user-b` and the crew names below are generic, invented identifiers, not
// real people or the operator's actual crew roster.
//
// Idempotent: every write is an upsert keyed on the row's real primary key,
// so running this against a database that already has these rows changes
// nothing — no duplicate rows, no error, same end state either way. That is
// what makes it safe for `standup init` (#80) to call on every run, not just
// the first.
import { PrismaClient } from "@prisma/client";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 */
export async function seed(prisma) {
  const people = await Promise.all([
    prisma.person.upsert({
      where: { id: "user-a" },
      update: { displayName: "User A" },
      create: { id: "user-a", displayName: "User A" },
    }),
    prisma.person.upsert({
      where: { id: "user-b" },
      update: { displayName: "User B" },
      create: { id: "user-b", displayName: "User B" },
    }),
  ]);

  // A starting name roster for the crew-naming mechanism (#34: "hand out a
  // name, assign it, retire it"). These are never self-chosen and never
  // reused for a real person — see agents.name in SCHEMA.md §9. Kept
  // deliberately small and generic; more can be inserted later the same way
  // minting adds a repository (§13g) — a data operation at runtime, not a
  // migration.
  const agentNames = ["agent-alpha", "agent-bravo", "agent-charlie", "agent-delta"];
  const agents = await Promise.all(
    agentNames.map((name) =>
      prisma.agent.upsert({
        where: { name },
        update: {},
        create: { name },
      }),
    ),
  );

  // One example account so `machines`/`accounts` wiring (§15) has something
  // to point at before an installation configures its own. `subscription`
  // plan type matches the default in the example config throughout the
  // docs — a metered account is exactly as easy to add later as a second
  // repository is (§13g).
  const accounts = await Promise.all([
    prisma.account.upsert({
      where: { id: "account-a" },
      update: { vendor: "anthropic", displayName: "Account A", planType: "subscription" },
      create: {
        id: "account-a",
        vendor: "anthropic",
        displayName: "Account A",
        planType: "subscription",
      },
    }),
  ]);

  return { people, agents, accounts };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — see .env.example.");
  }
  // No pool tuning here — unlike src/lib/prisma.ts's long-lived server
  // singleton, this is a short one-shot script making a handful of
  // sequential upserts, so Prisma's own per-host default is fine. Scripts
  // under scripts/ never import from src/ (TypeScript) for the same reason
  // run-migrations.mjs and wait-for-db.mjs keep their own logic
  // self-contained rather than reaching into the app.
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const result = await seed(prisma);
    console.log(
      `Seeded ${result.people.length} people, ${result.agents.length} agents, ` +
        `${result.accounts.length} accounts.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run as a script (`prisma db seed` / `node prisma/seed.mjs`), never on
// import — tests import `seed` directly against a scratch database.
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
