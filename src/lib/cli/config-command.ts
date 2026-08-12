// `standup config` — MILESTONES.md #83: list, get, set, clear, describe,
// rendering label, help and validation from the registry; `sensitive` and
// `irreversible` keys require the confirmation flag.
//
// **A thin adapter, same as every other noun.** Every verb below calls one
// of the four settings operations row #78 already delivers
// (`get_settings`, `get_setting`, `put_setting`, `delete_setting`) — nothing
// here talks to a database, and nothing here re-implements what those
// operations already validate. `buildInput` only ever builds the request; a
// key's actual write-time validation happens once, inside `put_setting`,
// against the registry's own schema (SCHEMA.md §17.2 — "a value has one
// type, in one place").
//
// **`describe` deliberately calls the same operation as `get`.** SCHEMA.md
// §19 has no separate "describe" endpoint — `GET /settings/{key}` already
// answers "value, source, label, help, category, validation state… the
// registry, rendered" (§17.2). A distinct verb name earns its place in
// MILESTONES.md #83's list as a discoverable entry point ("explain this
// setting before I change it"), not as a second representation of the same
// fact — so its payload is, on purpose, identical to `get`'s.
//
// **The confirmation gate is the one piece of policy that lives here rather
// than in the service layer**, because it is a command-line safety habit
// (SCHEMA.md §17.8's "typing the setting's key to confirm" on `/settings`
// is the same idea, worn by a different adapter), not a rule the service
// enforces for every caller — MCP and the raw HTTP API have no equivalent
// gate, and are not asked to. It runs in `buildInput`, before any binding is
// reached, the same place `item get` already refuses a missing id (§20's
// "field validation is not done here" is about the operation's *value*
// schema; a safety flag the operation input has no field for is not that).
import { booleanFlag, type ParsedArgs } from "./args";
import { malformed, type ErrorEnvelope } from "./envelope";
import type { CommandSpec, InputResult } from "./commands";
import { getDefinition, isSettingKey } from "@/lib/settings";

/**
 * Turns the CLI's raw positional value into what `put_setting` expects.
 *
 * JSON first, so numbers, booleans, `null`, arrays and objects are typed
 * without a person needing to say so: `standup config set budget.enabled
 * true` sends the boolean `true`, never the string `"true"`. Falls back to
 * the raw string when it does not parse as JSON — `standup config set
 * notify.doc /docs/notify.md` sends the path as a string even though it is
 * not valid JSON on its own, because refusing it for the caller's own good
 * would be exactly the kind of guess this module's header says the schema,
 * not the adapter, should be making.
 */
export function parseSettingValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Refuses `config set`/`config clear` on a `sensitive` or `irreversible`
 * key unless `--confirm` was given (MILESTONES.md #83, SCHEMA.md §17.8).
 *
 * A key this build does not declare is **not** gated here: the service's own
 * `requireSettingKey` (settings-shared.ts) refuses it with `not_found`, and
 * a name this build has never heard of cannot be known to be sensitive, so
 * inventing a rule for it would be a guess dressed up as a safety check.
 *
 * **Everything this function *can* classify defaults to refusing.** It
 * reads `sensitive || irreversible` straight off the registry entry — never
 * a second, CLI-side table of "which keys are dangerous" that could drift
 * from it — and the only way past a `true` on either flag is an explicit
 * `--confirm`. There is no code path here that lets an ambiguous or
 * unrecognised shape through silently.
 */
function confirmationGate(
  key: string,
  flags: ParsedArgs["flags"],
  verb: "set" | "clear",
): { ok: false; envelope: ErrorEnvelope } | undefined {
  if (!isSettingKey(key)) return undefined;

  const definition = getDefinition(key);
  if (!definition.sensitive && !definition.irreversible) return undefined;

  const confirm = booleanFlag(flags, "confirm");
  if (!confirm.ok) return confirm;
  if (confirm.value) return undefined;

  const why = definition.irreversible
    ? "irreversible — it can destroy data that cannot be recreated"
    : "sensitive — it relaxes something this build enforces";
  return {
    ok: false,
    envelope: malformed(`${key} is ${why}. Re-run with --confirm to ${verb} it.`, ["confirm"]),
  };
}

/** `standup config list` — every declared setting, its value and its source. */
function buildListInput(): InputResult {
  return { ok: true, input: {} };
}

/** `standup config get <key>` / `standup config describe <key>` — one setting, in full. */
function buildGetInput(rest: readonly string[], verb: "get" | "describe"): InputResult {
  const key = rest[0];
  if (key === undefined) {
    return {
      ok: false,
      envelope: malformed(`\`standup config ${verb}\` needs a setting key.`, ["key"]),
    };
  }
  return { ok: true, input: { key } };
}

/** `standup config set <key> <value> [--confirm]`. */
function buildSetInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const key = rest[0];
  if (key === undefined) {
    return {
      ok: false,
      envelope: malformed("`standup config set` needs a setting key and a value.", ["key"]),
    };
  }
  if (rest.length < 2) {
    return {
      ok: false,
      envelope: malformed(`\`standup config set ${key}\` needs a value.`, ["value"]),
    };
  }

  const gated = confirmationGate(key, flags, "set");
  if (gated) return gated;

  // `rest[1]` is defined: `rest.length < 2` above already refused the case
  // where it is not.
  const raw = rest[1] as string;
  return { ok: true, input: { key, value: parseSettingValue(raw) } };
}

/** `standup config clear <key> [--confirm]`. */
function buildClearInput(rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const key = rest[0];
  if (key === undefined) {
    return {
      ok: false,
      envelope: malformed("`standup config clear` needs a setting key.", ["key"]),
    };
  }

  const gated = confirmationGate(key, flags, "clear");
  if (gated) return gated;

  return { ok: true, input: { key } };
}

/**
 * The `config` noun's commands (MILESTONES.md #83).
 *
 * Appended into `COMMANDS` by a single line in `commands.ts` — this module
 * is where row #83's own entries live, per the parallel-work convention
 * every CLI row on this command surface follows.
 */
export const CONFIG_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "config",
    verb: "list",
    operation: "get_settings",
    summary: "List every declared setting: value, source, label, help and category.",
    buildInput: buildListInput,
  },
  {
    noun: "config",
    verb: "get",
    operation: "get_setting",
    summary: "Show one setting: its value, source, label, help and category.",
    buildInput: (rest: readonly string[]) => buildGetInput(rest, "get"),
  },
  {
    noun: "config",
    verb: "describe",
    operation: "get_setting",
    summary: "Explain one setting — same detail as `get`, worded for reading before changing it.",
    buildInput: (rest: readonly string[]) => buildGetInput(rest, "describe"),
  },
  {
    noun: "config",
    verb: "set",
    operation: "put_setting",
    summary: "Set one setting's override. `sensitive`/`irreversible` keys need --confirm.",
    buildInput: (rest: readonly string[], flags: ParsedArgs["flags"]) => buildSetInput(rest, flags),
  },
  {
    noun: "config",
    verb: "clear",
    operation: "delete_setting",
    summary:
      "Clear one setting's override, reverting it to the registry default. `sensitive`/`irreversible` keys need --confirm.",
    buildInput: (rest: readonly string[], flags: ParsedArgs["flags"]) =>
      buildClearInput(rest, flags),
  },
]);
