#!/usr/bin/env node
/**
 * Reports which test files gate themselves on a database, and fails when a
 * run that was supposed to execute them did not.
 *
 * ── The failure this exists to catch ────────────────────────────────────
 *
 * A database-backed test file self-gates: `const describeIfDb = url ?
 * describe : describe.skip`. Without `TEST_DATABASE_URL` every assertion in
 * it is skipped, and a skip is **not** a failure — the run is green, the
 * summary says so, and nothing anywhere says which claims were not checked.
 *
 * That is a comfortable green with a hole in it, and the hole is not
 * hypothetical. A change once deleted a body of behaviour and left three
 * tests still asserting the deleted version; every local run skipped that
 * file and reported nothing, and the stale assertions surfaced only when
 * somebody stood up a database by hand. The tests were wrong the whole time
 * and the suite had no way to say so.
 *
 * The risk scales with the count. Most of this tree's test files carry the
 * gate, so a run without a database is a run where the majority of the
 * suite silently did nothing — while looking exactly like one where it all
 * passed.
 *
 * ── What it does ────────────────────────────────────────────────────────
 *
 * Two modes, because the question has two useful forms:
 *
 *   - **`--list` (default).** Enumerate the gated files and print the count.
 *     Answers "what am I not running", which a test summary does not say: a
 *     skipped suite and an absent one look the same in it. Always exits 0 —
 *     it is a report.
 *   - **`--require-db`.** Fail unless `TEST_DATABASE_URL` is set. This is
 *     the CI assertion: the job that exists to run the database suites
 *     should fail loudly if its environment silently stopped providing one,
 *     rather than skipping every one of them and passing. A misconfigured
 *     service container is otherwise indistinguishable from a healthy run.
 *
 * ── What a green run means, and what it does not ────────────────────────
 *
 * **A green `--require-db` run means a database URL was present and the
 * gated files were therefore not skipped for want of one. It does not mean
 * they passed, that they assert anything useful, or that they are correct.**
 * Those are `npm test`'s claims, not this script's — it reads the source
 * text and an environment variable and never runs a test.
 *
 * Two more gaps worth stating plainly rather than discovering:
 *
 *   - **It matches the gate's shape, not its meaning.** A file is counted
 *     when it mentions `TEST_DATABASE_URL` and a skip-capable `describe`
 *     binding. A file that invents a differently-spelled gate is invisible
 *     here, exactly as a new phrasing is invisible to the external-reference
 *     check, and for the same reason: a fixed set of known shapes can only
 *     certify the absence of those shapes.
 *   - **A set variable is not a reachable database.** `--require-db` proves
 *     the environment offered a URL, not that anything answered on it. A URL
 *     pointing at a closed port passes this and fails the suite, which is
 *     the right order for those two to fail in.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the suite lives. A constant so the self-test can point elsewhere. */
export const TESTS_DIR = "tests";

/** The variable a gated file reads to decide whether to run. */
export const DB_URL_ENV = "TEST_DATABASE_URL";

/**
 * The gate, as it is actually written.
 *
 * Both halves are required, and requiring both is what keeps the count
 * honest in each direction. `TEST_DATABASE_URL` alone appears in files that
 * merely *read* a connection string without gating on it; a bare
 * `describe.skip` alone is an ordinary disabled test, which is a different
 * thing entirely — visible in the summary, and skipped on purpose rather
 * than by environment.
 */
const SKIP_BINDING = /describe\.skip|\?\s*describe\s*:\s*describe\.skip/;

/** Every `.test.ts` under `dir`, recursively, as repo-relative paths. */
export function testFiles(root, dir = TESTS_DIR) {
  const absolute = path.join(root, dir);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...testFiles(root, relative));
    } else if (entry.name.endsWith(".test.ts")) {
      found.push(relative);
    }
  }
  return found;
}

/** Whether one file's text gates itself on a database being available. */
export function isDbGated(text) {
  return text.includes(DB_URL_ENV) && SKIP_BINDING.test(text);
}

/** The gated files in a tree, and the total it was drawn from. */
export function analyse(root = repoRoot) {
  const all = testFiles(root);
  const gated = all.filter((file) => isDbGated(readFileSync(path.join(root, file), "utf8")));
  return { all, gated };
}

/**
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {string} root
 */
export function main(argv = process.argv.slice(2), env = process.env, root = repoRoot) {
  const requireDb = argv.includes("--require-db");
  const { all, gated } = analyse(root);
  const haveDb = typeof env[DB_URL_ENV] === "string" && env[DB_URL_ENV].trim() !== "";

  // No test files at all means this is pointed at the wrong tree, and a
  // check that inspects nothing must not report success — the same posture
  // the database-import allowlist takes for an empty scan.
  if (all.length === 0) {
    console.error(
      `check-db-gated-suites found no ${TESTS_DIR}/**/*.test.ts files to inspect. That means this\n` +
        "check is not running against anything, which is worse than not running at all.",
    );
    return 1;
  }

  const summary = `${gated.length} of ${all.length} test file${all.length === 1 ? "" : "s"} gate on ${DB_URL_ENV}.`;

  if (requireDb && !haveDb) {
    console.error(
      `${summary}\n\n` +
        `${DB_URL_ENV} is not set, so every one of those ${gated.length} files would skip\n` +
        "its entire suite — and a skip is not a failure, so the run would go green\n" +
        "having checked none of their assertions.\n\n" +
        "This mode exists to be run where a database is meant to be present. Failing\n" +
        "here means the environment stopped providing one; a healthy run and a\n" +
        "silently skipped one are otherwise identical from the outside.",
    );
    return 1;
  }

  if (haveDb) {
    console.log(`${summary} ${DB_URL_ENV} is set, so they run.`);
    return 0;
  }

  console.log(
    `${summary} ${DB_URL_ENV} is NOT set, so their assertions will be skipped\n` +
      "and the run will be green without having checked them:\n" +
      gated.map((file) => `  ${file}`).join("\n") +
      `\n\nStand one up with \`npm run db:up\` and set ${DB_URL_ENV} to run them.`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
