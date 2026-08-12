// The command table: `<noun> <verb>`, and the aliases that resolve into it
// (SCHEMA.md §20).
//
// **A command is a name and an input builder, never a transport.** Each
// entry says which service operation it calls and how to turn the parsed
// words and flags into that operation's input — and then stops. It does not
// know whether it will run in-process or over the API, which is the property
// that makes "one set of command implementations sits above both" true
// rather than aspirational: there is no place in an entry below for a
// binding-specific branch to be written.
//
// **Aliases resolve to the same operation, so nothing downstream sees them**
// (§20). They are entries in a table mapping alias → canonical
// `<noun> <verb>`, resolved before lookup, so an aliased command and its long
// form produce the identical `CommandMatch` — not merely an equivalent one.
import { malformed, type ErrorEnvelope } from "./envelope";
import { stringFlag, type ParsedArgs } from "./args";

/** What building an input produced. */
export type InputResult =
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/** One `<noun> <verb>` command. */
export interface CommandSpec {
  readonly noun: string;
  readonly verb: string;
  /** The registered service operation this calls. */
  readonly operation: string;
  /** One line, as `--help` reads it. */
  readonly summary: string;
  /**
   * Turns the words after `<noun> <verb>` and the flags into the
   * operation's input. Refuses only what it can tell is wrong without the
   * schema — a missing positional argument. **Field validation is not done
   * here**: the operation's own schema is the single place input is
   * validated (SCHEMA.md §22, "every adapter parses the same schema through
   * the same call"), so re-checking a field here would create a second
   * rejection this adapter could produce that no other adapter would.
   */
  readonly buildInput: (rest: readonly string[], flags: ParsedArgs["flags"]) => InputResult;
}

function noInput(): InputResult {
  return { ok: true, input: {} };
}

/** Collects `--key value` flags into an input object, dropping the global ones. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

function flagsToInput(flags: ParsedArgs["flags"]): InputResult {
  const input: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(name)) continue;
    if (value === true) {
      return { ok: false, envelope: malformed(`--${name} needs a value.`, [name]) };
    }
    input[name] = value;
  }
  return { ok: true, input };
}

/**
 * The commands this row ships.
 *
 * Row #79 is the foundation: the entry point, the dispatch, the bindings and
 * the envelope. The item verbs below exist because a dispatcher with nothing
 * to dispatch cannot be tested — `item get`, `item list` and `item create`
 * are the three that the service layer already has operations for, so they
 * are real end to end. **Rows #81–#83 own the rest** (`item transition`,
 * `item complete`, ownership, `standup config`); they add entries here and
 * inherit the dispatch, the bindings, the envelope and the exit codes
 * without touching either binding.
 */
export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "item",
    verb: "get",
    operation: "get_item",
    summary: "Show one item.",
    buildInput: (rest) => {
      const id = rest[0];
      if (id === undefined) {
        return { ok: false, envelope: malformed("`standup item get` needs an item id.", ["id"]) };
      }
      return { ok: true, input: { id } };
    },
  },
  {
    noun: "item",
    verb: "list",
    operation: "list_items",
    summary: "List items, filtered by state, priority, area, repo or parent.",
    buildInput: (_rest, flags) => flagsToInput(flags),
  },
  {
    noun: "item",
    verb: "create",
    operation: "create_item",
    summary: "Create an item.",
    buildInput: (_rest, flags) => flagsToInput(flags),
  },
  {
    noun: "service",
    verb: "info",
    operation: "service_info",
    summary: "What this build exposes, and the limits a caller has to respect.",
    buildInput: noInput,
  },
]);

/**
 * The short alias list, covering "the commands used constantly" (§20).
 *
 * Each maps one word onto a `<noun> <verb>` pair. They are resolved *into*
 * the table above rather than being entries of their own, so an alias can
 * never drift from the command it abbreviates: there is only one
 * implementation, and the alias is a rewrite of the words before lookup.
 */
export const ALIASES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  ls: ["item", "list"],
  show: ["item", "get"],
  new: ["item", "create"],
});

/** A resolved command, plus the words left over for it. */
export interface CommandMatch {
  readonly command: CommandSpec;
  readonly rest: readonly string[];
  /** The alias typed, if one was. Reported by `--json`; never branched on. */
  readonly viaAlias?: string;
}

export type LookupResult =
  | { readonly ok: true; readonly match: CommandMatch }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/** Every noun in the table, sorted, for a help line. */
export function nouns(): readonly string[] {
  return [...new Set(COMMANDS.map((command) => command.noun))].sort();
}

/** Every verb registered under one noun, sorted. */
export function verbsFor(noun: string): readonly string[] {
  return COMMANDS.filter((command) => command.noun === noun)
    .map((command) => command.verb)
    .sort();
}

/**
 * Resolves words into a command.
 *
 * The order is the design: an alias is rewritten into `<noun> <verb>` first,
 * and then exactly one lookup runs. A dispatcher that checked the alias
 * table *after* failing the command lookup would work for every case that
 * exists today and diverge the moment an alias shared a name with a noun,
 * because the two paths would then be reachable for the same input.
 */
export function lookupCommand(words: readonly string[]): LookupResult {
  const first = words[0];
  if (first === undefined) {
    return {
      ok: false,
      envelope: malformed(
        `Nothing to do. Usage: standup <noun> <verb>. Nouns: ${nouns().join(", ")}.`,
      ),
    };
  }

  const alias = ALIASES[first];
  const [noun, verb, rest, viaAlias] = alias
    ? [alias[0], alias[1], words.slice(1), first]
    : [first, words[1], words.slice(2), undefined];

  const known = COMMANDS.filter((command) => command.noun === noun);
  if (known.length === 0) {
    return {
      ok: false,
      envelope: malformed(`No such noun: ${noun}. Nouns: ${nouns().join(", ")}.`, ["noun"]),
    };
  }

  if (verb === undefined) {
    return {
      ok: false,
      envelope: malformed(
        `\`standup ${noun}\` needs a verb. Verbs: ${verbsFor(noun).join(", ")}.`,
        ["verb"],
      ),
    };
  }

  const command = known.find((candidate) => candidate.verb === verb);
  if (!command) {
    return {
      ok: false,
      envelope: malformed(
        `No such verb for ${noun}: ${verb}. Verbs: ${verbsFor(noun).join(", ")}.`,
        ["verb"],
      ),
    };
  }

  return {
    ok: true,
    match: { command, rest, ...(viaAlias === undefined ? {} : { viaAlias }) },
  };
}

/** Reads the global identity flags, refusing a bare `--as` or `--session`. */
export function identityFlags(
  flags: ParsedArgs["flags"],
):
  | { ok: true; as?: string; session?: string; url?: string }
  | { ok: false; envelope: ErrorEnvelope } {
  const as = stringFlag(flags, "as");
  if (!as.ok) return as;
  const session = stringFlag(flags, "session");
  if (!session.ok) return session;
  const url = stringFlag(flags, "url");
  if (!url.ok) return url;
  return {
    ok: true,
    ...(as.value === undefined ? {} : { as: as.value }),
    ...(session.value === undefined ? {} : { session: session.value }),
    ...(url.value === undefined ? {} : { url: url.value }),
  };
}
