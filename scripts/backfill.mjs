#!/usr/bin/env node
/**
 * Runs a backfill from a shell, against a database named on the command
 * line, and verifies what landed (docs/plans/BACKFILL.md).
 *
 *   node scripts/backfill.mjs --payload <file.json> --database-url <url>
 *
 * Options (each also settable by environment variable — the flag wins):
 *
 *   --payload <file>          BACKFILL_PAYLOAD                 required
 *   --database-url <url>      DATABASE_URL                     required
 *   --create-missing-repos    BACKFILL_CREATE_MISSING_REPOS=true
 *   --strict-actors           BACKFILL_STRICT_ACTORS=true
 *   --sample-size <n>         BACKFILL_SAMPLE_SIZE             default 20
 *   --twice                   run twice and prove the second run is a no-op
 *
 * **There is no default payload and no default database.** A tool that
 * knows a path only works on the machine it was written on, and one that
 * knows a database can be aimed at the wrong one by accident.
 *
 * This entry point does NOT check `ENABLE_BACKFILL`. That gate exists to
 * keep the *served* surface — HTTP, MCP, the command line talking to a
 * running server — absent during normal operation. This script is not a
 * served surface: it is somebody at a shell with the database URL already
 * in their hand, which is strictly more access than the gate protects. It
 * is the door used during the backfill window itself.
 *
 * ── Why this file is JavaScript and bundles its own logic ───────────────
 *
 * The logic lives in TypeScript under `src/lib/backfill/`, where it is
 * typechecked and unit-tested. Node cannot execute that directly — the
 * modules resolve through this repo's `@/` path alias, a TypeScript-only
 * rule. So this does what `scripts/build-cli.mjs` does for the published
 * binary: esbuild turns the entry module into plain, alias-free JavaScript,
 * which is then imported and called. The only logic here is that plumbing
 * plus constructing the database client — deliberately, because the client
 * constructor may not be imported from `src/` (CLAUDE.md, "Working in this
 * repo"; enforced by `scripts/check-db-import-allowlist.mjs`).
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { PrismaClient } from "@prisma/client";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The bundle is written **inside the repository's own `node_modules`**, not
 * to the system temp directory. `packages: "external"` leaves
 * `@prisma/client` as a bare import in the output, and Node resolves a bare
 * import by walking up from the importing file — from a temp directory that
 * walk never reaches this repo's `node_modules` and the import fails at run
 * time. `node_modules/.cache` is already ignored by git, so nothing here
 * can end up committed.
 */
const cacheRoot = path.join(repoRoot, "node_modules", ".cache");

async function loadRunner(outDir) {
  const outfile = path.join(outDir, "backfill-runner.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "src/lib/backfill/runner.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    alias: { "@": path.join(repoRoot, "src") },
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

/**
 * Whether a run may be reported as successful.
 *
 * History retention is part of the exit code, not merely part of the
 * printed report: an operator running a one-shot load reads the exit code
 * before they read the text, and a run that lost history has failed
 * whatever else reconciled.
 */
function verificationPassed(report) {
  return (
    report.verification.items.matches &&
    report.verification.historyRetention.matches &&
    report.verification.findingsRetention.matches
  );
}

async function main() {
  await mkdir(cacheRoot, { recursive: true });
  const outDir = await mkdtemp(path.join(cacheRoot, "standup-backfill-"));
  let prisma;
  try {
    const runner = await loadRunner(outDir);
    const options = runner.resolveRunnerOptions(process.argv.slice(2), process.env);

    // Validated before a connection is opened: a payload that cannot be
    // accepted should cost nothing but the read.
    const payload = runner.parsePayload(JSON.parse(await readFile(options.payloadFile, "utf-8")));

    prisma = new PrismaClient({ datasources: { db: { url: options.databaseUrl } } });

    if (options.twice) {
      const check = await runner.runBackfillTwice(prisma, payload, options);
      console.log(runner.formatIdempotencyCheck(check));
      return check.idempotent && verificationPassed(check.first) ? 0 : 1;
    }

    const report = await runner.runBackfill(prisma, payload, options);
    console.log(runner.formatRunReport(report));
    return verificationPassed(report) ? 0 : 1;
  } finally {
    if (prisma) await prisma.$disconnect();
    await rm(outDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
