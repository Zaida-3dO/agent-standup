// Refusing a field that belongs to a different action of the same fold.
//
// ── The hole this closes ────────────────────────────────────────────────
//
// A folded tool declares ONE `.strict()` object shared by every action it
// answers. `.strict()` is what makes an unrecognised key a refusal rather
// than a silent drop — and a fold defeats it, precisely where a caller has
// most reason to trust it:
//
//   - `findings` is a real field on the `record` tool, so `.strict()`
//     accepts it on EVERY action, including `note`.
//   - The `note` branch does not forward `findings`, because `note`'s own
//     schema has no such field.
//   - So the delegate's `.strict()` parse never sees it either. Nothing
//     refuses it at any layer, and the call returns success.
//
// Measured on this build before the guard: a `record {action: "note"}`
// carrying `findings: [{severity: "critical"}]`, `verdict: "lgtm"` and
// `followUpItemId` returned success and stored `payload: {}`. **A reviewer
// attaching findings to a note lost every one of them, silently.** That is
// the same class as `fa83f2b9` — parsed, validated, discarded, reported as
// success — one layer further out.
//
// `ownership.ts` named this hazard in a comment and guarded five of its
// nineteen fields with a hand-written table. This module is that idea,
// derived rather than hand-written, so the other folds get it without
// anybody maintaining six more tables.
//
// ── Why the legitimate set is DERIVED, not declared ─────────────────────
//
// "Which fields may this action carry" has an answer already written down
// and kept true by something else entirely: **the fields this action's
// delegate declares.** That set cannot drift from the forwarding, because
// the forwarding is parsed against exactly that schema one line later — a
// field the delegate does not declare is refused by `parseDelegateInput`
// whether or not this module exists.
//
// A hand-written table has the opposite property. It is a second statement
// of the same fact, maintained by a different edit, and the drift is
// invisible in both directions: a field added to the tool and forgotten
// here is silently dropped again, and a field removed from a delegate and
// forgotten here is refused for a reason the schema does not carry. That is the
// literal-versus-builder failure `tests/fold-forwarding-names.test.ts`
// documents at length, and re-creating it six times is not a fix.
//
// So a fold states only the two things that are genuinely its own:
//   1. Which delegate schema each action forwards to.
//   2. Which fields it deliberately renames on the way, and to what.
//
// Both are already true of the fold's switch statement, and both are
// checked against it by observation in `tests/fold-forwarding-names.test.ts`
// rather than trusted.
import type { z } from "zod";

import { InvalidInputError } from "./errors";

/**
 * One action's forwarding, as the fold performs it.
 *
 * `schema` is the delegate's own input schema — the object that decides
 * what the action may carry. `renames` maps a field's name ON THE FOLD to
 * the name it arrives under, and exists because a rename is the one case
 * where the fold's spelling and the delegate's legitimately differ:
 * `read_item` takes `itemId` and hands its delegates `id`; `score` takes
 * `facets` and forwards `scores`.
 *
 * `answeredInTool` marks an action the fold answers with its own query
 * rather than by forwarding. Those have no delegate schema to derive from,
 * so they state their own field list — `get_item`'s shallower depths are
 * the only instance, and it is a real property of the depth fold rather
 * than something left undone.
 */
export interface ActionForwarding {
  /** The delegate's input schema, or `undefined` when answered in-tool. */
  readonly schema?: z.ZodTypeAny;
  /** Fields renamed on the way out: fold's name -> delegate's name. */
  readonly renames?: Readonly<Record<string, string>>;
  /** For an in-tool action, the fields it legitimately reads. */
  readonly answeredInTool?: readonly string[];
}

/** Every action of one fold, by the name the caller passes. */
export type FoldForwarding<Action extends string> = Readonly<Record<Action, ActionForwarding>>;

/**
 * The field names a Zod object declares, through whatever wraps it.
 *
 * A delegate's schema is usually a bare `.strict()` object, but some carry
 * a `.superRefine` or a `.transform` — and the shape lives underneath. This
 * walks down to it rather than assuming depth, and returns an empty set
 * when there is no object at the bottom, which makes the guard refuse
 * nothing rather than refuse everything. **That direction is deliberate:**
 * a guard that cannot read a schema must fall back to permitting the call,
 * not to rejecting every call to that action.
 */
function declaredFields(schema: z.ZodTypeAny): ReadonlySet<string> {
  let current: unknown = schema;
  for (let depth = 0; depth < 20 && current; depth += 1) {
    const node = current as {
      shape?: Record<string, unknown> | (() => Record<string, unknown>);
      _def?: { schema?: unknown; innerType?: unknown };
    };
    const shape = typeof node.shape === "function" ? node.shape() : node.shape;
    if (shape) return new Set(Object.keys(shape));
    current = node._def?.schema ?? node._def?.innerType ?? null;
  }
  return new Set();
}

/**
 * Which actions of this fold accept a given field.
 *
 * Used to build the remedy half of the refusal. A caller told only that
 * `findings` is not accepted on `note` still has to go and find out where
 * it IS accepted; a caller told "it belongs to action `artifact`" can fix
 * the call from the message alone. That is the difference between a
 * refusal and a useful refusal, and it is why this is computed rather than
 * the message being a bare rejection.
 */
function actionsAccepting<Action extends string>(
  forwarding: FoldForwarding<Action>,
  field: string,
): readonly string[] {
  return (Object.keys(forwarding) as Action[]).filter((action) =>
    legitimateFields(forwarding, action).has(field),
  );
}

/**
 * The fields one action of a fold may legitimately carry.
 *
 * Derived from the delegate's declared fields, mapped back through the
 * renames so the answer is in the caller's vocabulary rather than the
 * delegate's — a caller passing `itemId` to `read_item` must not be told
 * their field is unknown because the delegate spells it `id`.
 */
function legitimateFields<Action extends string>(
  forwarding: FoldForwarding<Action>,
  action: Action,
): ReadonlySet<string> {
  const spec = forwarding[action];
  if (!spec) return new Set();
  if (spec.answeredInTool) return new Set(spec.answeredInTool);
  if (!spec.schema) return new Set();

  const declared = declaredFields(spec.schema);
  const renames = spec.renames ?? {};
  const accepted = new Set<string>();

  // A field the delegate declares is legitimate under its own name, unless
  // the fold renames something ELSE onto it — the delegate's spelling is
  // not part of the caller's vocabulary in that case.
  const renamedTo = new Set(Object.values(renames));
  for (const field of declared) {
    if (!renamedTo.has(field)) accepted.add(field);
  }
  // And a field the fold renames is legitimate under the FOLD's name,
  // provided the delegate really does declare what it is renamed to. A
  // rename pointing at a field the delegate does not have is a defect in
  // the fold rather than a licence, so it grants nothing here — and
  // `parseDelegateInput` refuses that call anyway, naming the delegate.
  for (const [fromName, toName] of Object.entries(renames)) {
    if (declared.has(toName)) accepted.add(fromName);
  }
  return accepted;
}

/**
 * Refuses a field that belongs to a different action than the one asked for.
 *
 * Called at the top of a fold's handler, before the required-field check,
 * so a call carrying a foreign field is told about the foreign field rather
 * than about whatever the foreign field was mistaken for.
 *
 * **Absent means absent.** A field explicitly set to `undefined` is not a
 * field a caller supplied — JSON has no such value and every adapter drops
 * it — so testing for `!== undefined` rather than for key presence is what
 * makes the guard agree with what was actually sent. `null` IS a value a
 * caller can send and several of these fields accept it, so it is refused
 * on a foreign action exactly as any other value would be.
 *
 * @param tool the fold's name, for the message
 * @param action the action asked for
 * @param input the fold's own parsed input
 * @param forwarding which delegate each action reaches, and its renames
 */
export function rejectForeignFields<Action extends string>(
  tool: string,
  action: Action,
  input: Readonly<Record<string, unknown>>,
  forwarding: FoldForwarding<Action>,
  discriminator = "action",
): void {
  const accepted = legitimateFields(forwarding, action);
  const foreign = Object.keys(input).filter(
    (field) => field !== discriminator && input[field] !== undefined && !accepted.has(field),
  );
  if (foreign.length === 0) return;

  // Sorted so the sentence is stable regardless of the order the adapter
  // happened to serialise the object in. A refusal whose wording depends on
  // key order is one a test has to sort before comparing, and one a caller
  // seeing it twice reads as two different refusals.
  foreign.sort();

  const detail = foreign
    .map((field) => {
      const owners = actionsAccepting(forwarding, field);
      if (owners.length === 0) return `\`${field}\` (accepted by no action of this tool)`;
      const list = owners.map((owner) => `"${owner}"`).join(", ");
      return `\`${field}\` (belongs to ${owners.length === 1 ? "action" : "actions"} ${list})`;
    })
    .join(", ");

  throw new InvalidInputError(
    `${tool} ${discriminator} "${action}" does not accept ${detail}. ` +
      `A field this tool declares for another ${discriminator} is accepted by the shared schema ` +
      `and then forwarded nowhere, so it would have been silently discarded rather than applied. ` +
      `Remove ${foreign.length === 1 ? "it" : "them"}, or use the ${discriminator} that takes ` +
      `${foreign.length === 1 ? "it" : "them"}.`,
    { fields: foreign },
  );
}
