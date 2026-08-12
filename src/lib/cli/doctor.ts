// `standup doctor` — what this installation is configured to talk to, and
// whether it could (SCHEMA.md §20, DECISIONS §13f).
//
// It is the one command that answers *without* a binding. Every other
// command preflights and stops with "run `standup init` first"; doctor's
// entire reason to exist is to report the state that makes the others stop,
// so stopping the same way would leave a person with no way to find out
// what is missing.
//
// **What it may report is bounded by construction.** Every note it produces
// is a `ResolutionNote` — a name, whether a value is present, and which
// layer supplied it. There is no field on that type for a value, so a later
// change that was not thinking about secrets still cannot put a connection
// string in one (§20: "the connection string … is never printed by any
// command").
import {
  describeResolution,
  resolveConfig,
  type ResolutionNote,
  type ResolveInputs,
} from "./config";

/** What a doctor run found. */
export interface DoctorReport {
  /** Whether a binding could be resolved at all. */
  readonly configured: boolean;
  /** Which binding a command would use, when one resolved. */
  readonly binding?: string;
  /** Each bootstrap value: present or not, and from where. Never the value. */
  readonly configuration: readonly ResolutionNote[];
  /** What is wrong, in the order a person would fix it. Empty when configured. */
  readonly problems: readonly string[];
  /**
   * The capability paths this build re-checks locally — the row's "which
   * also re-checks configured capability paths locally".
   *
   * Row #79 ships the reporting shape and the two paths that exist today:
   * whether a server is addressable and whether a database is. Rows that
   * add capabilities (#43's session registration, #84's stdio MCP) add
   * their own checks here rather than a second report.
   */
  readonly capabilities: readonly CapabilityCheck[];
}

/** One capability, as doctor reports it. */
export interface CapabilityCheck {
  readonly name: string;
  /** `available` — configured and usable in principle. `unavailable` — not configured. */
  readonly status: "available" | "unavailable";
  readonly detail: string;
}

/**
 * Builds the report.
 *
 * Deliberately does **no** I/O: it does not open a connection or call the
 * server. That is a limit worth stating plainly rather than discovering — a
 * green doctor here means *this installation knows what it would talk to*,
 * not that the thing is reachable. Proving reachability with a live round
 * trip is `standup init`'s job (row #80), which is where a connection is
 * being established anyway; doing it here too would mean every `doctor` run
 * paid a connection to tell a person something the next command would tell
 * them.
 */
export function doctorReport(inputs: ResolveInputs = {}): DoctorReport {
  const configuration = describeResolution(inputs);
  const resolution = resolveConfig(inputs);
  const byName = new Map(configuration.map((note) => [note.name, note]));

  const serverConfigured = byName.get("STANDUP_URL")?.present === true;
  const databaseConfigured = byName.get("DATABASE_URL")?.present === true;

  const capabilities: CapabilityCheck[] = [
    {
      name: "server",
      status: serverConfigured ? "available" : "unavailable",
      detail: serverConfigured
        ? "A server address is configured; commands can call the API."
        : "No server address configured. The front end and the long-poll need one.",
    },
    {
      name: "database",
      status: databaseConfigured ? "available" : "unavailable",
      detail: databaseConfigured
        ? "A database is configured; commands can run the service layer in this process."
        : "No database configured. --direct and `standup init` need one.",
    },
  ];

  if (resolution.ok) {
    return {
      configured: true,
      binding: resolution.config.binding,
      configuration,
      problems: [],
      capabilities,
    };
  }

  return {
    configured: false,
    configuration,
    problems: [resolution.envelope.error.message],
    capabilities,
  };
}
