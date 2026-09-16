// The four commands that are *not* `<noun> <verb>` pairs — `init`, `doctor`,
// `mcp` and `hook` (SCHEMA.md §20: the commands that "name one thing each").
//
// **Why this table exists at all.** Each of these is dispatched as a special
// case in `run.ts`, ahead of the noun/verb table, because each needs to run
// before something the ordinary path insists on: `init` and `doctor` before
// `resolveConfig`'s "not configured, stop" gate, `mcp` because it is a
// long-lived connection rather than one operation call, `hook` because
// `hook run` answers in an agent tool's own JSON shape rather than an
// envelope. That is all sound — but it left them in **no table**, and
// `helpText()` builds itself from `COMMANDS`. So they could not appear in
// `standup --help` however carefully anyone read it: there was no list for
// them to be missing from.
//
// They are also the three or four a new user needs *first* — respectively
// how you set up, how you diagnose, how you connect an agent, and how you
// wire the guard. Help that lists 46 operations and none of these describes
// the product to someone who already knows it.
//
// Keeping them as data here, rather than as prose inside `helpText()`,
// preserves the property `tests/cli-dispatch.test.ts` pins for the noun/verb
// half: help is *rendered from the table the dispatcher uses*, so a command
// added without a help entry is a missing table row rather than a silently
// undocumented command.

/** One non-noun/verb command: what it is called, and what it does. */
export interface TopLevelCommandSpec {
  /** The single word that invokes it. */
  readonly name: string;
  /** One line, in the same voice as `CommandSpec.summary`. */
  readonly summary: string;
  /** How to invoke it, including the flags that change what it does. */
  readonly usage: string;
  /**
   * The longer description `standup <name> --help` prints. Present tense,
   * and written for someone who has not read the repo.
   */
  readonly detail: readonly string[];
}

export const TOP_LEVEL_COMMANDS: readonly TopLevelCommandSpec[] = [
  {
    name: "init",
    summary:
      "Set up an installation: find or provision a Postgres database, migrate it, seed it, and write local configuration.",
    usage:
      "standup init [--database-url <url>] [--provision-url <url>] [--database-name <name>] [--app-role <role>] [--app-password <password>]",
    detail: [
      "Establishes the configuration every other command needs, so it is the one command that runs before the 'not configured' gate.",
      "",
      "With no flags it looks for a database to use: --database-url, then DATABASE_URL, then a previous init's configuration file. If none is available it tries to provision one through a local container runtime (`docker compose`), and reports 'not configured' rather than crashing when that is unavailable too.",
      "",
      "Flags:",
      "  --database-url <url>     Use this connection string as-is. Nothing is created.",
      "  --provision-url <url>    An admin connection to create a fresh database and application role from.",
      "  --database-name <name>   Name for the provisioned database. Only with --provision-url.",
      "  --app-role <role>        Name for the provisioned application role. Only with --provision-url.",
      "  --app-password <pw>      Password for that role. Only with --provision-url.",
      "",
      "On success it migrates, seeds, proves the result with a live round trip, and writes the connection string to the local configuration file. The connection string is never printed.",
      "",
      "Postgres is required and is not swappable — see DECISIONS.md. Node >= 24 is enforced.",
    ],
  },
  {
    name: "doctor",
    summary:
      "Report what this installation is configured to talk to, and whether it could — the command to run when something else refuses.",
    usage: "standup doctor [--json] [--direct] [--as <person>] [--session <id>]",
    detail: [
      "Answers without needing a working configuration, which is the whole point: every other command stops with 'run `standup init` first', and this one reports the state that made them stop.",
      "",
      "It names each configuration value, whether it is present, and which layer supplied it — flag, environment, or configuration file. It never prints a connection string or a token.",
      "",
      "Exits 0 when a binding could be resolved, and 4 (not configured) when none could.",
    ],
  },
  {
    name: "mcp",
    summary: "Serve MCP over stdio, so an agent can use this installation with no server running.",
    usage: "standup mcp",
    detail: [
      "The agent-facing surface for a no-server installation. A server-backed installation already serves MCP over HTTP at /api/mcp; this is the local substitute.",
      "",
      "Direct-only by design: it runs the service layer in this process, so it needs DATABASE_URL (or a configuration file from `standup init`) and does not use STANDUP_URL.",
      "",
      "It checks for migration drift before serving a single call, and warns on stderr if the installed package and the database disagree.",
      "",
      "Point an agent's MCP client at `standup mcp` as the command. It speaks on stdin and stdout, so nothing else may write to stdout.",
    ],
  },
  {
    name: "hook",
    summary:
      "The agent-tool guard: decide one tool call, flush the spooled batch, or report the spool's state.",
    usage: "standup hook <run|flush|status>",
    detail: [
      "Wired into an agent tool's hook mechanism rather than run by hand.",
      "",
      "Verbs:",
      "  run      Decide the tool call on stdin. Answers in the agent tool's own JSON shape and exit code, not this command line's envelope.",
      "  flush    Send the spooled records to the server.",
      "  status   Report what is in the spool.",
      "",
      "An unrecognised or missing verb is refused rather than defaulting to `run` — a mistyped maintenance command must not execute the decision path against empty input and render a deny.",
    ],
  },
];

/** Looks up one non-noun/verb command by name. */
export function lookupTopLevelCommand(name: string | undefined): TopLevelCommandSpec | undefined {
  if (name === undefined) return undefined;
  return TOP_LEVEL_COMMANDS.find((command) => command.name === name);
}

/** The names, for the dispatcher and for help. */
export function topLevelCommandNames(): readonly string[] {
  return TOP_LEVEL_COMMANDS.map((command) => command.name);
}
