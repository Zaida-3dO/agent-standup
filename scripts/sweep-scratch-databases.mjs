#!/usr/bin/env node
/**
 * Drops the scratch databases that test runs leave behind on the dev Postgres,
 * without ever dropping one that a concurrent run is still using.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * Every database-backed test file creates its own disposable database
 * (`tests/helpers/scratch-db.ts`) and drops it in `afterAll`. That teardown
 * runs on the happy path only: a worker killed by Ctrl-C, an OOM, a hard
 * timeout or a crashed run never reaches `afterAll`, and the database it
 * created stays on the server forever. Nothing else ever removes it, so the
 * leak is monotonic — by 2026-08-24 roughly 670 of them had accumulated.
 *
 * ── Why dropping them is genuinely dangerous ────────────────────────────
 *
 * A leaked database and an in-use one are INDISTINGUISHABLE BY NAME. Both
 * are `agent_standup_test_<purpose>_<token>`; the name carries no clock and
 * no owner. So the obvious approach — list the matching names, then drop the
 * list — is unsafe in exactly the way that matters: the list is a snapshot,
 * and between taking it and acting on it another agent's suite can start and
 * create databases, or the ones already listed can be picked up by a run
 * that was mid-startup.
 *
 * That is not hypothetical. On 2026-08-24 a reviewer cleaning up its own
 * scratch databases used a prefix broad enough to also match two that
 * predated it, and destroyed them. Separately, while this script was being
 * written, a `pg_stat_activity` sample taken during a full-parallelism run
 * showed live connections to a dozen `agent_standup_test_*` databases that a
 * snapshot moments earlier would have reported as idle leftovers.
 *
 * ── The two independent guards ──────────────────────────────────────────
 *
 * Both must pass for a database to be dropped, and both are evaluated at
 * DROP TIME rather than at list time:
 *
 *   1. **No connections.** Re-checked from `pg_stat_activity` immediately
 *      before each individual `DROP`, not once for the whole batch. A
 *      database anything is connected to is skipped and reported.
 *
 *   2. **Old enough.** Only databases whose files predate a cutoff
 *      (`--min-age-hours`, default 2) are eligible, read from the on-disk
 *      creation time of the database directory via `pg_stat_file`. This is
 *      the guard that covers the gap the first one cannot: a run that has
 *      *created* its databases but has no connection open to one of them at
 *      the instant it is sampled — between two test files, say — is invisible
 *      to a connection check but plainly visible as "made 4 seconds ago".
 *
 * Note that `DROP DATABASE ... WITH (FORCE)` is deliberately NOT used here.
 * FORCE terminates other sessions' connections, which is precisely the
 * behaviour that makes a mistake destructive; a plain `DROP` fails loudly if
 * a connection appeared in the microseconds after the check, which is the
 * outcome we want.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 *
 * Only names matching `agent_standup_test_*` — the shape this repo's own
 * helpers generate, including the per-run `..._template_*`. Everything else
 * on the server is left strictly alone: `standup` (the shared dev database),
 * `postgres`, and any hand-made probe or shadow database a person created,
 * whose ownership this script cannot infer and therefore does not guess.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *
 *   node scripts/sweep-scratch-databases.mjs              # dry run: report only
 *   node scripts/sweep-scratch-databases.mjs --apply      # actually drop
 *   node scripts/sweep-scratch-databases.mjs --apply --min-age-hours 24
 *
 * Dry run is the default on purpose: the first thing anyone should see is
 * the list, not the aftermath.
 */
import { Client } from "pg";

/** The only name shape this script will ever consider dropping. */
const SCRATCH_PREFIX = "agent_standup_test_";

/**
 * Databases that must never be dropped whatever else matches. `standup` is
 * the shared dev database; the rest are Postgres' own. None of them can match
 * the scratch prefix, so this is a second, independent guard: it keeps the
 * script safe even if that prefix is ever widened by mistake.
 */
const NEVER_DROP = new Set(["postgres", "standup", "template0", "template1"]);

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const i = argv.indexOf("--min-age-hours");
  const minAgeHours = i === -1 ? 2 : Number(argv[i + 1]);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    throw new Error(`--min-age-hours needs a non-negative number, got ${argv[i + 1]}`);
  }
  return { apply, minAgeHours };
}

function adminUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

/**
 * Every scratch-shaped database with its connection count and age in hours.
 *
 * Age comes from `pg_stat_file` on the database's directory under `base/`,
 * whose mtime is when Postgres created those files. Postgres records no
 * creation timestamp for a database in the catalog itself, and `pg_stat_file`
 * needs superuser or `pg_read_server_files`; when it is not permitted the
 * age reads as null and such a database is treated as NOT old enough, so a
 * missing permission makes the script more conservative rather than less.
 */
async function listCandidates(client, prefix) {
  const { rows } = await client.query(
    `select d.datname,
            (select count(*) from pg_stat_activity a where a.datname = d.datname)::int as connections,
            (select extract(epoch from (now() - (pg_stat_file('base/' || d.oid, true)).modification)) / 3600.0) as age_hours
       from pg_database d
      where not d.datistemplate
        and d.datname like $1
      order by d.datname`,
    [`${prefix}%`],
  );
  return rows;
}

async function main() {
  const { apply, minAgeHours } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Set TEST_DATABASE_URL (or DATABASE_URL) to the server to sweep.");
    process.exit(2);
  }

  const client = new Client({ connectionString: adminUrl(databaseUrl) });
  await client.connect();

  let dropped = 0;
  let failed = 0;
  const skippedConnected = [];
  const skippedYoung = [];

  try {
    const candidates = await listCandidates(client, SCRATCH_PREFIX);
    console.log(
      `${candidates.length} database(s) match ${SCRATCH_PREFIX}* on ${new URL(databaseUrl).host}`,
    );

    for (const { datname, age_hours: ageHours } of candidates) {
      if (NEVER_DROP.has(datname)) continue;

      if (ageHours === null || ageHours < minAgeHours) {
        skippedYoung.push(datname);
        continue;
      }

      // Re-read connections for THIS database immediately before dropping it,
      // rather than trusting the count from the listing above: a run can start
      // between the two, and that gap is the whole hazard this guards.
      const { rows } = await client.query(
        `select count(*)::int as connections from pg_stat_activity where datname = $1`,
        [datname],
      );
      if (rows[0].connections > 0) {
        skippedConnected.push(datname);
        continue;
      }

      if (!apply) {
        dropped += 1;
        continue;
      }

      try {
        // No WITH (FORCE): see the header. If a connection raced in after the
        // check, we want this to fail rather than to terminate that session.
        await client.query(`DROP DATABASE ${JSON.stringify(datname)}`);
        dropped += 1;
      } catch (cause) {
        failed += 1;
        console.warn(`  could not drop ${datname}: ${String(cause)}`);
      }
    }
  } finally {
    await client.end();
  }

  console.log(
    apply
      ? `dropped ${dropped}${failed ? `, ${failed} failed` : ""}`
      : `would drop ${dropped} (dry run — pass --apply to do it)`,
  );
  console.log(
    `left alone: ${skippedConnected.length} in use, ${skippedYoung.length} newer than ${minAgeHours}h`,
  );
  if (skippedConnected.length > 0) {
    console.log(`  in use: ${skippedConnected.join(", ")}`);
  }
  if (failed > 0) process.exit(1);
}

await main();
