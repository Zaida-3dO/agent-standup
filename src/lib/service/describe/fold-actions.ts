// The actions each folded tool accepts, and the fields each action requires.
//
// ── Why this exists ─────────────────────────────────────────────────────
//
// A folded tool takes its verb as an `action` field, so "what does this tool
// require?" has no single answer — `loop` needs `text` for `add` and
// `loopId` for `close`, and a caller told "loopId is optional" because the
// SCHEMA says so has been told something true and useless.
//
// `describe_tool` answers per action by reading the SAME table each fold
// refuses from. That is the whole point: a fold's `ACTION_FIELDS` is what
// builds its refusal sentence, so what the tool advertises as required and
// what it actually refuses cannot disagree. Retyping the lists here would
// create exactly the second copy that drifts — and the drift would be
// invisible, because both halves would look correct in isolation.
//
// **Read, never restated**, the same rule `bindings.ts` follows for the
// command table and the waivers.
//
// ── `delegateSchema`, and why it is read rather than named ───────────────
//
// A folded action forwards to a real, independently-registered operation —
// `record`'s `action: "artifact"` forwards to `record_artifact`, exactly the
// operation a direct MCP caller cannot reach because it is `onMcp: false`
// (`describe/reachability.ts`). That operation's OWN `contract.rules` is
// where a conditional rule actually lives — `record_artifact` declares nine
// of them — and until this field existed, `describe_tool` had no way to
// find that operation from `(tool, action)` alone, so a fold's answer was
// only ever the fold's own three or four rules. A caller who reached
// `record` with `action: "artifact"` never saw a single rule the delegate
// declares, including ones discovered by being refused.
//
// **Not a second table naming which operation each action forwards to.**
// Each fold already states that, once, as the `schema` half of its own
// `FORWARDING` (`foreign-fields.ts`) — the same object `parseDelegateInput`
// parses against a call with. Reading `FORWARDING[action].schema` here and
// letting `describe-tool.ts` resolve WHICH operation owns that schema by
// identity against the registry it already holds means this file states
// nothing that was not already true elsewhere. A fold that renames or
// re-points an action's delegate changes one line, in one place, and both
// the parse and the documentation move with it.
//
// `undefined` is included and means what it says: `get_item`'s shallow
// depths and `create_work`'s kinds answer without forwarding to a distinct
// operation at all (`ActionForwarding.answeredInTool`), so there is no
// second contract to merge in — that is a fact about the fold, not a gap in
// this table.
import { LOOP_ACTIONS, FORWARDING as LOOP_FORWARDING } from "../operations/loop";
import {
  SCORE_ACTIONS,
  SCORE_ACTION_FIELDS,
  FORWARDING as SCORE_FORWARDING,
} from "../operations/score";
import {
  PROJECT_ACTIONS,
  PROJECT_ACTION_FIELDS,
  FORWARDING as PROJECT_FORWARDING,
} from "../operations/project";
import {
  SESSION_ACTIONS,
  SESSION_ACTION_FIELDS,
  FORWARDING as SESSION_FORWARDING,
} from "../operations/session";
import { CREATE_WORK_TYPES } from "../operations/create-work";
import { ITEM_DEPTHS } from "../operations/get-item";
import {
  READ_ITEM_ACTIONS,
  READ_ITEM_ACTION_FIELDS,
  FORWARDING as READ_ITEM_FORWARDING,
} from "../operations/read-item";
import {
  OWNERSHIP_ACTIONS,
  OWNERSHIP_ACTION_FIELDS,
  FORWARDING as OWNERSHIP_FORWARDING,
} from "../operations/ownership";
import {
  RECORD_ACTIONS,
  RECORD_ACTION_FIELDS,
  FORWARDING as RECORD_FORWARDING,
} from "../operations/record";
import type { ActionForwarding, FoldForwarding } from "../foreign-fields";
import type { z } from "zod";

/** One folded tool's verbs, and what each of them cannot run without. */
export interface FoldActions {
  /** Every action the tool accepts, in the order its own enum declares. */
  readonly actions: readonly string[];
  /** Fields required per action. An action absent from this map requires none. */
  readonly requiredByAction: Readonly<Record<string, readonly string[]>>;
  /**
   * The delegate operation's own input schema, per action — the same object
   * its `FORWARDING` table already forwards a call to. `describe-tool.ts`
   * resolves this to an operation NAME by identity against the registry it
   * holds, then merges that operation's `contract.rules` into the answer for
   * this action. Absent for an action answered in-tool (no distinct
   * delegate to merge) and for a fold that declares no `FORWARDING` at all.
   */
  readonly delegateSchema?: Readonly<Record<string, z.ZodTypeAny>>;
}

/**
 * `delegateSchema` for a fold, built from its own `FORWARDING` table.
 *
 * Drops an action whose forwarding names no `schema` (`answeredInTool`)
 * rather than recording `undefined` for it — the same "absent, not empty"
 * distinction `describe-tool.ts` already keeps for `rules` and `example`,
 * so "this action has no delegate to merge" cannot be misread as "the
 * lookup failed".
 */
function delegateSchemaFrom<Action extends string>(
  forwarding: FoldForwarding<Action>,
): Readonly<Record<string, z.ZodTypeAny>> {
  const entries = (Object.entries(forwarding) as [Action, ActionForwarding][])
    .filter(([, entry]) => entry.schema !== undefined)
    .map(([action, entry]) => [action, entry.schema as z.ZodTypeAny] as const);
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * `loop`'s required fields.
 *
 * Stated here rather than imported because `loop.ts` keeps its
 * `ACTION_FIELDS` module-private. The actions themselves ARE imported, so an
 * action added there and not here is visible: the `actions` list grows and
 * this map simply reports no requirement for the new verb, which is a
 * conservative wrong answer rather than a confident one. A test pins the two
 * against each other so the gap cannot widen unnoticed.
 */
const LOOP_REQUIRED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  add: ["text"],
  get: ["loopId"],
  list: [],
  edit: ["loopId", "text"],
  close: ["loopId"],
  delete: ["loopId", "reason"],
});

/**
 * Every folded tool, by the name a caller holds.
 *
 * `create_work` is included even though its discriminator is called `type`
 * rather than `action`: a caller asking what it needs has the same question,
 * and the answer is per-kind in exactly the same way. `get_item` is included
 * for the same reason under a third name, `full` — its verbs are depths, and
 * "what do I pass for the deepest read" is the same question again.
 */
export const FOLD_ACTIONS: ReadonlyMap<string, FoldActions> = new Map<string, FoldActions>([
  [
    "loop",
    {
      actions: [...LOOP_ACTIONS],
      requiredByAction: LOOP_REQUIRED,
      delegateSchema: delegateSchemaFrom(LOOP_FORWARDING),
    },
  ],
  [
    "score",
    {
      actions: [...SCORE_ACTIONS],
      requiredByAction: Object.fromEntries(
        Object.entries(SCORE_ACTION_FIELDS).map(([action, spec]) => [action, spec.required]),
      ),
      delegateSchema: delegateSchemaFrom(SCORE_FORWARDING),
    },
  ],
  [
    "project",
    {
      actions: [...PROJECT_ACTIONS],
      requiredByAction: Object.fromEntries(
        Object.entries(PROJECT_ACTION_FIELDS).map(([action, spec]) => [action, spec.required]),
      ),
      delegateSchema: delegateSchemaFrom(PROJECT_FORWARDING),
    },
  ],
  [
    "session",
    {
      actions: [...SESSION_ACTIONS],
      requiredByAction: Object.fromEntries(
        Object.entries(SESSION_ACTION_FIELDS).map(([action, spec]) => [action, spec.required]),
      ),
      delegateSchema: delegateSchemaFrom(SESSION_FORWARDING),
    },
  ],
  [
    "get_item",
    {
      // The depths, named. The boolean spellings `true` and `false` are
      // deliberately NOT listed: they are synonyms for two of these, and a
      // caller asking what verbs this tool has wants the vocabulary that
      // covers all three, not two ways of saying two of them.
      actions: [...ITEM_DEPTHS],
      // Every depth requires only `id`, which the schema states for the
      // tool as a whole — so there is nothing per-depth to report, and
      // reporting a requirement that is not per-action would be the
      // confident wrong answer this table exists to avoid. The two limits
      // are the reverse case: accepted only at `detail`, and refused by
      // name elsewhere, which is a contract rule rather than a requirement.
      requiredByAction: Object.freeze({ summary: [], item: [], detail: [] }),
      // No `delegateSchema`: every depth is answered in this operation
      // itself, not by forwarding to a distinct registered operation — there
      // is no second contract to merge in.
    },
  ],
  [
    "read_item",
    {
      actions: [...READ_ITEM_ACTIONS],
      requiredByAction: Object.fromEntries(
        Object.entries(READ_ITEM_ACTION_FIELDS).map(([action, spec]) => [action, spec.required]),
      ),
      delegateSchema: delegateSchemaFrom(READ_ITEM_FORWARDING),
    },
  ],
  [
    "ownership",
    {
      actions: [...OWNERSHIP_ACTIONS],
      requiredByAction: Object.fromEntries(
        Object.entries(OWNERSHIP_ACTION_FIELDS).map(([action, spec]) => [action, spec.required]),
      ),
      delegateSchema: delegateSchemaFrom(OWNERSHIP_FORWARDING),
    },
  ],
  [
    "record",
    {
      actions: [...RECORD_ACTIONS],
      requiredByAction: Object.fromEntries(
        Object.entries(RECORD_ACTION_FIELDS).map(([action, spec]) => [action, spec.required]),
      ),
      delegateSchema: delegateSchemaFrom(RECORD_FORWARDING),
    },
  ],
  [
    "create_work",
    {
      actions: [...CREATE_WORK_TYPES],
      // The kind decides which parent pointer is required, which is the
      // whole argument for that fold: the caller states the kind and the
      // server refuses the combination that does not make sense, rather
      // than inferring a kind from which pointer arrived.
      requiredByAction: Object.freeze({
        project: [],
        task: ["projectId"],
        subtask: ["taskId"],
      }),
    },
  ],
]);

/**
 * The field a folded tool names its verb, for the refusal to quote
 * correctly.
 *
 * Three names rather than one, because the tools were not built to a
 * template: `create_work` takes a `type` because the thing being made has a
 * kind, and `get_item` takes a `full` because the flag already meant depth
 * and keeping its name is what lets every existing `full: true` go on
 * meaning what it meant. Quoting the wrong one would send a caller looking
 * for a field their tool does not have, which is worse than not naming it.
 */
export function discriminatorFor(tool: string): "action" | "type" | "full" {
  if (tool === "create_work") return "type";
  if (tool === "get_item") return "full";
  return "action";
}
