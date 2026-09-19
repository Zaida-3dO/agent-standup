// Row #82's own commands: ownership (claim, release, heartbeat, checkpoint,
// my-work), item-scoped reads (note, orientation) and crew naming (SCHEMA.md
// §20). A separate module from `commands.ts` on purpose — several rows
// (#80, #81, #83, #89, #92) add their own commands to the same table
// concurrently on their own branches, and `commands.ts`'s own header already
// states the shape every row after #79 follows: "they add entries here...
// without touching either binding." This file is the "entries" for this
// row; `commands.ts` gets a single appended import and a single appended
// spread, never a rewrite of its existing lines.
//
// **Noun choice.** SCHEMA.md §20 lists nine nouns, and after `item`
// (owned by #79/#81) and `config`/`repo`/`area`/`machine`/`account`/`person`
// (owned by #83/#92), only `session` and `crew` are left unclaimed —
// exactly the two this row needs. The split between them, and between
// `session` and `item` for `note`, follows each operation's own schema:
// `claim`, `release`, `heartbeat`, `checkpoint` and `my_work` all require
// `sessionId` (SCHEMA.md #29's operations, `my-work.ts`), so they are
// `session <verb>`. `note` and `orientation` do not require a session at
// all — `note`'s `sessionId` is optional (a person's remark needs none) and
// `orientation`'s input has no session field whatsoever — so they are
// `item <verb>`, alongside the item verbs #79/#81 already register there.
// `crew name` follows `standup crew wait`'s own precedent (SCHEMA.md §20,
// MILESTONES.md #64) for the one noun left.
//
// **Flags pass straight through to the operation's schema**, the same
// convention `item create` already established in `commands.ts`
// (`flagsToInput`): a flag becomes an input field of the identical name, and
// an unrecognised or mistyped one is refused by the operation's own
// `.strict()` schema with `invalid_input`, not silently dropped here. That
// import is not reachable from this file (`flagsToInput` is module-private
// to `commands.ts`, deliberately not exported so this file cannot be forced
// to touch that file's internals) so `passThroughFlags` below is the same
// behaviour, defined once for every command in this file.
import { buildVerbInput, type VerbFields } from "./flags";
import type { CommandSpec, InputResult } from "./commands";

/**
 * What each verb reads from the words and flags after it.
 *
 * ⚠️ **POSITIONALS AND BARE SWITCHES ONLY.** Every value-carrying flag
 * reaches the operation untouched and is refused, if wrong, by that
 * operation's own `.strict()` schema. Listing value-flag names here would
 * turn this table into the allow-list that silently drops a field — see
 * `buildVerbInput`'s own header for why that defect cannot be caught by a
 * refusal-shaped test, and `tests/cli-merged-builder-fields.test.ts` for the
 * assertion that can.
 *
 * Eleven builders were written out separately and differ only in these few
 * facts. The differences that looked like per-verb logic are all here:
 *
 *   - `claim` reads `--pid`, the one numeric field its schema declares.
 *   - `takeover` reads `--force` and `sweep` reads `--dry-run` as bare
 *     switches sent only when written, because both are optional on their
 *     schemas and a call that never mentioned one should not be recorded as
 *     having declined it.
 *   - `progress` reads `--include-completed` as an ordinary switch, which is
 *     always sent.
 *   - `orientation` reads `--limit` as a number and takes NO session: its
 *     input schema has no session field at all, being item-scoped rather
 *     than session-scoped.
 *   - `note`'s session is optional where claim/release/heartbeat/checkpoint
 *     require one, but the mapping from `--session` is identical either way,
 *     so the difference lives in the schema rather than here.
 */
/**
 * The verb descriptors this module's commands are built from.
 *
 * ⚠️ **Declared with `satisfies`, never with a `Record<string, VerbFields>`
 * annotation.** The annotation widens `keyof typeof VERBS` to `string`,
 * which silently defeats the `build(verb: keyof typeof VERBS)` constraint
 * below, because every string satisfies it: `build("clajm")` compiles, and
 * `VERBS[verb]` is then `undefined` at run time, so the verb's builder
 * reads no positional and no switch — a field parsed, accepted and quietly
 * not applied. `satisfies` keeps the keys literal instead, so a mistyped
 * verb is a compile error naming every valid key, while each value is
 * still checked against `VerbFields`.
 *
 * `tests/cli-verb-keys.test.ts` pins that every key here is reachable from
 * a command, which is the half a type cannot state.
 */
/**
 * Maps the hyphenated command-line spelling onto the schema's camelCase.
 *
 * A **rename, not a filter**, exactly as `commands-scoring.ts`'s `HYPHENATED`
 * is: a flag with no entry here still passes through under its own name and
 * is refused by the operation's `.strict()` schema if it is wrong. Adding
 * `leaseKey` to the verb table instead would be the allow-list mistake this
 * module's header warns against.
 *
 * `--leaseKey` already reached the operation, because `passThroughFlags`
 * copies flag names verbatim. What did not work was `--lease-key` — the
 * spelling every other multi-word flag in the product uses — which arrived
 * under the key `lease-key` and was refused as unrecognised. A caller reading
 * that refusal concludes the command line cannot pass a key at all, which is
 * the one surface a lease key must be passable on if the legacy identity
 * fields are ever to be removed (`docs/plans/LEASE-KEY-LIFECYCLE.md` §3, §8).
 */
const HYPHENATED: Readonly<Record<string, string>> = Object.freeze({
  "lease-key": "leaseKey",
});

const VERBS = Object.freeze({
  claim: {
    itemId: "session claim <item-id>",
    numbers: { pid: "pid" },
    session: true,
    rename: HYPHENATED,
  },
  release: { itemId: "session release <item-id>", session: true },
  heartbeat: { itemId: "session heartbeat <item-id>", session: true },
  takeover: { itemId: "session takeover <item-id>", optionalSwitches: { force: "force" } },
  sweep: { optionalSwitches: { "dry-run": "dryRun" } },
  checkpoint: { itemId: "session checkpoint <item-id>", session: true },
  "my-work": { session: true },
  progress: { switches: { "include-completed": "includeCompleted" }, session: true },
  note: { itemId: "item note <item-id>", session: true },
  orientation: { itemId: "item orientation <item-id>", numbers: { limit: "limit" } },
  "crew-name": { session: true },
} satisfies Readonly<Record<string, VerbFields>>);

/** One verb's builder, by the key it is listed under above. */
function build(
  verb: keyof typeof VERBS,
): (
  rest: readonly string[],
  flags: Parameters<ReturnType<typeof buildVerbInput>>[1],
) => InputResult {
  return buildVerbInput(VERBS[verb]);
}

export const OWNERSHIP_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "session",
    verb: "claim",
    operation: "claim",
    summary: "Takes ownership of an item in a role. Atomic — two agents can't both win.",
    buildInput: build("claim"),
  },
  {
    noun: "session",
    verb: "release",
    operation: "release",
    summary: "Gives up ownership of an item.",
    buildInput: build("release"),
  },
  {
    noun: "session",
    verb: "heartbeat",
    operation: "heartbeat",
    summary: "Still alive. Unnecessary if your hook flushes tool calls; needed if you run no hook.",
    buildInput: build("heartbeat"),
  },
  {
    noun: "session",
    verb: "takeover",
    operation: "takeover",
    summary:
      "Takes an item from another session. Free if that session is dead; needs --force and --reason if it may be alive.",
    buildInput: build("takeover"),
  },
  {
    noun: "session",
    verb: "sweep",
    operation: "sweep",
    summary:
      "Runs the liveness sweep: ages quiet sessions, releases claims held by dead ones, escalates stuck items. --dry-run reports what it would do and writes nothing.",
    buildInput: build("sweep"),
  },
  {
    noun: "session",
    verb: "checkpoint",
    operation: "checkpoint",
    summary:
      "Records what you tried, what you ruled out, what's next. --headline gives it a one-line BLUF that reads pick up without the prose.",
    buildInput: build("checkpoint"),
  },
  {
    noun: "session",
    verb: "my-work",
    operation: "my_work",
    summary: "What this session holds right now, and in what role.",
    buildInput: build("my-work"),
  },
  {
    noun: "session",
    verb: "progress",
    operation: "progress_report",
    summary:
      "A progress report on everything this session holds, in one fixed shape every time it is asked. Finished work is counted but not listed; --include-completed lists it.",
    buildInput: build("progress"),
  },
  {
    noun: "item",
    verb: "note",
    operation: "note",
    summary: "Leaves a timestamped remark on an item.",
    buildInput: build("note"),
  },
  {
    noun: "item",
    verb: "orientation",
    operation: "orientation",
    summary:
      "Catch me up: latest checkpoint, current state, what changed since, open loops, and crew.",
    buildInput: build("orientation"),
  },
  {
    noun: "crew",
    verb: "name",
    operation: "get_crew_name",
    summary: "Requests a name for a new agent. Hands out one available name, atomically.",
    buildInput: build("crew-name"),
  },
]);

/**
 * `claim` as a bare word — PLAN.md's own daily-use example: "use daily:
 * `standup ls`, `standup claim T-…`, `standup complete`." `ls` is already
 * aliased in `commands.ts`; `complete` is row #81's territory.
 *
 * `sweep` is aliased for a different reason than `claim` is, and the reason is
 * worth stating: it is not a command a person types daily, it is the command a
 * **scheduler** invokes. Whatever runs it — a cron entry, a scheduled task, a
 * container's periodic job — the invocation is written once into a
 * configuration file and then read by people debugging it much later, so the
 * short form is the one that stays legible out of context. `standup sweep`
 * says what it does; `standup session sweep` reads as though it sweeps one
 * session, which is the opposite of what it does (it sweeps all of them).
 *
 * `takeover` is deliberately **not** aliased. Every other alias here shortens
 * something safe and frequent; takeover is neither, and a one-word form is
 * exactly what makes a dangerous command easy to fire absent-mindedly.
 * Requiring `session takeover` costs a word and makes the noun — whose
 * session — impossible to miss.
 */
export const OWNERSHIP_ALIASES: Readonly<Record<string, readonly [string, string]>> = Object.freeze(
  {
    claim: ["session", "claim"],
    sweep: ["session", "sweep"],
  },
);
