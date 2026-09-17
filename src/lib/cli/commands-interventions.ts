// The `intervention` command-line noun — reading and re-levelling the
// catalogue (MILESTONES.md #128).
//
// A separate module from `commands.ts` for the reason that file's header
// gives: entries are added as one appended import and one appended spread,
// so concurrent rows do not conflict over the same lines.
//
// ── Why not verbs on the existing `config` noun ────────────────────────
//
// `standup config set` is the obvious-looking home, and it is the wrong one
// for the same reason `put_setting` cannot serve these keys. That noun is
// built around `SETTINGS_REGISTRY`: its `set` verb reads
// `getDefinition(key)` to decide whether a confirmation flag is required,
// and its `describe` verb renders the registry's label and help. An
// intervention has none of those — it is not in that registry, deliberately
// — so every verb would need a branch for a key shape the noun is not about,
// and the confirmation gate would silently not apply to a level that can
// block a tool call.
//
// The catalogue is its own vocabulary with its own identity — an id rather
// than a dotted key, a phase that constrains the values, and a level rather
// than an arbitrary JSON value — so it gets its own noun. That is the same
// call `score` made, and made for the same reason: a grammar that says the
// true thing is worth more than one that reuses an existing word.
//
// ── `clear` is a distinct verb because it is a distinct act ────────────
//
// Not `set <id> inherit`. `src/lib/interventions/settings.ts`'s rule 1 is
// that an entry which has never been overridden *tracks the product*, and
// returning one to that state deletes its row rather than storing a value.
// A surface that spelled it as a level would put "delete the row" and "store
// this value" behind one verb, and the difference between them is invisible
// until a release retunes the shipped default months later.
import { malformed, type ErrorEnvelope } from "./envelope";
import type { CommandSpec, InputResult } from "./commands";

/** Reads the leading positional a verb requires, naming it when it is absent. */
function requiredId(rest: readonly string[], usage: string): InputResult | { readonly id: string } {
  const id = rest[0];
  if (id === undefined) {
    return { ok: false, envelope: malformed(usage, ["id"]) as ErrorEnvelope };
  }
  return { id };
}

function buildSetInput(rest: readonly string[]): InputResult {
  const found = requiredId(
    rest,
    "`standup intervention set` needs an intervention id and a level, e.g. " +
      "`standup intervention set broad-process-kill nudge`.",
  );
  if ("ok" in found) return found;

  const level = rest[1];
  if (level === undefined) {
    return {
      ok: false,
      envelope: malformed(
        "`standup intervention set` needs a level — one of nothing, nudge, block-overridable, " +
          "hard-block. Use `standup intervention clear` to go back to the shipped default.",
        ["level"],
      ),
    };
  }
  // Deliberately passed through unvalidated. The level's legality is not a
  // property of the string — a `post` entry cannot take a blocking one — so
  // it can only be decided against the catalogue, which the operation does.
  // Checking the spelling here as well would be a second, weaker copy of a
  // rule whose real enforcement is one call away, and the two would disagree
  // the moment the ladder changed.
  return { ok: true, input: { id: found.id, level } };
}

function buildClearInput(rest: readonly string[]): InputResult {
  const found = requiredId(
    rest,
    "`standup intervention clear` needs an intervention id, e.g. " +
      "`standup intervention clear broad-process-kill`.",
  );
  if ("ok" in found) return found;
  return { ok: true, input: { id: found.id } };
}

export const INTERVENTION_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "intervention",
    verb: "list",
    operation: "list_intervention_settings",
    summary:
      "List every intervention this build ships: the level it runs at, and whether that level is inherited or set here.",
    buildInput: (): InputResult => ({ ok: true, input: {} }),
  },
  {
    noun: "intervention",
    verb: "set",
    operation: "set_intervention_level",
    summary:
      "Set one intervention's level for this installation. The choice sticks across upgrades.",
    buildInput: (rest: readonly string[]) => buildSetInput(rest),
  },
  {
    noun: "intervention",
    verb: "clear",
    operation: "clear_intervention_level",
    summary: "Clear one intervention's level so it tracks the level this build ships again.",
    buildInput: (rest: readonly string[]) => buildClearInput(rest),
  },
]);
