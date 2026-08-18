// `hook_decision` — MILESTONES.md #125, SCHEMA.md §19 `POST /hook`.
//
// **The server side of a hook that carries no logic.** The script reports an
// event and renders whatever comes back (`src/lib/hook/decide.ts`); this
// operation is the only party that decides anything, which is the whole
// point of the arrangement: every rule anyone actually wants is conditional
// on state — item state, claim state, review artifacts, budget — and that
// state is here and can never be in a script.
//
// ── What it answers ────────────────────────────────────────────────────
//
// **It consults the intervention registry** (#128, `src/lib/interventions/`,
// `docs/plans/INTERVENTIONS.md`). The pattern lists this operation used to
// match against are deleted (#125) because matching command strings could
// not express a single one of the real rules, all of which are of the form
// *never do X **without** Y* — and the Y lives in item state, claim state
// and review artifacts, which are here and can never be in a script.
//
// The registry returns findings; this maps them onto the wire:
//
//   - a blocking finding on a `pre` event → `block`, carrying the reason;
//   - anything else → `allow`, carrying a nudge's message when there is one.
//
// ── `post` can never block, enforced in four places now ────────────────
//
// The hook enforces it (`canBlock` in `src/lib/hook/decide.ts`) and so does
// this operation, and the registry enforces it twice more — clamping a
// blocking *override* and a blocking *predicate verdict* down to a nudge.
// Four checks for one invariant is deliberate and is not the "two
// implementations that can disagree" DECISIONS.md §4 warns about: none of
// them can produce a block on a `post` event, so breaking the rule takes
// all four being wrong at once. Here the enforcement is structural — the
// `post` branch returns before the registry's level is ever consulted.
//
// ── Fail-open, revisited as DECISIONS.md §16 requires ──────────────────
//
// §16 records that the hook fails open and says outright that "row #128
// must revisit it for `pre` once real blocking exists". It exists now, and
// **the posture is deliberately unchanged.**
//
// The argument for that is not inertia. What fail-open protects against is
// a server hiccup killing *every tool call in every session*, and the
// asymmetry that made it right is untouched by this row: the rules now
// enforced are a handful of situations out of the whole traffic of a
// session, so an outage that denied everything would refuse thousands of
// calls that every one of these entries would have allowed — including the
// `Edit` that would unwire the hook. What has changed is only that some
// calls are now refused *when the server does answer*, which is exactly the
// case fail-open was never about.
//
// The residual risk is stated rather than hidden: during an outage an
// unreviewed merge would go through. That is accepted, because the guard it
// bypasses is not the only one — `transition_item` still refuses to move an
// item to `merged` without an approving review at tip, and that refusal
// happens in a transaction rather than in a hook that may not be installed.
//
// ── What it costs, which is the reason for the shape of `assembleContext` ──
//
// A decision made on every tool call is the highest-volume path in the
// system, and this operation stayed a dumb pipe touching no table for
// exactly that reason. It still touches no table for the overwhelming
// majority of calls: `assembleContext` gates every query behind a
// command-shape test that runs against a string already in memory, so a
// `Read`, an `ls` or an `Edit` costs precisely what it did before — one
// parse and a walk over five predicates. A query happens only for a command
// that could actually be the subject of a finding, which is rare by
// construction. The operation is therefore still declared `kind: "read"`,
// and now honestly so rather than vacuously.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import { assembleContext } from "@/lib/interventions/context";
import { evaluate, strongestLevel } from "@/lib/interventions/registry";
import { isBlockingLevel, type InterventionFinding } from "@/lib/interventions/types";

const EVENT_TYPES = ["PreToolUse", "PostToolUse", "Stop"] as const;

const inputSchema = z
  .object({
    eventType: z.enum(EVENT_TYPES),
    sessionId: z.string().min(1),
    /** The tool the hook observed, e.g. `Bash`. Absent for a `Stop` event. */
    tool: z.string().min(1).optional(),
    /** The command text the call carried. Absent for a `Stop` event. */
    command: z.string().optional(),
    /**
     * What the tool produced, on a `PostToolUse`. Bounded by the hook
     * before it is sent; bounded again here because an operation must not
     * trust its caller to have applied a limit the caller could change.
     */
    toolResult: z.string().max(8000).optional(),
  })
  .strict();

export type HookDecisionOperationInput = z.infer<typeof inputSchema>;

/** The two things this operation can say. Only `block` refuses. */
export const HOOK_DECISIONS = ["allow", "block"] as const;
export type HookDecision = (typeof HOOK_DECISIONS)[number];

export interface HookDecisionOperationOutput {
  readonly decision: HookDecision;
  /**
   * Why, when there is a why. `null` on the ordinary allow — a reason on
   * every call would put a line of noise into a session after every Read
   * the agent performs.
   */
  readonly reason: string | null;
  /**
   * Whether this phase could have blocked at all. Carried so a caller
   * reading a log can tell "nothing objected" apart from "something might
   * have, but the phase cannot refuse" without re-deriving the rule.
   */
  readonly canBlock: boolean;
  /**
   * The findings behind the answer, in registry order.
   *
   * Present even on an `allow`, because a nudge is a finding that allows —
   * and because "nothing triggered" and "something triggered and it was
   * only advice" are different facts that a caller reading a decision log
   * has no other way to tell apart. Empty when nothing triggered.
   *
   * Note this deliberately carries the whole finding rather than a rendered
   * string: prominence is a property of the message and the choice between
   * `plain` and `prominent` belongs to the front end (`INTERVENTIONS.md`),
   * so an operation that flattened them here would be making that decision
   * on the reader's behalf and hiding the other half.
   */
  readonly findings: readonly InterventionFinding[];
}

export const hookDecision = defineOperation({
  name: "hook_decision",
  kind: "read",
  summary: "Answers one hook event with allow or block, and any advisory text to surface.",
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: HookDecisionOperationInput,
  ): Promise<HookDecisionOperationOutput> {
    const canBlock = input.eventType === "PreToolUse";

    // `Stop` carries no tool call at all, so there is nothing for a
    // predicate keyed on a command or a tool to be about. Answered before
    // the registry rather than by letting every predicate decline in turn:
    // an advisory event (DECISIONS.md §6) that assembled a context and
    // walked the catalogue would be spending the highest-volume path's
    // budget to reach a conclusion the phase already determines.
    if (input.eventType === "Stop") {
      return { decision: "allow", reason: null, canBlock, findings: [] };
    }

    const context = await assembleContext({
      db: ctx.db,
      sessionId: input.sessionId,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.command === undefined ? {} : { command: input.command }),
    });

    const findings = await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      // The phase is read off the event, never off the entry. That is what
      // makes "a post entry cannot block" structural here: on a
      // `PostToolUse` the registry is only ever asked for `post` entries,
      // and every `post` entry's level is already clamped below blocking.
      phase: canBlock ? "pre" : "post",
      context,
    });

    if (!canBlock) {
      // The call has already run. Findings still travel — a `post` nudge is
      // the whole of what this phase can do, and suppressing it here would
      // leave the phase with no purpose at all.
      return { decision: "allow", reason: null, canBlock, findings };
    }

    const strongest = strongestLevel(findings);
    if (!isBlockingLevel(strongest)) {
      return { decision: "allow", reason: reasonFor(findings), canBlock, findings };
    }

    // Blocked. The reason names only the findings that actually block:
    // including an advisory nudge in a refusal's reason would tell the
    // session to fix something that was not why it was refused, and the
    // first thing it would do is fix the wrong one.
    const blocking = findings.filter((finding) => isBlockingLevel(finding.level));
    return {
      decision: "block",
      reason: reasonFor(blocking),
      canBlock,
      findings,
    };
  },
});

/**
 * The one sentence a hook renders, from however many findings there are.
 *
 * `null` for none, because the ordinary allow must stay silent — a reason
 * on every call would put a line of noise into a session after every `Read`
 * it performs.
 *
 * Uses `messages.plain`. The prominent form exists for a surface that can
 * afford to be loud, and a hook's output is prepended to an agent's next
 * turn where every extra line competes with the work; the front end picks
 * the loud one from `findings`, which travels intact.
 */
function reasonFor(findings: readonly InterventionFinding[]): string | null {
  const speaking = findings.filter((finding) => finding.level !== "nothing");
  if (speaking.length === 0) return null;
  return speaking.map((finding) => finding.messages.plain).join(" ");
}
