// MILESTONES.md #100 — the loop verbs, as the `loop` noun.
//
// In their own module, appended to `commands.ts`'s table as a single spread,
// per that file's header: rows add entries rather than rewriting existing
// lines, so concurrent CLI rows do not conflict over the same lines.
//
// ── Why `loop <verb>` and not `item loop-<verb>` ──────────────────────
//
// These six were `item loop`, `item loop-close`, `item loops`, `item
// loop-get`, `item loop-edit` and `item loop-delete` — five hyphenated
// pseudo-verbs hanging off `item`, which is the grammar defect: `loop-close`
// is a noun and a verb welded together because the noun had nowhere to live.
// They are now `loop add|close|list|get|edit|delete`.
//
// All six old spellings remain as aliases, so nothing a person or a script
// types breaks. `ALIASES` resolves before lookup, so an aliased command and
// its long form produce the identical match rather than merely an equivalent
// one.
//
// The MCP tool that folds the same six is already called `loop`, so this
// gives one capability one spelling on both surfaces. It does add a noun —
// `item` keeps its other verbs — and that is the trade: a count that rises
// while the grammar gets more regular. The number was never the goal.
//
// ── One builder, and the rule it must obey ───────────────────────────
//
// The six `buildInput`s are now one, driven by `ACTION_FIELDS` below. That
// merge is where this file could reintroduce a defect it has already seen,
// so the rule is stated on `passThroughFlags` and must be read before
// changing it.
import { malformed, type ErrorEnvelope } from "./envelope";
import { booleanFlag, stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/** The flags the dispatcher handles itself — never part of an operation's input. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

type FieldsResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

/**
 * Same behaviour as `commands.ts`'s `flagsToInput` — see
 * `commands-ownership.ts` for why it is a second copy.
 *
 * ⚠️ **PASS-THROUGH BY DEFAULT. This is the invariant that keeps the merged
 * builder below safe, and it is NOT "one builder per verb".**
 *
 * This forwards EVERY flag that is not global and not already consumed,
 * untouched, and the operation's own `.strict()` schema does the refusing. A
 * merged `buildInput` may enumerate **positionals and bare switches only**.
 * It must **NEVER** carry an allow-list of value-flag names.
 *
 * Why an allow-list is the dangerous shape, specifically: a builder that
 * filtered to a list of fields it knew about would **silently drop** any flag
 * missing from that list. The dropped field is valid on the shared schema, so
 * nothing ever refuses it — the call is parsed, the value is discarded, and
 * the caller is answered with a success. That is exactly the defect this
 * codebase shipped once before (row `fa83f2b9`): `--reason` on a close was
 * accepted and thrown away.
 *
 * It also means a refusal-shaped test cannot catch it. The regression test
 * for this writes a value and reads it back through a separate call, because
 * that is the only assertion that can tell "kept" from "accepted and
 * discarded".
 *
 * `consumed` names the bare switches a verb has already read with
 * `booleanFlag`. They are skipped rather than left to fall through, because
 * this function refuses a valueless flag outright and passing one through
 * would send it to the operation twice under two spellings.
 */
function passThroughFlags(
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

/** `--session` maps onto the operation's own optional `sessionId` field. */
function withSessionId(input: Record<string, unknown>, flags: ParsedArgs["flags"]): FieldsResult {
  const session = stringFlag(flags, "session");
  if (!session.ok) return session;
  if (session.value === undefined) return { ok: true, input };
  return { ok: true, input: { ...input, sessionId: session.value } };
}

/**
 * What each verb reads from the words after it — POSITIONALS ONLY.
 *
 * This is deliberately not a description of the whole input. It says which
 * positional words a verb consumes and what to call them; every flag reaches
 * the operation through `passThroughFlags` regardless of what is written
 * here. Listing value flags in this table would turn it into the allow-list
 * the warning above forbids.
 *
 * `text: true` means the verb takes the remaining words as prose, joined.
 * That is how a loop's text arrives rather than through a `--text` flag: it
 * is the whole point of the command, and quoting a sentence into a flag is
 * the friction that stops a loose end being recorded at all. The same
 * reasoning puts a commit message after the verb.
 *
 * `switches` names the bare switches the verb reads with `booleanFlag`, which
 * must be declared consumed so they are not also forwarded under their own
 * names.
 */
const ACTION_FIELDS: Readonly<
  Record<
    string,
    {
      readonly operation: string;
      readonly positionals: readonly string[];
      readonly text: boolean;
      readonly switches: Readonly<Record<string, string>>;
      readonly usage: string;
      readonly summary: string;
    }
  >
> = Object.freeze({
  add: {
    operation: "loop_add",
    positionals: [],
    text: true,
    switches: {},
    usage: "loop add <item-id> <text>",
    summary:
      "Records a loose end on an item — a piece of work that still needs doing but is not big enough to be its own item. " +
      "Loops track WORK: a reference or a status note belongs in the repo or in a note, not here. " +
      "--kind note keeps one out of the count of work outstanding; --kind blocked_on_person is for something real waiting on a human.",
  },
  close: {
    operation: "loop_close",
    positionals: ["loopId"],
    text: false,
    switches: {},
    usage: "loop close <item-id> <loop-id>",
    summary:
      "Closes an open loop on an item. --reason optionally records how it was resolved, and is reported with the closed loop.",
  },
  list: {
    operation: "loop_list",
    positionals: [],
    text: false,
    // Notes are held out of the default list because the count is what a
    // person reads to judge whether an item is nearly done; `--notes` asks
    // for them back. Loops blocked on a person are NOT held back — they are
    // work.
    switches: { all: "includeClosed", deleted: "includeDeleted", notes: "includeNonWork" },
    usage: "loop list <item-id>",
    summary:
      "List an item's loops — id, kind, status, when it opened and the first 200 characters. Open loops that track work only; --all includes closed ones, --deleted includes retracted ones, --notes includes loops filed as notes.",
  },
  get: {
    operation: "loop_get",
    positionals: ["loopId"],
    text: false,
    switches: {},
    usage: "loop get <item-id> <loop-id>",
    summary: "Show one loop on an item in full, by its loop id.",
  },
  edit: {
    operation: "loop_edit",
    positionals: ["loopId"],
    text: true,
    switches: {},
    usage: "loop edit <item-id> <loop-id> <text>",
    summary: "Rewrite an open loop's text. Keeps its original openedAt.",
  },
  delete: {
    operation: "loop_delete",
    positionals: ["loopId"],
    text: false,
    switches: {},
    usage: "loop delete <item-id> <loop-id>",
    // The reason is a flag rather than trailing prose, deliberately unlike
    // the text on `add` and `edit`. It is not the content of the thing being
    // recorded — it is a justification the operation refuses without, and
    // `--reason` at the end of the line reads as the deliberate step it is
    // meant to be. `item delete` spells the same requirement the same way.
    summary:
      "Retract a loop that should never have existed — a duplicate, or one recorded by accident. Needs --reason. Use close for a real loose end that is resolved.",
  },
});

/**
 * The one builder, for all six verbs.
 *
 * Reads the item id, then the verb's own positionals, then its bare
 * switches, then forwards everything else. Field validation is NOT done here
 * — a missing `--text` or `--reason` is left absent so the operation's own
 * schema is what refuses it and names it, which is the rule `commands.ts`'s
 * `CommandSpec` header states and the reason this builder can be shared at
 * all.
 */
function buildLoopInput(
  action: keyof typeof ACTION_FIELDS,
): (rest: readonly string[], flags: ParsedArgs["flags"]) => InputResult {
  const spec = ACTION_FIELDS[action]!;
  return (rest, flags) => {
    const itemId = rest[0];
    if (itemId === undefined) {
      return {
        ok: false,
        envelope: malformed(`\`standup ${spec.usage}\` needs an item id.`, ["itemId"]),
      };
    }

    const switchNames = Object.keys(spec.switches);
    const switchValues: Record<string, unknown> = {};
    for (const name of switchNames) {
      const read = booleanFlag(flags, name);
      if (!read.ok) return read;
      switchValues[spec.switches[name]!] = read.value;
    }

    const passthrough = passThroughFlags(flags, switchNames);
    if (!passthrough.ok) return passthrough;
    const withSession = withSessionId(passthrough.input, flags);
    if (!withSession.ok) return withSession;

    const input: Record<string, unknown> = {
      ...withSession.input,
      ...switchValues,
      itemId,
    };

    // Positionals after the item id, in the order the verb declares them.
    spec.positionals.forEach((name, index) => {
      const value = rest[index + 1];
      if (value !== undefined) input[name] = value;
    });

    if (spec.text) {
      const words = rest.slice(1 + spec.positionals.length);
      // Left absent when there are none, so the schema's own "loop text is
      // required" is what refuses it. A caller passing `--text` explicitly
      // still works, because that flag passes through like any other.
      if (words.length > 0) input.text = words.join(" ");
    }

    return { ok: true, input };
  };
}

/**
 * Each verb's `item <verb>` spelling, kept alongside the `loop` noun.
 *
 * Both spellings are accepted so that nothing a person or a script types has
 * to change. `item loop` opens one and `item loops` lists them — a
 * distinction carried entirely by one letter, which is a good part of why
 * the `loop` noun is worth having.
 *
 * **Retained as full command entries rather than as `ALIASES` rows**, and
 * that is forced rather than chosen: `ALIASES` rewrites only the FIRST word
 * (`lookupCommand` reads `ALIASES[words[0]]`), so it can express `ls` →
 * `item list` but cannot express `item loop-close` → `loop close`. A
 * two-word alias has nowhere to live in that table.
 *
 * They share the same `buildInput` and name the same operation as the `loop`
 * verbs, so the two spellings cannot drift: there is one implementation and
 * these entries point at it.
 */
const OLD_SPELLINGS: Readonly<Record<string, keyof typeof ACTION_FIELDS>> = Object.freeze({
  loop: "add",
  "loop-close": "close",
  loops: "list",
  "loop-get": "get",
  "loop-edit": "edit",
  "loop-delete": "delete",
});

export const LOOP_COMMANDS: readonly CommandSpec[] = Object.freeze([
  ...Object.entries(ACTION_FIELDS).map(([verb, spec]) => ({
    noun: "loop",
    verb,
    operation: spec.operation,
    summary: spec.summary,
    buildInput: buildLoopInput(verb),
  })),
  ...Object.entries(OLD_SPELLINGS).map(([verb, action]) => ({
    noun: "item",
    verb,
    operation: ACTION_FIELDS[action]!.operation,
    summary: `Same as \`standup loop ${action}\`. ${ACTION_FIELDS[action]!.summary}`,
    buildInput: buildLoopInput(action),
  })),
]);
