// Next.js runs `register()` exactly once, in the Node.js runtime, before
// the server starts handling requests — the same "before the process can
// reach the database" moment §17 of SCHEMA.md draws the bootstrap/settings
// line at. This is where the retired-environment-variable check (#90) runs,
// and where the backfill window announces itself (#97).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    // Also invoked once for the edge runtime; the check reads a registry
    // that imports zod and Node process.env, neither of which the edge
    // runtime needs this for, so it runs exactly once, on the Node side.
    return;
  }

  const { checkFormerEnv } = await import("./lib/settings/former-env-check");
  checkFormerEnv();

  await announceBackfillWindow();
  await announceHistoricalVerificationWindow();
}

/**
 * Writes the historical-verification window's startup warning, if the window
 * is open.
 *
 * Announced for the same reason the backfill window is, and the reasoning
 * transfers exactly: the realistic failure is not an attacker but an
 * operator opening the window for one backlog cleanup, being interrupted,
 * and leaving it open. While it is open, an item can enter `merged` on a
 * recorded inspection instead of an approving review, which is a fact about
 * what the board's merge gate means while it is open — and therefore one nobody
 * should have to raise the log level to discover.
 *
 * Separate from `announceBackfillWindow` rather than folded into it: the two
 * windows are independent, either can be open without the other, and a
 * single combined line would have to describe whichever combination it
 * found.
 *
 * Exported so a test can call it with an environment of its own, rather than
 * having to invoke `register()` and satisfy everything else in it.
 */
export async function announceHistoricalVerificationWindow(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const { historicalVerificationStartupWarning } =
    await import("./lib/service/guards/historical-verification-enabled");
  const { log } = await import("./lib/log");
  const warning = historicalVerificationStartupWarning(env);
  if (warning !== null) log.warn(warning);
}

/**
 * Writes the backfill window's startup warning, if the window is open.
 *
 * `backfillStartupWarning` has returned a formatted line since it was
 * written and nothing has ever called it — it was built to return rather
 * than print "so the caller decides where it goes", and then no caller
 * decided. This is that caller.
 *
 * **It is not a duplicate of the container entrypoint's warning**, which is
 * a separate statement of the same rule in plain JavaScript
 * (`scripts/entrypoint.mjs`, kept honest by
 * `tests/backfill-enabled.test.ts` running both against one table of
 * inputs). That one announces the *container* starting and cannot import
 * this module; this one announces the *application process* starting, and
 * it is the only one that fires at all when the process was not started by
 * that script — `next dev`, a test harness, a locally-run `next start`.
 * The failure both exist for is the same and is not an attacker: it is
 * opening the window, being interrupted, and leaving it open for weeks.
 *
 * At `warn`, which is on at the default threshold. A message about a
 * write surface that bypasses the state machine being reachable is one
 * nobody should have to raise the log level to see.
 *
 * Exported so a test can call it with an environment of its own, rather
 * than having to invoke `register()` and satisfy everything else in it.
 */
export async function announceBackfillWindow(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const { backfillStartupWarning } = await import("./lib/backfill/enabled");
  const { log } = await import("./lib/log");
  const warning = backfillStartupWarning(env);
  if (warning !== null) log.warn(warning);
}
