#!/usr/bin/env node
/**
 * Builds the standalone, servable copy of each hook variant's script —
 * MILESTONES.md #125(b): `GET /hook/script?variant=<variant>` has to hand a
 * caller one file it can write straight to disk and wire up, not a directory
 * tree.
 *
 * ── Why this is a second build, not a reuse of `dist/bin/standup-hook.js` ─
 *
 * `build-cli.mjs`'s own build uses `splitting: true` so the published
 * `standup` binary can defer loading the database client until the `direct`
 * binding is actually selected (see that file's header). Splitting is
 * exactly wrong here: it produces an entry file that `import`s hashed chunk
 * files sitting *beside* it, and the whole point of this route is that a
 * caller fetches **one URL** and gets something it can drop in place. A
 * split entry point served alone is missing the chunks it needs to run.
 *
 * So each variant gets its own `outfile` (not `outdir`), `bundle: true`,
 * `splitting: false` (the esbuild default, named for clarity) — a flat,
 * self-contained file. The published npm package still gets the split build
 * for the reason `build-cli.mjs` documents; this build exists only to be
 * served.
 *
 * ── Why keyed by variant, not by entry point ───────────────────────────
 *
 * `HOOK_SCRIPT_ENTRY_POINTS` is a map from `HookVariant` (`build-constants.ts`)
 * to the source file that implements it. Only `http` has one —
 * `src/bin/standup-hook.ts` reaches the server over `POST /api/hook`
 * (`src/lib/hook/ask-http.ts`), which is the HTTP hook protocol
 * (`src/lib/hook/protocol.ts`'s `SHIPPED_HOOK_VARIANT`). `cli` is a real,
 * versioned slot in the schema (SCHEMA.md §21's `hook_variant` column) with
 * no script built for it yet, and the route this build feeds has to answer
 * that case honestly (not found, not "unknown variant") rather than by this
 * script silently producing nothing for it. Adding the `cli` hook is then
 * one entry in this map, not a second build script.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** `HookVariant -> source entry point`, for every variant that has a script built. */
export const HOOK_SCRIPT_ENTRY_POINTS = Object.freeze({
  http: "src/bin/standup-hook.ts",
});

export const HOOK_SCRIPTS_DIR = "dist/hook-scripts";

/**
 * The identifier this build stamps into the artifact when git cannot name a
 * commit. Kept in step with `UNSTAMPED` in `src/lib/hook/build-stamp.ts`,
 * which `tests/hook-build-stamp.test.ts` asserts — the two are deliberately
 * separate files (one is bundled into the artifact, one drives the bundler)
 * so the value is repeated exactly once and the repetition is checked.
 */
export const UNSTAMPED = "unstamped";

/**
 * The environment variable a build supplies its own commit through.
 *
 * -- Why an environment variable and not `git` --------------------------
 *
 * The Docker build has no `.git` -- it copies `package.json`, `prisma` and
 * `scripts`, not the repository -- so `git rev-parse HEAD` throws there every
 * single time, and this build stamped {@link UNSTAMPED} into every image ever
 * released. The value was not merely wrong at runtime: esbuild's `define` is
 * a textual substitution, so `unstamped` was compiled into the bundle as a
 * literal and `GET /api/hook/script` served
 * `BUILD_COMMIT = true ? "unstamped" : UNSTAMPED` no matter how many times
 * the service was redeployed. Two redeploys were spent chasing that before
 * the cause was found, because no deploy can fix a constant baked into the
 * artifact it is deploying.
 *
 * Copying `.git` into the image would make `git` work and is the wrong fix:
 * it ships the whole history into a production image to recover one string
 * the release pipeline already holds. `.github/workflows/release.yml` runs
 * `git rev-parse HEAD` itself and passes the result as the `APP_REVISION`
 * build argument -- the same value `docker/metadata-action` writes into the
 * OCI `revision` label -- so the commit was already inside the build. It
 * simply had no way to reach this script, because `ARG APP_REVISION` was
 * declared only in the `runner` stage while this script runs in `build`.
 *
 * Named distinctly from `APP_REVISION` rather than reading that variable
 * directly, because the two are not the same claim. `APP_REVISION` is
 * runtime metadata describing the image; this is a *bundler input* compiled
 * into an artifact, and it can carry the `-dirty` suffix, which an OCI label
 * never does. The Dockerfile forwards one to the other explicitly, so the
 * coupling is a single visible line rather than two files agreeing about a
 * shared name by coincidence.
 */
export const BUILD_COMMIT_ENV = "STANDUP_HOOK_BUILD_COMMIT";

/**
 * The environment variable that turns an unstamped build into a failed build.
 *
 * -- Why this is opt-in rather than always on ---------------------------
 *
 * Both behaviours are correct, for different builds, and nothing this script
 * can observe distinguishes them on its own:
 *
 *   - Building from an unpacked tarball, or in a checkout that is not a git
 *     repository, genuinely cannot name a commit. Failing there would break
 *     packaging to gain nothing, and {@link UNSTAMPED} is the honest answer --
 *     `check-hook-freshness.mjs` already treats it as unverifiable rather
 *     than as current.
 *   - A **release** build that cannot name its commit is a broken release.
 *     It has a commit; the plumbing meant to deliver it did not. Stamping
 *     {@link UNSTAMPED} there ships an artifact that silently disables every
 *     freshness check downstream, which is exactly what happened: the build
 *     step succeeded, the image published, and the defect surfaced only in
 *     production -- twice, because the first two attempts to fix it were
 *     redeploys of the same permanently-unstamped bundle.
 *
 * So the *caller* declares which kind of build this is. The Dockerfile sets
 * it, because an image is always a release artifact; a bare
 * `node scripts/build-hook-scripts.mjs` does not, so local, CI and tarball
 * builds behave exactly as they did before.
 *
 * This is the shape `.github/workflows/release.yml` argues for throughout its
 * own comments, which repeatedly reject arrangements that "silently" produce
 * no release, no image or no tag. A release that silently produces an
 * unidentifiable artifact is that same failure one layer down.
 */
export const REQUIRE_STAMP_ENV = "STANDUP_HOOK_REQUIRE_BUILD_STAMP";

/**
 * The shape a stamp must have to be a commit: a sha, optionally marked dirty.
 *
 * Kept in step with the pattern `scripts/check-hook-freshness.mjs` parses
 * back. A value this rejects is treated as no value at all, so the two ends
 * cannot disagree about what counts as provenance.
 */
const COMMIT_SHAPE = /^[0-9a-f]{40}(-dirty)?$/;

/**
 * Whether an environment variable is set to something meaning "yes".
 *
 * Empty is false because that is Docker's shape for an `ARG` nobody passed:
 * an unsupplied `ARG` with no default becomes an *empty* variable in the
 * image, not an unset one, so a mere presence check would read every build as
 * a release build.
 */
function isEnabled(value) {
  if (typeof value !== "string") return false;
  const normalised = value.trim().toLowerCase();
  return normalised !== "" && normalised !== "0" && normalised !== "false";
}

/**
 * Thrown when a build was told it must stamp a commit and could not.
 *
 * Its own class so the CLI wrapper can print the actionable message by itself
 * rather than a stack trace whose useful line is buried. A build failure
 * nobody can read is only marginally better than the silent success it
 * replaced.
 */
export class UnstampedBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnstampedBuildError";
  }
}

/**
 * The commit to stamp into the artifact.
 *
 * -- Where the commit comes from, in order ------------------------------
 *
 * 1. {@link BUILD_COMMIT_ENV}, when the caller supplied a well-formed one. A
 *    build that was *told* its commit must not second-guess that with a `git`
 *    call: inside the Docker build there is no checkout to ask, and anywhere
 *    a stray parent checkout did exist, asking would silently prefer a commit
 *    the copied sources were not built from.
 * 2. `git rev-parse HEAD`, for an ordinary build inside a checkout.
 * 3. {@link UNSTAMPED} -- or a thrown {@link UnstampedBuildError} when
 *    {@link REQUIRE_STAMP_ENV} says this build had no business not knowing.
 *
 * -- Why a supplied value is validated rather than trusted ---------------
 *
 * An empty or malformed `APP_REVISION` is precisely what a misconfigured
 * pipeline produces, because Docker turns an `ARG` nobody passed into an
 * empty variable rather than an unset one. Accepting it would bake a stamp of
 * `""` into the bundle, and `isStamped("")` is false -- so the artifact would
 * report `unstamped` while the build looked like it had worked. That is the
 * original defect restored by way of its own fix. A supplied value that is
 * not a commit is therefore treated as no value at all and falls through to
 * the same outcome as the plumbing being absent, which under
 * {@link REQUIRE_STAMP_ENV} is a loud failure naming what it actually got.
 *
 * -- Why a dirty tree is not the checked-out commit ---------------------
 *
 * A build made from a modified working tree is not the commit `HEAD` names --
 * it is that commit plus edits nobody else can resolve. Stamping the bare
 * SHA would make such a build claim provenance it does not have, and a
 * checker comparing stamps would call it current when it is not reproducible
 * from anything. So a dirty build is suffixed `-dirty`: it still names the
 * commit it started from (the useful part when reading a stale artifact)
 * while never comparing equal to a clean build of that commit.
 */
/**
 * @param {Record<string, string | undefined>} [env] the environment to read,
 *   defaulting to this process's. Annotated as a plain string map rather than
 *   inferred from `process.env`: Next's ambient types narrow `ProcessEnv` to
 *   require `NODE_ENV`, which would force every caller — including a test
 *   supplying one variable to prove one branch — to pass an unrelated field.
 *   Taking the environment as an argument at all is the same reasoning
 *   `readBuildInfo` documents: a function that reads `process.env` directly
 *   can only be tested against whatever the process happened to start with.
 */
export function resolveBuildCommit(env = process.env) {
  const raw = env[BUILD_COMMIT_ENV];
  const supplied = typeof raw === "string" ? raw.trim() : "";
  if (COMMIT_SHAPE.test(supplied)) return supplied;

  const fromGit = resolveBuildCommitFromGit();
  if (fromGit !== UNSTAMPED) return fromGit;

  if (isEnabled(env[REQUIRE_STAMP_ENV])) {
    const why =
      supplied === ""
        ? `${BUILD_COMMIT_ENV} was not set`
        : `${BUILD_COMMIT_ENV} was set to ${JSON.stringify(supplied)}, which is not a commit sha`;
    throw new UnstampedBuildError(
      [
        "This build must stamp the commit it was built from, and could not.",
        "",
        `  ${REQUIRE_STAMP_ENV} is set, which declares this a release build.`,
        `  ${why}, and there is no git checkout to fall back to.`,
        "",
        "A release artifact that cannot name its own commit silently disables",
        "every freshness check downstream of it, so this fails the build rather",
        "than publishing one. In the Docker build this value comes from the",
        "APP_REVISION build argument, which .github/workflows/release.yml passes",
        "from its own `git rev-parse HEAD`; check that `ARG APP_REVISION` is",
        "declared in the stage that runs this script, not only in `runner`.",
      ].join("\n"),
    );
  }

  return UNSTAMPED;
}

/**
 * The commit according to `git`, or {@link UNSTAMPED} when it cannot say.
 *
 * -- Why a failure here is not, by itself, a build failure --------------
 *
 * Building outside a git checkout is legitimate, and refusing to build there
 * unconditionally would break packaging to gain nothing. Such a build stamps
 * {@link UNSTAMPED}, an honest "provenance unknown" that the checker treats
 * as unverifiable rather than as current. Whether that honest shrug is
 * *acceptable* is the caller's call, not this function's -- see
 * {@link REQUIRE_STAMP_ENV}. The one outcome ruled out either way is a build
 * that looks stamped while carrying a fabricated or guessed commit.
 */
function resolveBuildCommitFromGit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commit === "") return UNSTAMPED;

    const status = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return status === "" ? commit : `${commit}-dirty`;
  } catch {
    return UNSTAMPED;
  }
}

/** Builds every entry in `HOOK_SCRIPT_ENTRY_POINTS` as a standalone, servable file. */
export async function buildHookScripts() {
  await rm(HOOK_SCRIPTS_DIR, { recursive: true, force: true });

  // Substituted into `src/lib/hook/build-stamp.ts`'s `HOOK_BUILD_COMMIT` so
  // the artifact can state which source it was built from — the thing whose
  // absence let a hook eight days older than the feature it exercised run
  // every session in silence. `JSON.stringify` because `define` substitutes
  // *source text* for an identifier, so the value has to arrive as a quoted
  // literal and not as a bare identifier.
  const buildCommit = resolveBuildCommit();

  await Promise.all(
    Object.entries(HOOK_SCRIPT_ENTRY_POINTS).map(([variant, entryPoint]) =>
      build({
        entryPoints: [entryPoint],
        outfile: path.join(HOOK_SCRIPTS_DIR, `${variant}.js`),
        bundle: true,
        splitting: false,
        format: "esm",
        platform: "node",
        target: "node24",
        packages: "external",
        sourcemap: false,
        logLevel: "info",
        define: { __STANDUP_HOOK_BUILD_COMMIT__: JSON.stringify(buildCommit) },
      }),
    ),
  );

  return { buildCommit };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  buildHookScripts().catch((error) => {
    // An `UnstampedBuildError` is a configuration problem with a known
    // remedy, and its message says what to do. Printing the stack too would
    // bury that under frames from this file, which is how a loud failure
    // becomes one people learn to scroll past. Anything else is an
    // unexpected fault and gets the full object, where the stack is the
    // useful part.
    console.error(error instanceof UnstampedBuildError ? error.message : error);
    process.exit(1);
  });
}
