// What each operation is really bound to, per surface.
//
// This is the lookup `@/lib/surfaces` deliberately does not perform for
// itself. That module sits at `lib/` because `sessions.ts` needs it and the
// service layer imports `sessions.ts`, so it cannot import the command
// table: `cli/commands.ts` reaches `@/lib/service` through
// `cli/envelope.ts`, which would close a cycle, and it pulls `node:fs` in
// via `commands-backfill.ts` — into every web route that words a refusal,
// none of which import `lib/cli` today.
//
// So the tables are read here, inside the service layer, where importing
// both is free, and handed to `spellingsFor` as data.
//
// **Read, never restated.** Both answers come from the tables the system
// actually dispatches on — `COMMANDS`, which `lookupCommand` resolves
// against, and `ADAPTER_WAIVERS`, which the MCP tool list is derived from.
// A copy of either here would be a second list to forget, and this module
// exists precisely because a derivation that never consulted the first list
// advertised commands that do not exist.

import { COMMANDS } from "@/lib/cli/commands";
import type { SurfaceBindings } from "@/lib/surfaces";
import { FOLDED_INTO, operationsOffMcp } from "./advice";

/**
 * The command line's `<noun> <verb>` for each operation.
 *
 * Built once. An operation bound to more than one command keeps the first
 * in table order, which is the same one `--help` lists first; the table has
 * no such duplicate today, and if it gains one, naming either is correct
 * because both dispatch to this operation.
 *
 * **Aliases are deliberately not preferred.** `standup claim` and `standup
 * sweep` both resolve, but the canonical `<noun> <verb>` is what the help
 * output and SCHEMA.md §20 teach, and it is what stays correct if an alias
 * is ever retired. An alias that happens to match is a shortcut, not the
 * name of the command.
 */
const CLI_BY_OPERATION: ReadonlyMap<string, readonly [string, string]> = new Map(
  [...COMMANDS].reverse().map((command) => [command.operation, [command.noun, command.verb]]),
);

/**
 * What one operation is bound to, on every surface.
 *
 * `offMcp` is a parameter with a default so a caller resolving many
 * operations — the MCP tool index, a conformance sweep — computes the
 * waiver intersection once instead of per operation.
 */
export function bindingsFor(
  operation: string,
  offMcp: ReadonlySet<string> = operationsOffMcp(),
): SurfaceBindings {
  const cli = CLI_BY_OPERATION.get(operation);
  const foldedInto = FOLDED_INTO.get(operation);
  return {
    ...(cli ? { cli } : {}),
    // Waived off every MCP adapter means no tool of its own in
    // `tools/list`, whether or not a folding tool reaches its behaviour.
    // The fold is reported separately rather than by pretending the
    // operation is callable: `loop_close` is not a tool, `loop` is.
    onMcp: !offMcp.has(operation),
    ...(foldedInto ? { foldedInto } : {}),
  };
}
