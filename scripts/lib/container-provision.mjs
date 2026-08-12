#!/usr/bin/env node
// The last-resort path in `standup init`'s "find, accept or provision a
// database" (docs/plans/MILESTONES.md #80): when the caller supplied neither
// an existing connection string nor an explicit provisioning connection,
// try to provision one through a container runtime — `docker-compose.yml`'s
// own `db` service, the same one `npm run db:up` starts for local
// development (DECISIONS.md §13f: "an existing connection string, a
// detected local Postgres, or one provisioned through a container
// runtime").
//
// **This is best-effort, and says so honestly rather than pretending to be
// more.** If `docker` isn't on PATH, or compose fails, this returns `{ ok:
// false }` rather than throwing — the whole point of it existing is that
// `standup init` does not abandon the operator when it can't provision
// automatically; see `resolveInitSource` in `src/lib/cli/init/resolve.ts`
// for what happens next (a clear, actionable message pointing at
// `--database-url` / `--provision-url`).
import { spawn, spawnSync } from "node:child_process";
import { DEFAULT_DB_WAIT_INTERVAL_SECONDS, DEFAULT_DB_WAIT_TIMEOUT_SECONDS } from "./boot-env.mjs";
import { DatabaseUnreachableError, waitForDatabase } from "./wait-for-db.mjs";

const isWindows = process.platform === "win32";

/**
 * The dev compose file's own credentials (`docker-compose.yml`). Hardcoded
 * rather than parsed out of the YAML — this repo has no YAML dependency, and
 * these three values are also documented in `.env.example` and `README.md`.
 * If `docker-compose.yml`'s dev credentials ever change, this constant has
 * to move with them; there is no other mechanism keeping them in sync.
 */
export const DEV_COMPOSE_PROVISION_URL = "postgres://standup:standup@localhost:5433/postgres";

/**
 * @typedef {{ info: (message: string) => void, warn: (message: string) => void, error: (message: string, err?: unknown) => void }} Logger
 */

/** Whether a container runtime capable of `docker compose` is on PATH at all. */
export function dockerAvailable() {
  const result = spawnSync(isWindows ? "docker.exe" : "docker", ["compose", "version"], {
    encoding: "utf-8",
    shell: isWindows,
  });
  return result.status === 0;
}

/**
 * Starts (or confirms already-running) `docker-compose.yml`'s `db` service
 * and waits for it to accept a real query — the same two-step boot sequence
 * `scripts/entrypoint.mjs` uses for the app container itself. Idempotent:
 * `docker compose up -d` on an already-running service is a no-op, which is
 * what lets this double as both "find" (already up from a previous session)
 * and "provision" (not yet up) without telling the two apart.
 *
 * @param {{ cwd?: string, log?: Logger, timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<{ ok: true, provisionUrl: string } | { ok: false, reason: string }>}
 */
export async function attemptContainerProvision({
  cwd = process.cwd(),
  log = console,
  timeoutMs = DEFAULT_DB_WAIT_TIMEOUT_SECONDS * 1000,
  intervalMs = DEFAULT_DB_WAIT_INTERVAL_SECONDS * 1000,
} = {}) {
  if (!dockerAvailable()) {
    return { ok: false, reason: "No container runtime (`docker compose`) is available." };
  }

  const upExitCode = await new Promise((resolve) => {
    const child = spawn(isWindows ? "docker.exe" : "docker", ["compose", "up", "-d", "db"], {
      cwd,
      stdio: "inherit",
      shell: isWindows,
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (upExitCode !== 0) {
    return { ok: false, reason: "`docker compose up -d db` did not succeed." };
  }

  try {
    await waitForDatabase({
      databaseUrl: DEV_COMPOSE_PROVISION_URL,
      timeoutMs,
      intervalMs,
      log,
    });
  } catch (err) {
    if (err instanceof DatabaseUnreachableError) {
      return { ok: false, reason: "The container started but Postgres never became reachable." };
    }
    throw err;
  }

  return { ok: true, provisionUrl: DEV_COMPOSE_PROVISION_URL };
}
