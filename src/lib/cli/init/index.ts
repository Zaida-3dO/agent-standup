// `standup init` — find, accept or provision a database; create it;
// migrate; seed; write local configuration; prove it with a live round trip
// (SCHEMA.md §20, MILESTONES.md #80).
//
// Named alongside `doctor`, `hook` and `mcp` in §20 as one of the commands
// that "name one thing each" rather than a `<noun> <verb>` pair, so it is
// dispatched the same way `doctor` already is — as a special case in
// `run.ts` that runs *before* `resolveConfig`'s "not configured, stop" gate,
// because establishing that configuration is this command's entire job.
//
// **Why this file may call into `scripts/lib/run-init.mjs`, which
// constructs a real `PrismaClient`, when nothing else under `src/` may.**
// CLAUDE.md's allowlist ("no adapter may reach the database directly")
// governs request-serving adapters — the ones a rule can be silently
// bypassed through. `init` is not one of those: it exists, like
// `prisma/seed.mjs` and `scripts/entrypoint.mjs`, for the case where *there
// is no service layer yet to call* — the schema may not even be migrated.
// SCHEMA.md §22 names `init` explicitly as one of the adapter-conformance
// harness's legitimate waivers ("`init` is local-only") for exactly this
// reason. The database-touching work itself is delegated to
// `scripts/lib/run-init.mjs` — outside `src/`, so outside the allowlist
// scan entirely, and built from the same subprocess/child-process primitives
// (`prisma migrate deploy`, `prisma db execute`) every other bootstrap
// script in this repo already uses. This file's own import statements never
// name `@/lib/prisma` or `@prisma/client`, directly or by any relative
// spelling of the former.
import { stringFlag, type ParsedArgs } from "../args";
import { EXIT, malformed, ok, type Envelope, type ExitCode } from "../envelope";
import type { CliEnvironment, CliFileConfig } from "../config";
import { writeConfigFile as writeConfigFileDefault, configFilePath } from "../config-file";
import { resolveInitSource, type InitFlags, type InitSource } from "./resolve";

/** What a successful `run-init.mjs` sequence reports. Mirrors `scripts/lib/run-init.mjs`'s return shape. */
export interface InitSequenceSuccess {
  readonly ok: true;
  readonly databaseUrl: string;
  readonly source: "accepted" | "provisioned" | "provisioned-via-container";
  readonly database: { readonly host: string; readonly port?: string; readonly name: string };
  readonly appRole?: string;
  readonly steps: {
    readonly migrated: boolean;
    readonly seeded: boolean;
    readonly verified: boolean;
  };
}

/** What a failed sequence reports — never the raw driver error (SCHEMA.md §20: a connection string is never printed). */
export interface InitSequenceFailure {
  readonly ok: false;
  readonly stage: "container" | "provision" | "migrate" | "seed" | "verify";
  readonly message: string;
}

export type InitSequenceResult = InitSequenceSuccess | InitSequenceFailure;

export type RunInitSequenceFn = (options: {
  readonly source: InitSource;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}) => Promise<InitSequenceResult>;

async function defaultRunInitSequence(
  options: Parameters<RunInitSequenceFn>[0],
): Promise<InitSequenceResult> {
  // A dynamic import, not a static one: a unit test that supplies its own
  // `deps.runInitSequence` (every test in `tests/cli-init-*.test.ts` except
  // the DB-gated ones) never loads this module at all, and therefore never
  // constructs a `PrismaClient` — the same reasoning `run.ts`'s
  // `buildBinding` states for `loadService`.
  const mod = (await import("../../../../scripts/lib/run-init.mjs")) as {
    runInitSequence: RunInitSequenceFn;
  };
  return mod.runInitSequence(options);
}

/** Reads the flags `standup init` understands. Refuses a bare flag that needs a value. */
function readInitFlags(
  flags: ParsedArgs["flags"],
): { ok: true; value: InitFlags } | { ok: false; envelope: Envelope } {
  const names = [
    "database-url",
    "provision-url",
    "database-name",
    "app-role",
    "app-password",
  ] as const;
  const values: Record<string, string> = {};
  for (const name of names) {
    const result = stringFlag(flags, name);
    if (!result.ok) return { ok: false, envelope: result.envelope };
    if (result.value !== undefined) values[name] = result.value;
  }
  return {
    ok: true,
    value: {
      ...(values["database-url"] === undefined ? {} : { databaseUrl: values["database-url"] }),
      ...(values["provision-url"] === undefined ? {} : { provisionUrl: values["provision-url"] }),
      ...(values["database-name"] === undefined ? {} : { databaseName: values["database-name"] }),
      ...(values["app-role"] === undefined ? {} : { appRole: values["app-role"] }),
      ...(values["app-password"] === undefined ? {} : { appPassword: values["app-password"] }),
    },
  };
}

export interface InitCommandOptions {
  readonly flags: ParsedArgs["flags"];
  readonly env?: CliEnvironment;
  readonly file?: CliFileConfig;
  readonly cwd?: string;
  /** Injection seams for tests — see `tests/cli-init-command.test.ts`. */
  readonly deps?: {
    readonly runInitSequence?: RunInitSequenceFn;
    readonly writeConfigFile?: typeof writeConfigFileDefault;
    readonly configPath?: string;
  };
}

export interface InitOutcome {
  readonly envelope: Envelope;
  readonly exitCode: ExitCode;
}

/** Runs `standup init`. See the module header for why this may reach the database. */
export async function runInitCommand({
  flags,
  env = {},
  file = {},
  cwd,
  deps = {},
}: InitCommandOptions): Promise<InitOutcome> {
  const parsedFlags = readInitFlags(flags);
  if (!parsedFlags.ok) {
    return { envelope: parsedFlags.envelope, exitCode: EXIT.MALFORMED };
  }

  const source = resolveInitSource({ flags: parsedFlags.value, env, file });
  const runInitSequence = deps.runInitSequence ?? defaultRunInitSequence;
  const write = deps.writeConfigFile ?? writeConfigFileDefault;
  const path = deps.configPath ?? configFilePath(env as NodeJS.ProcessEnv);

  const result = await runInitSequence({ source, cwd, env: env as NodeJS.ProcessEnv });

  if (!result.ok) {
    return {
      envelope: malformed(`standup init could not finish: ${result.message}`, [result.stage]),
      exitCode: EXIT.UNCONFIGURED,
    };
  }

  write({ databaseUrl: result.databaseUrl }, path);

  return {
    envelope: ok({
      source: result.source,
      database: result.database,
      ...(result.appRole === undefined ? {} : { appRole: result.appRole }),
      steps: result.steps,
      configWritten: true,
      configPath: path,
    }),
    exitCode: EXIT.OK,
  };
}
