// Pure decision logic for `standup init` (SCHEMA.md §20, MILESTONES.md #80):
// which of "find, accept or provision a database" applies, given only what
// was supplied — no I/O, no database, no container runtime. Everything that
// actually touches a database lives in `scripts/lib/run-init.mjs`, which
// takes this module's output and executes it; keeping the two apart is what
// lets this file's every branch be asserted with a plain object in, a plain
// object out, no fakes for a filesystem or a subprocess required.
import { firstDefined, type CliEnvironment, type CliFileConfig } from "../config";

export const DEFAULT_DATABASE_NAME = "standup";
export const DEFAULT_APP_ROLE = "standup_app";

/** The `standup init`-specific flags, read out of the raw parsed flag map by `src/lib/cli/init/index.ts`. */
export interface InitFlags {
  readonly databaseUrl?: string;
  readonly provisionUrl?: string;
  readonly databaseName?: string;
  readonly appRole?: string;
  readonly appPassword?: string;
}

/**
 * What `standup init` decided to do, matching `scripts/lib/run-init.mjs`'s
 * `source` parameter exactly.
 *
 * - `accept` — a connection string was supplied directly (a flag,
 *   `DATABASE_URL`, or a previous `init`'s local configuration). Used
 *   as-is; there is no provisioning connection to keep separate from an
 *   application role, because the caller did not ask for one to be created.
 * - `provision` — an explicit provisioning connection was supplied
 *   (`--provision-url`). A fresh application role is created from it.
 * - `auto` — neither was supplied. `run-init.mjs` tries the dev container
 *   runtime before giving up; giving up is reported as *not configured*,
 *   never as a crash — MILESTONES.md #80's "falls back to a supplied
 *   connection string rather than abandoning" is what the resulting message
 *   points the caller back at.
 */
export type InitSource =
  | { readonly kind: "accept"; readonly databaseUrl: string }
  | {
      readonly kind: "provision";
      readonly provisionUrl: string;
      readonly databaseName: string;
      readonly appRole: string;
      readonly appPassword?: string;
    }
  | {
      readonly kind: "auto";
      readonly databaseName: string;
      readonly appRole: string;
      readonly appPassword?: string;
    };

export interface ResolveInitInputs {
  readonly flags?: InitFlags;
  readonly env?: CliEnvironment;
  readonly file?: CliFileConfig;
}

/**
 * Resolves which source `standup init` should use.
 *
 * Precedence for "accept" mirrors §20's rule for everything else — flag,
 * then environment, then the configuration file — and is checked **first**,
 * ahead of provisioning entirely: an operator who already has a working
 * connection string never needs this command to touch a container runtime
 * or create a role to use it. Only once nothing is available to accept does
 * provisioning become relevant at all.
 */
export function resolveInitSource({
  flags = {},
  env = {},
  file = {},
}: ResolveInitInputs = {}): InitSource {
  const databaseUrl = firstDefined(flags.databaseUrl, env.DATABASE_URL, file.databaseUrl);
  if (databaseUrl !== undefined) {
    return { kind: "accept", databaseUrl };
  }

  const databaseName =
    firstDefined(flags.databaseName, env.STANDUP_DB_NAME) ?? DEFAULT_DATABASE_NAME;
  const appRole = firstDefined(flags.appRole, env.STANDUP_APP_ROLE) ?? DEFAULT_APP_ROLE;
  const appPassword = firstDefined(flags.appPassword, env.STANDUP_APP_PASSWORD);
  const provisionUrl = firstDefined(flags.provisionUrl, env.STANDUP_PROVISION_URL);

  if (provisionUrl !== undefined) {
    return {
      kind: "provision",
      provisionUrl,
      databaseName,
      appRole,
      ...(appPassword === undefined ? {} : { appPassword }),
    };
  }

  return {
    kind: "auto",
    databaseName,
    appRole,
    ...(appPassword === undefined ? {} : { appPassword }),
  };
}
