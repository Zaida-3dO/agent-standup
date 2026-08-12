// Entry logic for `task-shim` (MILESTONES.md #39). `src/bin/task-shim.ts` is
// the only caller in production; everything here takes its I/O as arguments
// so a test never has to spawn a process or set `process.env` to exercise it
// — the same shape `src/lib/cli/main.ts` uses for the standup command line.
import { parseShimArgs } from "./args";
import { runCreate, runList, runShow, runStatus, runUpdate, type CommandStreams } from "./commands";
import type { FetchLike } from "./client";

const COMMAND_LIST = "list, show, create, update, status";

/**
 * Printed once, to standard error, on every invocation, before anything
 * else runs — success or failure. **This is the "kept for one release" part
 * made visible rather than assumed**: DECISIONS.md §11 says this surface is
 * deleted once the switch (#40) happens, and a warning nobody sees is a
 * warning that does not stop it quietly outliving that release. Standard
 * error, not standard output, so a script parsing this surface's JSON
 * output is never broken by the warning that tells it to stop existing.
 */
export const DEPRECATION_WARNING =
  '[deprecated] "task" is a compatibility shim over the items API (MILESTONES.md #39), kept for ' +
  "one release and removed when #40 goes live. Move callers to the standup command line.";

export interface RunOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly streams: CommandStreams;
}

export async function run(argv: readonly string[], options: RunOptions): Promise<number> {
  options.streams.err(`${DEPRECATION_WARNING}\n`);

  const { command, rest, flags } = parseShimArgs(argv);
  if (command === undefined) {
    options.streams.err(`Error: no command given. Commands: ${COMMAND_LIST}.\n`);
    return 1;
  }

  const baseUrl = options.env.STANDUP_URL;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    options.streams.err("Error: STANDUP_URL is not set.\n");
    return 1;
  }
  const client = { baseUrl, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) };

  switch (command) {
    case "list":
      return runList(flags, client, options.streams);
    case "show":
      return runShow(rest, client, options.streams);
    case "create":
      return runCreate(flags, client, options.streams);
    case "update":
      return runUpdate(rest, flags, client, options.streams);
    case "status":
      return runStatus(rest, client, options.streams);
    default:
      options.streams.err(`Error: unknown command "${command}". Commands: ${COMMAND_LIST}.\n`);
      return 1;
  }
}
