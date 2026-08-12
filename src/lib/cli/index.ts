// The command-line adapter's public surface (SCHEMA.md §20, MILESTONES #79).
//
// Rows #80-#84 and #92 extend this adapter by adding entries to `COMMANDS`
// and, where they need one, a route to `HTTP_ROUTES` — never by adding a
// binding or a second dispatcher. Row #94's conformance harness imports
// `runCommand` and the two binding factories, which is why those three are
// the exports that matter here.
export { EXIT, exitCodeFor, malformed, ok, rejected } from "./envelope";
export type { Envelope, ErrorEnvelope, ExitCode, OkEnvelope } from "./envelope";

export { BINDING_NAMES, bindingOk, bindingRejected, isBindingName } from "./binding";
export type { Binding, BindingName, BindingOk, BindingRejected, BindingResult } from "./binding";

export { createDirectBinding } from "./bindings/direct";
export type { CallableService, DirectBindingOptions } from "./bindings/direct";

export { HTTP_ROUTES, createHttpBinding } from "./bindings/http";
export type { FetchLike, HttpBindingOptions, RouteSpec } from "./bindings/http";

export { booleanFlag, parseArgs, stringFlag } from "./args";
export type { ParsedArgs, ParseResult } from "./args";

export { ALIASES, COMMANDS, identityFlags, lookupCommand, nouns, verbsFor } from "./commands";
export type { CommandMatch, CommandSpec, LookupResult } from "./commands";

// Row #83 — `standup config`.
export { CONFIG_COMMANDS, parseSettingValue } from "./config-command";

export { describeResolution, firstDefined, resolveConfig } from "./config";
export type {
  CliEnvironment,
  CliFileConfig,
  CliFlags,
  ResolutionNote,
  ResolveInputs,
  ResolvedConfig,
} from "./config";

export { doctorReport } from "./doctor";
export type { CapabilityCheck, DoctorReport } from "./doctor";

export { runMcpStdio } from "./mcp";
export type { McpStdioOutcome, RunMcpStdioOptions } from "./mcp";

export { helpText, runCli, runCommand } from "./run";
export type { RunCliOptions, RunOutcome } from "./run";

export { humanText, render } from "./render";
export type { Streams } from "./render";

export { main } from "./main";
export type { MainOptions } from "./main";
