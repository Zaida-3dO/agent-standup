/**
 * The one place that decides what a run's database situation IS, and says it
 * in a sentence a reader cannot misread.
 *
 * ── The failure this exists to catch ────────────────────────────────────
 *
 * The suite gates on `TEST_DATABASE_URL`. `DATABASE_URL` is the variable
 * everything else in this project uses, and it is the variable a newcomer
 * reaches for — `vitest.config.ts` even pins a fake one. Set only that, and
 * 133 test files gate themselves off, ~2,360 assertions never execute, and
 * the run exits 0.
 *
 * Three separate crews hit exactly this on 2026-09-16. One had three of its
 * four test changes hidden behind a green run. The reasonable guess was
 * punished, and it was punished *in silence* — which is the part that makes
 * it a defect rather than a documentation gap.
 *
 * ── What this module does, and what it deliberately does not ────────────
 *
 * It **classifies**, and it **never decides an exit code**. Callers own that.
 * The design constraint from the commissioning task is explicit: a
 * contributor without Postgres must still be able to run the ungated suite,
 * so the defect being fixed is the *indistinguishability* of a full run from
 * a partial one, not the skipping itself. Turning a skip into a failure would
 * trade a silent problem for a loud barrier.
 *
 * It also **never accepts `DATABASE_URL` as a fallback**. That option was on
 * the table and is refused on purpose: `DATABASE_URL` on a developer's
 * machine is overwhelmingly likely to point at a database they care about,
 * and the DB-backed files here do not politely read from it — they
 * `CREATE DATABASE`, clone templates, and `DROP DATABASE ... WITH (FORCE)`
 * (see `tests/helpers/global-setup.ts` and `scratch-db.ts`). A fallback that
 * is right 95% of the time and drops a developer's real database the other
 * 5% is not a convenience. So when `DATABASE_URL` is present and
 * `TEST_DATABASE_URL` is not, this says so loudly and names the variable
 * that would enable the suites — the loud message over the clever fallback.
 */

/** The variable a gated test file reads to decide whether to run. */
export const DB_URL_ENV = "TEST_DATABASE_URL";

/** The variable everything else in the project uses — and the wrong guess. */
export const APP_URL_ENV = "DATABASE_URL";

/**
 * The fake URL `vitest.config.ts` pins so PrismaClient's datasource block
 * resolves at construction time. Nothing queries it.
 *
 * It matters here because it means `DATABASE_URL` is ALWAYS set inside a
 * vitest worker, whether or not the developer set one. Treating that pinned
 * placeholder as "the developer made the reasonable guess" would fire the
 * near-miss advice on every single run, which is precisely the
 * cries-wolf failure this change exists to remove. So it is recognised and
 * discounted.
 */
export const PINNED_PLACEHOLDER_URL = "postgresql://test:test@localhost:5432/test";

/** Whether an environment variable carries an actual value. */
function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Classifies one environment into exactly one of three states.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ state: "enabled" | "near-miss" | "absent", testUrlSet: boolean, appUrlSet: boolean }}
 *   - `enabled`   — `TEST_DATABASE_URL` is set, so the gated files run.
 *   - `near-miss` — it is not, but a non-placeholder `DATABASE_URL` is. The
 *     reasonable guess, made and silently ignored.
 *   - `absent`    — neither. A plain no-database run, which is fine.
 */
export function classify(env = process.env) {
  const testUrlSet = present(env[DB_URL_ENV]);
  const appUrl = env[APP_URL_ENV];
  // The placeholder is discounted — see PINNED_PLACEHOLDER_URL.
  const appUrlSet = present(appUrl) && appUrl.trim() !== PINNED_PLACEHOLDER_URL;

  if (testUrlSet) return { state: "enabled", testUrlSet, appUrlSet };
  if (appUrlSet) return { state: "near-miss", testUrlSet, appUrlSet };
  return { state: "absent", testUrlSet, appUrlSet };
}

/**
 * The banner a human reads, as an array of lines.
 *
 * Returned as lines rather than printed so it is testable without capturing
 * a stream, and so callers can choose stdout or stderr.
 *
 * `gatedCount` and `totalCount` come from the static analysis in
 * `check-db-gated-suites.mjs`; they are passed in rather than computed here
 * so this module stays a pure classifier with no filesystem opinion.
 *
 * @param {{ state: string }} status from `classify`
 * @param {number} gatedCount how many test files carry the gate
 * @param {number} totalCount how many test files exist
 */
export function banner(status, gatedCount, totalCount) {
  const rule = "─".repeat(72);

  if (status.state === "enabled") {
    // Criterion 2: a run WITH the variable must state, equally clearly, that
    // the gated files ran. Silence here would leave the reader doing the same
    // manual verification in the healthy case as in the broken one.
    return [
      rule,
      `DATABASE-GATED SUITES: ENABLED — ${DB_URL_ENV} is set.`,
      `All ${gatedCount} of ${totalCount} database-gated test files will RUN.`,
      rule,
    ];
  }

  const lines = [
    rule,
    `DATABASE-GATED SUITES: SKIPPED — ${DB_URL_ENV} is not set.`,
    `${gatedCount} of ${totalCount} test files gate on it and will SKIP ENTIRELY.`,
    "A skip is not a failure, so this run will go GREEN having checked none",
    "of their assertions. That is expected without a database — it is only a",
    "problem if you believed those suites ran.",
  ];

  if (status.state === "near-miss") {
    // Criterion 4: the reasonable guess, answered out loud. This is the
    // branch three crews needed and did not get.
    lines.push(
      "",
      `You have ${APP_URL_ENV} set, but the suite does NOT read it — the`,
      `variable that enables these files is ${DB_URL_ENV}, and it is`,
      "deliberately separate so a test run can never create, clone or DROP",
      "databases on the server your application points at.",
      "",
      `  export ${DB_URL_ENV}="$${APP_URL_ENV}"   # only if that server is disposable`,
    );
  } else {
    lines.push("", `  npm run db:up   # then set ${DB_URL_ENV} to the URL it prints`);
  }

  lines.push("", "Run `npm run check:db-gated` to list exactly which files.", rule);
  return lines;
}
