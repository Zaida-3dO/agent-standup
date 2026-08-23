// Argument parsing: the words, the flags, and nothing else (SCHEMA.md §20).
//
// This module does not know what a command is. It splits `argv` into
// positional words and flags, and the dispatcher decides whether those words
// name anything. Keeping the two apart is what lets `standup item lst` and
// `standup nonsense list` both be refused as malformed by one code path
// while `--json` is still honoured on the way out — a parser that rejected
// unknown words itself would have to know the command table, and then the
// table would be reachable two ways.
import { malformed, type ErrorEnvelope } from "./envelope";

export interface ParsedArgs {
  /** The positional words, in order: `<noun> <verb>` and anything after. */
  readonly words: readonly string[];
  /** Every `--flag` seen, by name. A bare flag is `true`. */
  readonly flags: Readonly<Record<string, string | true>>;
}

export type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedArgs }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/**
 * Splits `argv` (already stripped of the node binary and the script path).
 *
 * Accepts both `--flag value` and `--flag=value`, because both are typed by
 * people and refusing one of them is a papercut with no upside. Short flags
 * are deliberately not supported: `-a` would collide with the alias table
 * the moment an alias started with a dash, and §20 specifies long flags
 * only.
 *
 * `--` ends flag parsing, so a value that looks like a flag can still be
 * passed as a word.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    // `noUncheckedIndexedAccess` types this as possibly undefined; the loop
    // bound makes it never so. Skipping rather than asserting keeps the
    // narrowing honest without a non-null assertion.
    if (token === undefined) continue;

    if (literal) {
      words.push(token);
      continue;
    }

    if (token === "--") {
      literal = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      if (body.length === 0) continue;

      const equals = body.indexOf("=");
      if (equals !== -1) {
        const name = body.slice(0, equals);
        if (name.length === 0) {
          return { ok: false, envelope: malformed(`Not a flag: ${token}.`) };
        }
        flags[name] = body.slice(equals + 1);
        continue;
      }

      // A bare `--flag` takes the next token as its value *only* if that
      // token is not itself a flag. `--json --direct` must be two booleans,
      // not `json="--direct"`, and a parser that always consumed the next
      // token would silently swallow the second one.
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      return {
        ok: false,
        envelope: malformed(
          `Not a flag this build understands: ${token}. Flags are spelled --name.`,
        ),
      };
    }

    words.push(token);
  }

  return { ok: true, parsed: { words, flags } };
}

/** Reads a flag that must carry a value, refusing a bare one. */
export function stringFlag(
  flags: ParsedArgs["flags"],
  name: string,
): { ok: true; value?: string } | { ok: false; envelope: ErrorEnvelope } {
  const value = flags[name];
  if (value === undefined) return { ok: true };
  if (value === true) {
    return { ok: false, envelope: malformed(`--${name} needs a value.`, [name]) };
  }
  return { ok: true, value };
}

/** Reads a flag that is present or absent, refusing one given a value. */
export function booleanFlag(
  flags: ParsedArgs["flags"],
  name: string,
): { ok: true; value: boolean } | { ok: false; envelope: ErrorEnvelope } {
  const value = flags[name];
  if (value === undefined) return { ok: true, value: false };
  if (value !== true) {
    return { ok: false, envelope: malformed(`--${name} does not take a value.`, [name]) };
  }
  return { ok: true, value: true };
}

/**
 * Reads a flag whose operation schema declares a number.
 *
 * A command line has no types: every flag arrives as a string, so a schema
 * field declared `z.number()` refuses `--limit 5` with `invalid_input` and
 * names a field the person did type but cannot satisfy. This is the one
 * conversion the adapter owes the schema, and it lives here so there is a
 * single spelling of it rather than one per command module.
 *
 * **Refuses rather than passing a bad value through.** `z.number()` would
 * also reject `--limit abc`, but its message talks about a type; the useful
 * sentence names the flag that was typed. Refusing here does not duplicate
 * schema validation — the *range* (`min`/`max`) stays the schema's, and is
 * deliberately not checked here.
 *
 * Trimmed and checked for emptiness before `Number`, because `Number("")`
 * and `Number("  ")` are both `0` — an integer some schemas accept, so
 * without this `--limit ""` would silently mean something rather than being
 * refused.
 */
export function numericFlag(
  flags: ParsedArgs["flags"],
  name: string,
): { ok: true; value?: number } | { ok: false; envelope: ErrorEnvelope } {
  const raw = stringFlag(flags, name);
  if (!raw.ok) return raw;
  if (raw.value === undefined) return { ok: true };
  const text = raw.value.trim();
  const parsed = text === "" ? Number.NaN : Number(text);
  if (!Number.isInteger(parsed)) {
    return { ok: false, envelope: malformed(`--${name} must be a whole number.`, [name]) };
  }
  return { ok: true, value: parsed };
}
