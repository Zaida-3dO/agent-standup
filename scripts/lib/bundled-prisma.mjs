#!/usr/bin/env node
// Locates this install's `prisma/` directory for the two scripts that shell
// out to things living inside it.
//
// **Why a lookup rather than trusting `cwd`.** `runMigrations` shells out
// to `prisma migrate deploy` and `runSeed` to `prisma/seed.mjs`. Addressed
// relatively, both resolve against the process's working directory, which
// is the repository root for `npm run` in a checkout and for the Docker
// image — and is the user's own project directory for the case this module
// exists for: `standup init` from an npm install, where the package itself
// lives off in `node_modules/agent-standup`.
//
// The failure that causes is not subtle. `standup init --database-url ...`
// dies at its *first* step with
//
//     Could not find Prisma Schema that is required for this command.
//     Checked following paths:
//     schema.prisma: file not found
//     prisma\schema.prisma: file not found
//
// followed by `FATAL: database migration failed`. So the documented remedy
// for a broken install could not itself run — which is why this is resolved
// module-relatively rather than left to `cwd`.
//
// Note that esbuild bundles these scripts into `dist/`, so the compiled
// copy sits one level deep in the package rather than in `scripts/lib/`.
// That is exactly why the walk below is a walk and not a fixed `../../`.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory containing `schema.prisma`, or `null` if this install has
 * none.
 *
 * Searches the working directory **first**, then walks up from this
 * module's own location. The order matters and is deliberate: a developer
 * running from a checkout must get that checkout's schema and migrations
 * even when an `agent-standup` package is also installed in its
 * `node_modules`, or `standup init` would migrate against a schema that is
 * not the one they are working on.
 *
 * @param {string} [cwd] working directory to prefer
 * @returns {string | null}
 */
export function findPrismaDir(cwd = process.cwd()) {
  const fromCwd = path.join(cwd, "prisma");
  if (existsSync(path.join(fromCwd, "schema.prisma"))) return fromCwd;

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up <= 4; up += 1) {
    const candidate = path.join(dir, "prisma");
    if (existsSync(path.join(candidate, "schema.prisma"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}
