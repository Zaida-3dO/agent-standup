#!/usr/bin/env node
// Runs the real `prisma migrate deploy` CLI as a child process and reports
// pass/fail. A real subprocess, not Prisma's internal (unsupported, no
// stable API) migrate engine — `migrate deploy` is the CLI's own supported
// entry point for "apply committed migrations, don't prompt, don't drift."
import { spawn } from "node:child_process";

// Windows resolves `npx` to `npx.cmd`, a batch file — spawning those needs
// shell:true or Node throws EINVAL. Only opt into the shell on Windows so
// Linux (CI, and the container this actually ships in) doesn't pay for it.
// Same pattern as scripts/check-migration-drift.mjs.
const isWindows = process.platform === "win32";

/**
 * @typedef {{ info: (message: string) => void, warn: (message: string) => void, error: (message: string, err?: unknown) => void }} Logger
 */

/**
 * Applies committed migrations against `env.DATABASE_URL`. Returns
 * `{ ok: true, exitCode: 0 }` on success, or `{ ok: false, exitCode }` on
 * failure — logging a loud, unambiguous FATAL line either way a caller
 * should treat as "do not start the app."
 *
 * `schemaPath` overrides which `schema.prisma` (and therefore which sibling
 * `migrations/` directory) the CLI reads — never set in production, where
 * the committed `prisma/schema.prisma` is always used. It exists so tests
 * can point `migrate deploy` at a throwaway migration that's deliberately
 * broken, to prove a *real* migration failure is handled correctly, without
 * touching this repo's own schema or migration history.
 *
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, log?: Logger, schemaPath?: string }} [options]
 */
export async function runMigrations({
  cwd = process.cwd(),
  env = process.env,
  log = console,
  schemaPath,
} = {}) {
  log.info('Applying database migrations ("prisma migrate deploy")...');

  const args = ["prisma", "migrate", "deploy"];
  if (schemaPath) {
    args.push("--schema", schemaPath);
  }

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(isWindows ? "npx.cmd" : "npx", args, {
      cwd,
      env,
      stdio: "inherit",
      shell: isWindows,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    log.error(
      `FATAL: database migration failed ("prisma migrate deploy" exited ${exitCode}) — ` +
        "refusing to start the application. See the Prisma output above for details.",
    );
    return { ok: false, exitCode };
  }

  log.info("Migrations applied successfully.");
  return { ok: true, exitCode: 0 };
}
