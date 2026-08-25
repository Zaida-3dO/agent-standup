// What code is actually running — the one read that answers "what is
// deployed" without shell access to the host.
//
// ── Why this module exists ─────────────────────────────────────────────
//
// There were four ways to ask what version was running and three of them
// lied: `service_info` carried no version at all, `package.json` said
// `0.1.0` (a placeholder that had never been bumped), and the image tag was
// `:latest` (which carries no information by construction). Only the OCI
// label `org.opencontainers.image.revision` was honest, and reading it
// needed a shell on the deploy host plus the right `docker inspect
// --format` incantation.
//
// That is not a cosmetic gap. It was the root cause of two incidents: crews
// were dispatched with briefs quoting short ids that had merged to `main`
// but were not deployed, and neither the crews nor the orchestrator could
// tell — because images publish only from tagged releases, so merging to
// `main` publishes nothing and `main` is routinely ahead of what is
// serving. A revision an agent can read turns that into a one-call check.
//
// ── Why the environment, and not a checked-in constant ─────────────────
//
// A version that needs a human to remember to edit it is a version that
// drifts, and `0.1.0` surviving through twelve releases is the proof. So
// nothing here is a literal that anyone maintains: every value is read from
// the environment, and the release pipeline is what sets it, from the same
// tag and sha `docker/metadata-action` already writes into the OCI labels.
// See `.github/workflows/release.yml` (the `build-args` block) and the
// `ARG`/`ENV` pairs in the runner stage of the `Dockerfile`.
//
// The consequence to be honest about: a build that nobody released has
// nothing true to report, and it says so rather than guessing. The
// development fallbacks below are deliberately not plausible version
// numbers — `0.0.0-dev` and `unknown` cannot be mistaken for a real
// release, whereas a fallback of `0.1.0` is exactly how this problem
// started.

/**
 * The development fallback for a version nobody released.
 *
 * Visible rather than empty: a panel or an API answer rendering a blank
 * version reads as broken, where `0.0.0-dev` reads as "this is not a
 * released build", which is the true statement.
 */
export const DEV_VERSION = "0.0.0-dev";

/**
 * The fallback for a revision that was not baked in.
 *
 * `unknown` rather than an empty string or a fake sha: a caller comparing
 * this against a git sha must be able to tell "not recorded" apart from
 * "recorded as something", and any placeholder shaped like a sha would be
 * indistinguishable from a real answer at a glance.
 */
export const UNKNOWN_REVISION = "unknown";

/** What code is running, as a caller reads it. */
export interface BuildInfo {
  /**
   * The released version — the `v`-tag with its leading `v` stripped, so
   * `v0.12.0` reports as `0.12.0`. `0.0.0-dev` when this build came from
   * something other than a release.
   */
  readonly version: string;
  /**
   * The full git sha this image was built from. **This is the value that
   * actually identifies the code** — a version tag says which release, but
   * the sha says which commit, and it is the one an agent can compare
   * against `git log` to answer "is my merge deployed".
   *
   * `unknown` when it was not baked in.
   */
  readonly revision: string;
  /**
   * When the image was built, ISO-8601. `null` when not baked in.
   *
   * Nullable rather than a sentinel string because unlike the two above it
   * has no useful "not recorded" rendering — a caller either has a
   * timestamp to reason about or does not.
   */
  readonly buildTime: string | null;
  /**
   * Whether this build carries a real released identity.
   *
   * Derived, not set: true only when BOTH a version and a revision were
   * baked in. A caller asking "can I trust what the other two fields say"
   * gets one boolean instead of having to know which sentinel values mean
   * absence — which is the knowledge that failed to travel last time.
   */
  readonly released: boolean;
}

/**
 * Reads what code is running from an environment.
 *
 * Takes the environment as an argument rather than reaching for
 * `process.env` directly, so a test can prove each branch against a value
 * it supplied — a function that reads a module-level constant can only ever
 * be tested against whatever the process happened to be started with, which
 * is precisely the kind of test that passes while the plumbing is broken.
 *
 * Blank and whitespace-only values are treated as absent. Docker's
 * `ARG`/`ENV` pairing makes that the normal shape of "not passed": an `ARG`
 * with no default that nobody supplies becomes an *empty* environment
 * variable in the image, not an unset one, so a `??` check alone would
 * report an empty version as a real one.
 */
export function readBuildInfo(env: Record<string, string | undefined>): BuildInfo {
  const version = trimmedOrNull(env.APP_VERSION);
  const revision = trimmedOrNull(env.APP_REVISION);
  const buildTime = trimmedOrNull(env.APP_BUILD_TIME);

  return {
    version: version ?? DEV_VERSION,
    revision: revision ?? UNKNOWN_REVISION,
    buildTime,
    released: version !== null && revision !== null,
  };
}

/** The value if it holds something, otherwise null — see `readBuildInfo`. */
function trimmedOrNull(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * What this process is running, read from its own environment.
 *
 * A function rather than a module-level constant so that the answer
 * reflects the environment at call time. That matters for the same reason
 * `renderBuildConstants()` is a function: a constant frozen at module load
 * makes the value depend on which test file imported it first.
 */
export function currentBuildInfo(): BuildInfo {
  return readBuildInfo(process.env);
}
