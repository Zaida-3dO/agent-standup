// The flag plumbing every command module shares.
//
// `GLOBAL_FLAGS` had six identical copies and `passThroughFlags` four, all
// written separately and all having drifted into being the same. A fix to one
// had to be remembered in every other, and the set of flags the dispatcher
// owns is not a per-module opinion — it is one fact about the command line.
//
// The sibling `args.ts` holds the parsers for a SINGLE flag (`stringFlag`,
// `booleanFlag`, `numericFlag`). This holds the rules that apply to the flag
// set AS A WHOLE: which names the dispatcher keeps for itself, and how the
// rest reach an operation.
import { malformed, type ErrorEnvelope } from "./envelope";
import { booleanFlag, numericFlag, stringFlag, type ParsedArgs } from "./args";

/**
 * The flags the dispatcher handles itself — never part of an operation's
 * input.
 *
 * These are the words that say HOW to run a command rather than WHAT to run
 * it on: which binding to use, which session and actor to attribute it to,
 * how to render the answer. An operation never declares a field for any of
 * them, so forwarding one would be refused by a `.strict()` schema as an
 * unknown field — naming a flag the person legitimately typed.
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "json",
  "direct",
  "as",
  "session",
  "url",
  "help",
]);

/** What collecting flags into an operation input produced. */
export type FieldsResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/**
 * Collects the value-carrying flags into an operation input.
 *
 * ⚠️ **PASS-THROUGH BY DEFAULT, AND IT MUST STAY THAT WAY.**
 *
 * This forwards EVERY flag that is not global and not already consumed,
 * untouched, and the operation's own `.strict()` schema does the refusing. A
 * builder calling this may enumerate **positionals and bare switches only**.
 * Neither this function nor any builder above it may carry an **allow-list of
 * value-flag names**.
 *
 * Why an allow-list is the dangerous shape, specifically: a builder that
 * filtered to a list of fields it knew about would **silently drop** any flag
 * missing from that list. The dropped field is valid on the shared schema, so
 * nothing ever refuses it — the call is parsed, the value is discarded, and
 * the caller is answered with a success. That is a defect this codebase has
 * shipped once already: a `--reason` on a close was accepted and thrown away.
 *
 * It also means a refusal-shaped test cannot catch it. The regression tests
 * for this write a value and read it back through a separate call, because
 * that is the only assertion that can tell "kept" from "accepted and
 * discarded" — see `tests/cli-loop-noun-fields.test.ts`.
 *
 * `consumed` names the bare switches a verb has already read with
 * `booleanFlag`. They are skipped rather than left to fall through, because
 * this function refuses a valueless flag outright and passing one through
 * would send it to the operation twice under two spellings. Passing the names
 * here rather than pre-stripping the flag object keeps "which flags did this
 * command handle?" readable in the command entry.
 */
export function passThroughFlags(
  flags: ParsedArgs["flags"],
  consumed: readonly string[] = [],
): FieldsResult {
  const input: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(name)) continue;
    if (consumed.includes(name)) continue;
    if (value === true) {
      return { ok: false, envelope: malformed(`--${name} needs a value.`, [name]) };
    }
    input[name] = value;
  }
  return { ok: true, input };
}

/**
 * Maps the global `--session` flag onto an operation's own optional
 * `sessionId` field.
 *
 * `--session` is the one global flag that is also a field on many operations:
 * it says who is calling, and a session-scoped operation records that. It is
 * still global — the dispatcher reads it for attribution regardless — so it
 * is excluded from `passThroughFlags` and added back here, under the name the
 * schema uses, by the verbs that take it.
 */
export function withSessionId(
  input: Record<string, unknown>,
  flags: ParsedArgs["flags"],
): FieldsResult {
  const session = stringFlag(flags, "session");
  if (!session.ok) return session;
  if (session.value === undefined) return { ok: true, input };
  return { ok: true, input: { ...input, sessionId: session.value } };
}

/**
 * Reads the leading item-id positional a verb requires, naming it when it is
 * absent.
 *
 * `usage` is the command as a person would type it, so the refusal shows the
 * shape rather than describing it.
 */
export function itemIdPositional(
  rest: readonly string[],
  usage: string,
): { ok: true; itemId: string } | { ok: false; envelope: ErrorEnvelope } {
  const itemId = rest[0];
  if (itemId === undefined) {
    return { ok: false, envelope: malformed(`\`standup ${usage}\` needs an item id.`, ["itemId"]) };
  }
  return { ok: true, itemId };
}

/**
 * What one verb reads from the words and flags after it.
 *
 * ⚠️ **POSITIONALS AND BARE SWITCHES ONLY. NEVER VALUE-FLAG NAMES.**
 *
 * This is the shape of a descriptor, and the shape is the safety property.
 * Every field below names either a positional word or a flag written without
 * a value; every *value-carrying* flag reaches the operation through
 * `passThroughFlags` untouched, and the operation's own `.strict()` schema
 * does the refusing.
 *
 * Adding a `fields: ["headline", "reason", ...]` key here — a list of the
 * value flags a verb accepts — is the one change that reintroduces row
 * `fa83f2b9`, and it is worth being precise about why it is so hard to
 * catch. A builder filtered to such a list silently DROPS any flag missing
 * from it. The dropped field is valid on the shared schema, so nothing
 * refuses: the call is parsed, the value is discarded, and the caller is
 * answered with a success. This codebase has shipped that defect three
 * times; the first was a `--reason` on a close that was accepted and thrown
 * away.
 *
 * It also means **a refusal-shaped test cannot catch it.** Asserting that a
 * bad flag is refused passes against the bug, because the bug refuses
 * nothing. The regression tests for this write a value and read it back
 * through a separate call — see `tests/cli-loop-noun-fields.test.ts` and
 * `tests/cli-merged-builder-fields.test.ts`, which is the only assertion
 * that can tell "kept" from "accepted and discarded".
 */
export interface VerbFields {
  /**
   * The leading item-id positional, and the usage line a refusal shows.
   *
   * Absent for a verb that takes no item — `session my-work` and `crew name`
   * are about the session, not about one item.
   */
  readonly itemId?: string;
  /**
   * What the leading positional is called in the operation's input.
   *
   * Defaults to `itemId`. `get_item_artifacts` names it `id` — it is a read
   * of ONE item, spelled the way every other single-item read spells it —
   * and sending the wrong one would be refused by a `.strict()` schema
   * naming a field the person never typed.
   */
  readonly itemIdField?: string;
  /**
   * Bare switches, by flag name, mapped onto the input field each sets.
   *
   * Read with `booleanFlag` and declared consumed, because
   * `passThroughFlags` refuses a valueless flag — which for a switch is
   * exactly backwards, since a bare `--force` is the correct way to write
   * it.
   */
  readonly switches?: Readonly<Record<string, string>>;
  /**
   * Switches sent ONLY when the flag was actually written.
   *
   * `takeover`'s `--force` and `sweep`'s `--dry-run` are optional on their
   * schemas, and a call that never mentioned one should not be recorded as
   * having explicitly declined it. Named separately from `switches` rather
   * than inferred, because "absent means false" and "absent means absent"
   * are different claims and only the verb knows which it makes.
   */
  readonly optionalSwitches?: Readonly<Record<string, string>>;
  /** Flags naming a numeric field, converted before the schema sees a string. */
  readonly numbers?: Readonly<Record<string, string>>;
  /** Whether `--session` maps onto the operation's own `sessionId` field. */
  readonly session?: boolean;
  /**
   * A leading positional that is not an item id, and the field it carries.
   *
   * `score run <run-id>` and `score intervention <event-id>` read a run and
   * an event. `required: false` makes it optional — `score interventions`
   * takes an item id positionally if one is given and lists everything if
   * not.
   */
  readonly positional?: {
    readonly field: string;
    readonly usage: string;
    readonly required: boolean;
  };
  /**
   * Command-line spellings mapped onto the schema's field names.
   *
   * A RENAME, not a filter, and the difference is the whole safety
   * property: a flag with no entry here passes through under its own name
   * and is refused by the operation's `.strict()` schema if it is wrong.
   * Nothing is dropped.
   */
  readonly rename?: Readonly<Record<string, string>>;
  /**
   * Flags whose STRING value a verb reshapes before the schema sees it, and
   * the field each result lands under.
   *
   * `score run --facets` carries JSON because its field is an array of
   * objects; `score accept --facets` carries `a,b` because its field is an
   * array of plain strings. Same flag, two verbs, two shapes — so the
   * reshaping is per verb and cannot be a property of the flag name.
   *
   * **This is a TRANSFORM, not an allow-list.** A flag named here is read
   * and declared consumed so it is not also forwarded raw; every flag NOT
   * named here still passes through untouched. Nothing is dropped. The
   * `to` field is what lets `--facets` land on `scores`, keeping the word a
   * person types separate from the word the schema uses.
   */
  readonly transforms?: Readonly<
    Record<
      string,
      {
        readonly to: string;
        readonly parse: (
          raw: string,
        ) => { ok: true; value: unknown } | { ok: false; message: string };
      }
    >
  >;
}

/**
 * Builds one verb's input from its descriptor.
 *
 * Reads the item id, then the verb's switches and numbers, then forwards
 * every remaining flag untouched. **Field validation is not done here** — a
 * missing required field is left absent so the operation's own schema is
 * what refuses it and names it, which is the rule `commands.ts`'s
 * `CommandSpec` header states and the reason this builder can be shared at
 * all.
 */
export function buildVerbInput(
  fields: VerbFields,
): (rest: readonly string[], flags: ParsedArgs["flags"]) => FieldsResult {
  return (rest, flags) => {
    const consumed: string[] = [];
    const values: Record<string, unknown> = {};

    for (const [name, field] of Object.entries(fields.switches ?? {})) {
      const read = booleanFlag(flags, name);
      if (!read.ok) return read;
      consumed.push(name);
      values[field] = read.value;
    }

    for (const [name, field] of Object.entries(fields.optionalSwitches ?? {})) {
      const read = booleanFlag(flags, name);
      if (!read.ok) return read;
      consumed.push(name);
      if (flags[name] !== undefined) values[field] = read.value;
    }

    for (const [name, transform] of Object.entries(fields.transforms ?? {})) {
      const raw = stringFlag(flags, name);
      if (!raw.ok) return raw;
      consumed.push(name);
      if (raw.value === undefined) continue;
      const parsed = transform.parse(raw.value);
      if (!parsed.ok) {
        return { ok: false, envelope: malformed(parsed.message, [name]) };
      }
      values[transform.to] = parsed.value;
    }

    for (const [name, field] of Object.entries(fields.numbers ?? {})) {
      const read = numericFlag(flags, name);
      if (!read.ok) return read;
      consumed.push(name);
      if (read.value !== undefined) values[field] = read.value;
    }

    const passthrough = passThroughFlags(flags, consumed);
    if (!passthrough.ok) return passthrough;

    let input: Record<string, unknown> = passthrough.input;
    if (fields.session === true) {
      const withSession = withSessionId(input, flags);
      if (!withSession.ok) return withSession;
      input = withSession.input;
    }

    let merged: Record<string, unknown> = { ...input, ...values };

    if (fields.rename !== undefined) {
      const renamed: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(merged)) {
        renamed[fields.rename[name] ?? name] = value;
      }
      merged = renamed;
    }

    if (fields.positional !== undefined) {
      const value = rest[0];
      if (value === undefined) {
        if (fields.positional.required) {
          return {
            ok: false,
            envelope: malformed(
              `\`standup ${fields.positional.usage}\` needs a ${fields.positional.field}.`,
              [fields.positional.field],
            ),
          };
        }
      } else {
        merged[fields.positional.field] = value;
      }
    }

    if (fields.itemId !== undefined) {
      const idResult = itemIdPositional(rest, fields.itemId);
      if (!idResult.ok) return idResult;
      // Last, so a flag of the same name cannot displace the id the person
      // typed as the subject of the command.
      merged[fields.itemIdField ?? "itemId"] = idResult.itemId;
    }

    return { ok: true, input: merged };
  };
}
