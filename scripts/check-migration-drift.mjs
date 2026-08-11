#!/usr/bin/env node
// Fails if `prisma/schema.prisma` and `prisma/migrations` have drifted apart —
// external-ref-ok-next-line: "no longer" is about this repository's own migration history, not an earlier system
// i.e. replaying the migration history no longer reproduces the committed
// schema exactly. A schema edit with no accompanying migration is exactly
// the case this exists to catch (see docs/plans/MILESTONES.md, PR #7).
//
// Needs a real, disposable Postgres to act as Prisma's shadow database —
// Prisma drops and rebuilds whatever is at SHADOW_DATABASE_URL, so it must
// never point at a database anyone cares about.
import { spawnSync } from "node:child_process";

const shadowUrl = process.env.SHADOW_DATABASE_URL;

if (!shadowUrl) {
  console.error(
    "SHADOW_DATABASE_URL is not set. Point it at an empty, disposable " +
      "Postgres database — this check drops and rebuilds it. Example:\n" +
      "  SHADOW_DATABASE_URL=postgres://standup:standup@localhost:5433/standup_shadow npm run db:check-drift",
  );
  process.exit(1);
}

// Windows resolves `npx` to `npx.cmd`, a batch file — spawning those
// requires shell:true or Node throws EINVAL. Only opt into the shell on
// Windows so Linux (CI) doesn't pay for it or trigger the args-escaping
// deprecation warning; the args here are static, never user input.
const isWindows = process.platform === "win32";
const result = spawnSync(
  isWindows ? "npx.cmd" : "npx",
  [
    "prisma",
    "migrate",
    "diff",
    "--from-migrations",
    "prisma/migrations",
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--shadow-database-url",
    shadowUrl,
    "--exit-code",
  ],
  { stdio: "inherit", shell: isWindows },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    "\nschema.prisma and prisma/migrations have drifted apart. Run " +
      "`npx prisma migrate dev` to generate a migration that reconciles " +
      "them, then commit both.",
  );
  process.exit(result.status ?? 1);
}

console.log("No drift between schema.prisma and prisma/migrations.");
