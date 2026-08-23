#!/usr/bin/env node
// `npm run db:up`, as a script rather than a bare `docker compose up -d db`.
//
// **What was wrong with the bare command**, and it is the failure class this
// repository has now seen four times: a step that cannot tell "it worked"
// apart from "it never happened". Two distinct ways it reported success
// without providing it:
//
//   1. **The daemon is not reachable.** Depending on the shell and on how
//      Docker is installed, a missing `docker` or a stopped daemon can leave
//      the developer with a command that looks like it ran. They then set
//      `TEST_DATABASE_URL` and every gated suite fails or skips for reasons
//      that read as defects in the code.
//   2. **`up -d` returns when the container is CREATED, not when Postgres is
//      READY.** This one bites even when everything is installed and
//      working: `docker compose up -d` is asynchronous by design, so a
//      completely successful run can be followed immediately by a test suite
//      that cannot connect. The command was never making the promise the
//      developer read it as making.
//
// So this script does the thing the name implies: it does not exit 0 until a
// database actually answers a query. That is the same posture
// `scripts/check-db-import-allowlist.mjs` takes when it finds nothing to
// inspect — a step that has not verified anything must not report success —
// applied to setup rather than to a check.
//
// Every failure path names the next action. A setup script that fails
// without saying what to do sends the reader to the compose file to work out
// what the script already knows.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

/** Where `docker-compose.yml` publishes the `db` service. */
export const DB_URL = "postgres://standup:standup@localhost:5433/standup";

/** How long to wait for Postgres to accept a query after the container starts. */
export const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * How a command was run and what came back — the three fields this module
 * actually reads, rather than the full `SpawnSyncReturns`.
 *
 * Narrow on purpose: it is what lets a test supply a two-field fake without
 * inventing a `pid`, an `output` array and a `signal` that no assertion here
 * looks at. A wider type would make the fakes noisier without making them
 * more faithful.
 *
 * @typedef {{ status?: number | null, error?: { code?: string }, stderr?: string }} RunResult
 * @typedef {(cmd: string, args: string[]) => RunResult} RunCommand
 */

/**
 * A failure with a message already written for a human, so `main` can print
 * it and exit rather than dumping a stack over advice the reader needs.
 */
export class DbUpError extends Error {
  constructor(message) {
    super(message);
    this.name = "DbUpError";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is a Docker daemon actually reachable?
 *
 * `docker compose version` would only prove the CLI is installed — it talks
 * to no daemon and succeeds with Docker Desktop shut down, which is the most
 * common shape of this problem. `docker info` is the cheapest call that
 * requires the daemon to answer.
 *
 * @param {RunCommand} [run]
 */
export function daemonState(run = defaultRun) {
  const result = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  // Two different problems with two different fixes, so they are two states.
  //
  // No binary at all surfaces as ENOENT from `spawn`. On Windows it can also
  // surface as a shell-level "'docker' is not recognized" on stderr, which is
  // why the text is matched too rather than trusting ENOENT alone — telling
  // someone with no Docker installed to "start Docker Desktop" is advice they
  // cannot act on.
  const code = String(result.error?.code ?? "");
  const stderr = String(result.stderr ?? "");
  if (code === "ENOENT" || /not recognized as|command not found/i.test(stderr)) {
    return "absent";
  }
  return result.status === 0 ? "ready" : "unreachable";
}

// No `shell: true`. It buys nothing here — `docker` is a real executable, not
// a shell builtin — and it costs the ENOENT that distinguishes "not
// installed" from "not running", because a shell turns a missing command into
// its own exit status. Node also warns that passing args through a shell is a
// security hazard, since they are concatenated rather than escaped.
function defaultRun(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

/** The advice for each way the daemon can be unavailable. */
export const DAEMON_ADVICE = {
  absent:
    "Docker is not installed, or its CLI is not on PATH.\n" +
    "  Install Docker Desktop (or the Docker engine), then run `npm run db:up` again.\n" +
    "  Already have a Postgres of your own? Skip this script entirely and point the\n" +
    `  suites at it directly:  export TEST_DATABASE_URL=${DB_URL}`,
  unreachable:
    "Docker is installed but its daemon is not answering.\n" +
    "  Start Docker Desktop (or `sudo systemctl start docker`), wait for it to report\n" +
    "  running, then run `npm run db:up` again.\n" +
    "  Already have a Postgres of your own? Skip this script entirely and point the\n" +
    `  suites at it directly:  export TEST_DATABASE_URL=${DB_URL}`,
};

/**
 * Does a database answer a query on `url`?
 *
 * A TCP handshake is not enough — a Postgres mid-startup accepts the socket
 * and still refuses queries, which is exactly the window `up -d` returns in.
 */
export async function canQuery(url, PrismaCtor = PrismaClient) {
  const client = new PrismaCtor({ datasources: { db: { url } } });
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

/**
 * Poll until the database answers or the timeout elapses.
 *
 * @returns {Promise<boolean>} whether it ever answered.
 */
export async function waitForReady({
  url = DB_URL,
  timeoutMs = READY_TIMEOUT_MS,
  intervalMs = POLL_INTERVAL_MS,
  probe = canQuery,
  now = () => Date.now(),
  onWait = () => {},
} = {}) {
  const deadline = now() + timeoutMs;
  let announced = false;
  for (;;) {
    if (await probe(url)) return true;
    if (now() >= deadline) return false;
    if (!announced) {
      onWait();
      announced = true;
    }
    await sleep(intervalMs);
  }
}

/**
 * @param {{ run?: RunCommand, wait?: typeof waitForReady, log?: (m: string) => void }} [deps]
 */
export async function dbUp({ run = defaultRun, wait = waitForReady, log = console.log } = {}) {
  const state = daemonState(run);
  if (state !== "ready") {
    throw new DbUpError(`Cannot start the database.\n\n  ${DAEMON_ADVICE[state]}`);
  }

  const started = run("docker", ["compose", "up", "-d", "db"]);
  if (started.status !== 0) {
    throw new DbUpError(
      "`docker compose up -d db` failed.\n\n" +
        "  The daemon is running, so this is about the compose file or the container\n" +
        "  itself — check the output above, then `docker compose logs db`.",
    );
  }

  const ready = await wait({
    onWait: () => log("Container started; waiting for Postgres to accept queries..."),
  });
  if (!ready) {
    throw new DbUpError(
      `The container started but no database answered on ${DB_URL} within ` +
        `${READY_TIMEOUT_MS / 1000}s.\n\n` +
        "  This is not a timeout to retry blindly — the container is up, so something\n" +
        "  inside it is wrong. Look at `docker compose logs db`.\n" +
        "  A port already taken by another Postgres is the usual cause.",
    );
  }

  log(`Database ready.  export TEST_DATABASE_URL=${DB_URL}`);
}

// Only when run directly, so the tests can import the pieces above.
// `pathToFileURL` rather than building the URL by hand: on Windows a path is
// `C:\...` and the correct file URL is `file:///C:/...` with three slashes,
// which a naive `"file://" + argv[1]` concatenation gets wrong. The failure
// mode when it is wrong is this block silently never running — the script
// exits 0 having done nothing, which is precisely the defect it exists to
// fix, so it is worth not hand-rolling.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  dbUp().catch((error) => {
    console.error(`\n${error instanceof DbUpError ? error.message : error}\n`);
    process.exit(1);
  });
}
