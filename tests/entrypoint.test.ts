// Black-box, end-to-end proof of the migrate-on-boot wiring itself: spawns
// scripts/entrypoint.mjs as a real OS process (not an imported function),
// pointed at a real unreachable address or a real corrupted Postgres, and
// asserts on its real exit code and real stdout/stderr — the actual
// behaviour an operator watching container logs would see. The server
// command is swapped for a small stub (via the `--` override entrypoint.mjs
// supports) so this doesn't need a full `next build`; the boot sequence
// under test — wait, migrate, only then hand off — is exercised for real
// either way.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokenMigrationSchema } from "./helpers/broken-migration";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const repoRoot = path.resolve(import.meta.dirname, "..");
const entrypoint = path.resolve(repoRoot, "scripts/entrypoint.mjs");
const STUB_SERVER_ARGS = [
  "--",
  "node",
  "-e",
  "console.log('APP_STARTED'); setInterval(() => {}, 1000);",
];

let activeChild: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  activeChild?.kill();
  activeChild = undefined;
});

function runEntrypoint(env: Record<string, string | undefined>, args: string[] = []) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  activeChild = child;

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));

  return { child, getOutput: () => output };
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for the process to exit")),
      timeoutMs,
    );
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitForOutput(getOutput: () => string, pattern: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (getOutput().includes(pattern)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `timed out waiting for output to include ${JSON.stringify(pattern)}. Got:\n${getOutput()}`,
          ),
        );
      }
    }, 100);
  });
}

describe("scripts/entrypoint.mjs — database unreachable (no Postgres needed)", () => {
  it("refuses to serve, exits nonzero, and logs FATAL", async () => {
    const { child, getOutput } = runEntrypoint(
      {
        DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/nowhere",
        DB_WAIT_TIMEOUT_SECONDS: "1",
        DB_WAIT_INTERVAL_SECONDS: "0.3",
      },
      STUB_SERVER_ARGS,
    );

    const code = await waitForExit(child, 10_000);

    expect(code).not.toBe(0);
    expect(getOutput()).toMatch(/FATAL/);
    expect(getOutput()).not.toContain("APP_STARTED");
  });
});

describe("scripts/entrypoint.mjs — invalid DB_WAIT_*_SECONDS (no Postgres needed)", () => {
  // Review round 1 found this hangs the real process forever (SIGKILL
  // required, no FATAL) rather than refusing to boot. These prove the fix
  // against the real entrypoint, not just the parser in isolation (see
  // tests/boot-env.test.ts) — a short waitForExit budget is itself part of
  // the assertion: it proves the process actually exits promptly rather than
  // running until some other timeout coincidentally fires.
  it.each([
    ["a duration typo with a unit suffix", "60s"],
    ["another duration typo with a unit suffix", "2m"],
    ["empty string — what an unset `${VAR:-}` in Compose yields", ""],
  ])(
    "refuses to serve and exits promptly when DB_WAIT_TIMEOUT_SECONDS is %s (%j)",
    async (_label, badValue) => {
      const { child, getOutput } = runEntrypoint(
        {
          DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/nowhere",
          DB_WAIT_TIMEOUT_SECONDS: badValue,
        },
        STUB_SERVER_ARGS,
      );

      // Previously this specific input (a duration typo) never exited at all;
      // the real bug was verified by SIGKILLing at 20s. A generous-but-bounded
      // budget here is the regression check: a config-validation failure must
      // return well before any DB-wait timeout could plausibly explain it.
      const code = await waitForExit(child, 8_000);

      expect(code).not.toBe(0);
      expect(getOutput()).toMatch(/FATAL/);
      expect(getOutput()).toContain("DB_WAIT_TIMEOUT_SECONDS");
      expect(getOutput()).not.toContain("APP_STARTED");
    },
  );

  it("refuses to serve and exits promptly when DB_WAIT_INTERVAL_SECONDS is invalid", async () => {
    const { child, getOutput } = runEntrypoint(
      {
        DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/nowhere",
        DB_WAIT_INTERVAL_SECONDS: "not-a-number",
      },
      STUB_SERVER_ARGS,
    );

    const code = await waitForExit(child, 8_000);

    expect(code).not.toBe(0);
    expect(getOutput()).toMatch(/FATAL/);
    expect(getOutput()).toContain("DB_WAIT_INTERVAL_SECONDS");
    expect(getOutput()).not.toContain("APP_STARTED");
  });
});

describe.skipIf(!testDatabaseUrl)("scripts/entrypoint.mjs — against a real Postgres", () => {
  it("refuses to serve, exits nonzero, and logs FATAL when migrations fail", async () => {
    const dbName = scratchDatabaseName("entrypoint_fail");
    const scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const { schemaPath, cleanup } = createBrokenMigrationSchema();
    try {
      const { child, getOutput } = runEntrypoint(
        {
          DATABASE_URL: scratchUrl,
          DB_WAIT_TIMEOUT_SECONDS: "5",
          PRISMA_SCHEMA_PATH: schemaPath,
          // Explicit rather than relying on the ambient NODE_ENV a test
          // runner happens to have: PRISMA_SCHEMA_PATH is a test-only seam,
          // gated off whenever NODE_ENV=production (see the dedicated test
          // below), so this test says outright that it's exercising the
          // non-production path.
          NODE_ENV: "test",
        },
        STUB_SERVER_ARGS,
      );

      const code = await waitForExit(child, 20_000);

      expect(code).not.toBe(0);
      expect(getOutput()).toMatch(/FATAL/);
      expect(getOutput()).not.toContain("APP_STARTED");
    } finally {
      cleanup();
      dropScratchDatabase(testDatabaseUrl!, dbName);
    }
  }, 25_000);

  it("ignores PRISMA_SCHEMA_PATH when NODE_ENV=production, applying the real schema instead", async () => {
    // The production image sets NODE_ENV=production (see Dockerfile). This
    // proves the gate actually holds against the real entrypoint: even
    // pointed at a schema whose only migration deliberately fails, a
    // production-mode boot applies this repo's real (passing) migrations
    // and starts — nothing can redirect what gets applied to a real
    // deployment's database via this env var.
    const dbName = scratchDatabaseName("entrypoint_prod_schema_gate");
    const scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const { schemaPath, cleanup } = createBrokenMigrationSchema();
    try {
      const { child, getOutput } = runEntrypoint(
        {
          DATABASE_URL: scratchUrl,
          DB_WAIT_TIMEOUT_SECONDS: "10",
          PRISMA_SCHEMA_PATH: schemaPath,
          NODE_ENV: "production",
        },
        STUB_SERVER_ARGS,
      );

      await waitForOutput(getOutput, "APP_STARTED", 20_000);

      expect(getOutput()).toContain("PRISMA_SCHEMA_PATH is set but ignored");
      expect(getOutput()).toContain("Migrations applied successfully");
      expect(getOutput()).not.toMatch(/FATAL/);

      child.kill();
      await waitForExit(child, 5000);
    } finally {
      cleanup();
      dropScratchDatabase(testDatabaseUrl!, dbName);
    }
  }, 25_000);

  it("applies migrations and hands off to the real server command on success", async () => {
    const dbName = scratchDatabaseName("entrypoint_ok");
    const scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    try {
      const { child, getOutput } = runEntrypoint(
        { DATABASE_URL: scratchUrl, DB_WAIT_TIMEOUT_SECONDS: "10" },
        STUB_SERVER_ARGS,
      );

      await waitForOutput(getOutput, "APP_STARTED", 20_000);

      expect(getOutput()).not.toMatch(/FATAL/);
      expect(getOutput()).toContain("Migrations applied successfully");

      child.kill();
      await waitForExit(child, 5000);
    } finally {
      dropScratchDatabase(testDatabaseUrl!, dbName);
    }
  }, 25_000);
});
