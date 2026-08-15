// `hook_decision` — MILESTONES.md #125, SCHEMA.md §19 `POST /hook`.
//
// **The server side of a hook that carries no logic.** The script reports an
// event and renders whatever comes back (`src/lib/hook/decide.ts`); this
// operation is the only party that decides anything, which is the whole
// point of the arrangement: every rule anyone actually wants is conditional
// on state — item state, claim state, review artifacts, budget — and that
// state is here and can never be in a script.
//
// ── What it answers today, and why that is `allow` ─────────────────────
//
// **Nothing blocks yet, and that is correct rather than a gap.** The
// pattern lists this operation used to match against are deleted (#125):
// matching command strings could not express a single one of the real
// rules, all of which are of the form *never do X **without** Y*. Gating
// returns with Interventions (#128), which is where the conditions live.
//
// Until then the honest answer to "may this run?" is yes. Note what that is
// *not*: it is not a permissive default that a misconfiguration could
// widen, because there is no configuration here to get wrong. There is no
// rule to fail open past.
//
// ── `post` can never block, enforced on both sides ─────────────────────
//
// The hook enforces it (`canBlock`) and so does this operation. Two checks
// for one invariant is deliberate and is not the "two implementations that
// can disagree" that DECISIONS.md §4 warns about — they cannot disagree,
// because neither can produce a block on a `post` event, and the only way
// to break the rule is for *both* to be wrong at once.
//
// It touches no table and appends no event: a decision made on every tool
// call is the highest-volume path in the system, so it stays a dumb pipe.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";

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
}

export const hookDecision = defineOperation({
  name: "hook_decision",
  kind: "read",
  summary: "Answers one hook event with allow or block, and any advisory text to surface.",
  input: inputSchema,
  async handler(
    _ctx: ServiceContext,
    input: HookDecisionOperationInput,
  ): Promise<HookDecisionOperationOutput> {
    const canBlock = input.eventType === "PreToolUse";

    if (!canBlock) {
      return {
        decision: "allow",
        reason: null,
        canBlock,
      };
    }

    // The `pre` branch. It allows unconditionally today; #128 is where the
    // intervention registry is consulted here, and where the argument in
    // `src/lib/hook/decide.ts`'s header about fail-open must be revisited
    // for this phase.
    return { decision: "allow", reason: null, canBlock };
  },
});
