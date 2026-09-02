// `loop` — the six loop verbs behind one tool, chosen with `action`.
//
// ── Why this is folded, and why only on MCP ─────────────────────────────
//
// An MCP tool list is sent to the model **on every session**, so every
// registered tool spends context whether or not it is ever called — the
// same cost `waivers.ts` reasons about for `backfill`. Six loop verbs spend
// that budget six times to describe one capability: `loop_add`, `loop_get`,
// `loop_list`, `loop_edit`, `loop_close` and `loop_delete` share an
// `itemId`, share a `loopId`, and differ in a handful of fields. A caller
// reaching for any of them has already decided it is working on loops; what
// it has not yet said is which verb, and that is one enum field rather than
// six tool descriptions.
//
// The six operations are **not removed**. They stay registered, stay
// reachable over HTTP and the command line, and keep their own tests; this
// operation is waived nowhere and they are waived off the two MCP adapters
// only (`waivers.ts`). Nothing that calls `POST /api/…` or `standup loop …`
// changes.
//
// ── No second implementation ────────────────────────────────────────────
//
// Every action below dispatches to the operation that already implements
// it, through the same `ctx` it was handed. That is deliberate and it is the
// property that makes this fold safe to review: there is no copy of the
// close rule, no copy of the deletion-reason steering, no copy of the
// short-id resolution, and therefore nothing that can drift from the six
// operations whose behaviour this promises to reproduce. A refusal a caller
// gets here is the *same object* the unfolded operation would have thrown,
// so its `code`, its `guard` id and its `fields` are identical on both
// surfaces — which is what §22's cross-adapter comparison needs.
//
// ── The one thing that is NOT uniform, and must not become uniform ──────
//
// **`kind` means different things by its absence in `add` and in `edit`.**
//
//   - `loop_add` **defaults** it to `work`. A loop opened without saying
//     what it tracks is work outstanding, which is the useful default and
//     the one the count depends on.
//   - `loop_edit` **deliberately does not**. Omitting `kind` on an edit
//     means *leave the classification alone* — JSON cannot distinguish "not
//     supplied" from "cleared", so only a kind actually sent changes
//     anything (`loop-lifecycle.ts`, and `deriveLoops` reads the payload key
//     the same way).
//
// A single optional `kind` on this schema with one default would collapse
// that distinction, and it would collapse it in the silent direction: every
// reword of a `note` loop that did not restate `kind` would retype it to
// `work` and inflate the outstanding-work count nobody was told had changed.
// So `kind` is declared **optional with no default here**, and the default
// is applied *only* on the `add` path, by the operation that owns it —
// `loopAdd`'s own schema still carries `.default(DEFAULT_LOOP_KIND)` and
// still applies it, because an absent `kind` is forwarded to it as absent.
// `tests/tool-folds.test.ts` asserts both halves directly.
//
// ── The hazard a fold creates: a field accepted by one action, sent to ──
// ── another, and dropped on the floor ──────────────────────────────────
//
// Row fa83f2b9-3ce6-4e89-a930-aaf949720f8e. Because six verbs share one
// schema, that schema is the **union** of their fields — so every action
// accepts every field, and only the branch below decides which ones travel.
// A field a branch forgets to forward is not refused: it is parsed,
// validated, and silently discarded, and the caller is told the call
// succeeded.
//
// That is exactly what happened to `reason` on `close`. It was on the schema
// for `delete`, so a caller closing a loop with an explanation got a success
// and no explanation stored — and `delete` keeping its reason made the
// asymmetry invisible, because the obvious inference from one sibling
// working is that the other does too. A crew writing a retraction as a
// closure reason nearly shipped an explanation nobody could ever read.
//
// **So the rule for this switch is: a field this schema accepts must either
// be forwarded by the branch, or be inert by a stated design.** The inert
// ones are the `list` filters and they are documented as such on the schema.
// Anything else that arrives and goes nowhere is the defect above, and it is
// the kind that reports success. `tests/tool-folds.test.ts` pins the close
// reason end to end — written, read back, and surviving the fold.
import { z } from "zod";
import { InvalidInputError } from "../errors";
import { parseDelegateInput } from "../shape-refusal";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { LOOP_KINDS } from "@/lib/open-loops";
import { loopAdd, loopClose } from "./open-loops";
import { loopGet, loopList } from "./loop-reads";
import { loopDelete, loopEdit } from "./loop-lifecycle";

const ACTOR_TYPES = ["person", "agent", "system"] as const;

/** The verbs this tool folds, in the order a loop's life runs. */
export const LOOP_ACTIONS = ["add", "get", "list", "edit", "close", "delete"] as const;

export type LoopAction = (typeof LOOP_ACTIONS)[number];

/**
 * Which fields each action needs beyond `itemId`.
 *
 * Data rather than a chain of `if`s because it is also what the refusal
 * message is built from — a required field and the sentence naming it
 * cannot disagree when there is one list. `optional` is not enforced; it is
 * here so the refusal can tell a caller which extra fields the action
 * accepts, which is the half of "what do I pass" that a bare
 * missing-field error leaves out.
 */
const ACTION_FIELDS: Readonly<Record<LoopAction, { required: readonly string[] }>> = Object.freeze({
  add: { required: ["text"] },
  get: { required: ["loopId"] },
  list: { required: [] },
  edit: { required: ["loopId", "text"] },
  close: { required: ["loopId"] },
  delete: { required: ["loopId", "reason"] },
});

const inputSchema = z
  .object({
    /** Which verb. The one field that decides what the rest of the call means. */
    action: z.enum(LOOP_ACTIONS),
    itemId: z.string().min(1),
    /** The loop to act on. Required by every action but `add` and `list`. */
    loopId: z.string().trim().min(1).optional(),
    /** The loose end, for `add` and `edit`. */
    text: z.string().trim().min(1).optional(),
    /**
     * What the loop tracks.
     *
     * **No `.default()` here, on purpose.** `add` defaults it to `work`
     * inside `loop_add`; `edit` treats an absent kind as "leave it alone".
     * Defaulting here would apply `add`'s rule to `edit` and silently retype
     * every `note` loop that was reworded without restating its kind. See
     * this module's header.
     */
    kind: z.enum(LOOP_KINDS).optional(),
    /**
     * Why the loop is being retired.
     *
     * Used by **both** terminal actions, and it means a different thing in
     * each: on `delete` it is why the loop should never have existed and is
     * required; on `close` it is how the loose end was resolved and is
     * optional. Either way it is kept — a closed loop reports it as
     * `closedReason`, a deleted one as `deletedReason`.
     *
     * Every other action ignores it. See this module's header for why that
     * is stated rather than enforced.
     */
    reason: z.string().trim().min(1).optional(),
    /** `list` filters, ignored by every other action. */
    includeClosed: z.boolean().optional(),
    includeDeleted: z.boolean().optional(),
    includeNonWork: z.boolean().optional(),
    limit: z.coerce.number().int().optional(),
    cursor: z.string().min(1).optional(),
    actorType: z.enum(ACTOR_TYPES).optional(),
    actorId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type LoopInput = z.infer<typeof inputSchema>;

/**
 * Refuses an action that is missing a field it cannot run without.
 *
 * Named after the field and the action, and it says what to pass — the bar
 * the summary guards set ("shipped[0] is 125 characters, over the
 * 120-character cap. Shorten it and resubmit"). A caller that reads this
 * knows which call to make next without opening a schema.
 */
function requireFields(input: LoopInput): void {
  const missing = ACTION_FIELDS[input.action].required.filter(
    (field) => input[field as keyof LoopInput] === undefined,
  );
  if (missing.length === 0) return;
  const list = missing.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `loop action "${input.action}" requires ${list}, which ${missing.length === 1 ? "was" : "were"} not supplied. ` +
      `Resend the call with ${list} set.`,
    { fields: missing },
  );
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const loop = defineOperation({
  name: "loop",
  kind: "write",
  summary:
    "Works with the loose ends on an item — say which with action. add records one (kind defaults to work; pass note for a reference that is not work outstanding, or blocked_on_person for something waiting on a human). list and get read them. edit rewords one — omitting kind there LEAVES THE KIND ALONE rather than resetting it to work. close resolves a real loose end and takes an optional reason saying how; delete retracts one that should never have existed and requires a reason. Both reasons are kept and reported back.",
  contract: {
    rules: [
      {
        fields: ["action"],
        rule: "add requires text; get, close require loopId; edit requires loopId and text; delete requires loopId and reason; list requires neither. A missing field is refused by name.",
      },
      {
        fields: ["kind"],
        rule: 'On action "add", omitting `kind` records the loop as `work`. On action "edit", omitting `kind` PRESERVES the loop\'s current kind rather than resetting it — reclassify by sending `kind` explicitly.',
      },
      {
        fields: ["reason"],
        rule: "delete needs a reason of at least 20 characters that does not describe a resolution — a loose end that was real and has been dealt with is closed with action close, not deleted. close accepts one too, optionally, saying how it was resolved. Both are kept: a closed loop reports `closedReason` and a deleted one `deletedReason`. Every other action ignores `reason`.",
      },
    ],
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: LoopInput): Promise<unknown> {
    requireFields(input);

    // Each branch forwards only the fields its operation's `.strict()`
    // schema accepts. Spread-everything would be shorter and would fail:
    // every one of the six refuses an unrecognised key, so a `reason` left
    // over from a delete would make the next add invalid.
    //
    // `kind` is forwarded **as it arrived** — present when the caller sent
    // one, absent when it did not. That is what lets `loop_add` apply its
    // own default and `loop_edit` apply its own preserve-on-absent rule,
    // with neither behaviour restated here.
    const actor = {
      ...(input.actorType === undefined ? {} : { actorType: input.actorType }),
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    };

    switch (input.action) {
      case "add":
        return loopAdd.handler(
          ctx,
          parseDelegateInput(
            loopAdd.name,
            loopAdd.input,
            {
              itemId: input.itemId,
              text: input.text,
              ...(input.loopId === undefined ? {} : { loopId: input.loopId }),
              ...(input.kind === undefined ? {} : { kind: input.kind }),
              ...actor,
            },
            ctx.caller.transport,
          ),
        );
      case "get":
        return loopGet.handler(
          ctx,
          parseDelegateInput(
            loopGet.name,
            loopGet.input,
            {
              itemId: input.itemId,
              loopId: input.loopId,
            },
            ctx.caller.transport,
          ),
        );
      case "list":
        return loopList.handler(
          ctx,
          parseDelegateInput(
            loopList.name,
            loopList.input,
            {
              itemId: input.itemId,
              ...(input.includeClosed === undefined ? {} : { includeClosed: input.includeClosed }),
              ...(input.includeDeleted === undefined
                ? {}
                : { includeDeleted: input.includeDeleted }),
              ...(input.includeNonWork === undefined
                ? {}
                : { includeNonWork: input.includeNonWork }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            },
            ctx.caller.transport,
          ),
        );
      case "edit":
        return loopEdit.handler(
          ctx,
          parseDelegateInput(
            loopEdit.name,
            loopEdit.input,
            {
              itemId: input.itemId,
              loopId: input.loopId,
              text: input.text,
              // Absent stays absent. This is the trap the header describes.
              ...(input.kind === undefined ? {} : { kind: input.kind }),
              ...actor,
            },
            ctx.caller.transport,
          ),
        );
      case "close":
        return loopClose.handler(
          ctx,
          parseDelegateInput(
            loopClose.name,
            loopClose.input,
            {
              itemId: input.itemId,
              loopId: input.loopId,
              // Row fa83f2b9-3ce6-4e89-a930-aaf949720f8e: this was the one
              // field the fold accepted and then dropped. `reason` is on the
              // shared schema for `delete`, so a close that supplied one was
              // parsed, forwarded nowhere, and answered with a success.
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              ...actor,
            },
            ctx.caller.transport,
          ),
        );
      case "delete":
        return loopDelete.handler(
          ctx,
          parseDelegateInput(
            loopDelete.name,
            loopDelete.input,
            {
              itemId: input.itemId,
              loopId: input.loopId,
              reason: input.reason,
              ...actor,
            },
            ctx.caller.transport,
          ),
        );
    }
  },
});
