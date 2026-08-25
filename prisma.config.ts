// Prisma configuration.
//
// **Why this file exists rather than a `prisma` key in `package.json`.**
// That key is deprecated and is removed in Prisma 7, which made it a dated
// deprecation rather than an open-ended one: the same configuration had to
// move eventually, and moving it under a forced major upgrade means doing
// it while something else is already broken. Prisma prefers this file when
// it is present, so the two must not both exist — the package.json key was
// removed in the same commit that added this.
//
// **The seed command moved from the top-level `seed` key to
// `migrations.seed`.** The nesting is not cosmetic: a `seed` at the top
// level of this file is not part of the config type and is ignored, which
// would leave `prisma migrate reset` silently running no seed at all. The
// command is spelled exactly as the `db:seed` script spells it, because
// `migrate reset` runs this one while a developer runs that one, and the
// two drifting apart is the failure this comment exists to prevent.
import { defineConfig } from "@prisma/config";

// **Loading `.env` is this file's other job, and it is a regression fix
// rather than a nicety.** Prisma loads `.env` itself *only* when there is
// no config file; the moment one exists it prints "Prisma config detected,
// skipping environment variable loading" and leaves `DATABASE_URL` unset.
// Without the call below, migrating this config would have broken every
// local `prisma validate` / `generate` / `migrate deploy` for anyone whose
// connection string lives in `.env` — silently, and only for humans, since
// CI passes `DATABASE_URL` as a real environment variable and would have
// stayed green throughout.
//
// `process.loadEnvFile` is Node's built-in (>=20.12; this repo requires
// >=24) and is used deliberately in preference to `dotenv`, which is
// present in the tree only as a transitive dependency of Prisma's own
// `c12` — importing it here would be a phantom dependency that a future
// Prisma upgrade could remove without warning.
//
// A missing `.env` is the normal case in CI and in a fresh clone, so it is
// not an error; anything else (an unreadable or malformed file) is worth
// surfacing rather than swallowing.
try {
  process.loadEnvFile();
} catch (error) {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code !== "ENOENT") throw error;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "node prisma/seed.mjs",
  },
});
