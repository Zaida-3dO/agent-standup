// `sweep` — the trigger for the liveness ladder (MILESTONES.md #99, #130,
// SCHEMA.md §2, §17.5).
//
// The ladder itself is `sweepLiveness` (src/lib/liveness.ts, row #24): it walks
// live assignments, moves them along running → stalled → dead, releases what
// died, escalates what has exhausted its resume attempts, and re-checks the
// capability documents. It does all of that only when something invokes it. A
// sweep nothing invokes is a reclamation policy the system describes but does
// not perform, and the visible symptom is a claim that can never be handed back
// — the claim insert absorbs its conflict rather than raising, so every later
// claim on a stranded item is refused as already-held with nothing anywhere
// that would ever release it.
//
// This operation is that trigger, and it is deliberately a plain registered
// operation rather than a background timer inside the process. Three reasons,
// in order of how much they matter:
//
//   1. **It has to be reachable from outside.** The application ships as a
//      bundle that may run one replica or several; a timer per replica means
//      the sweep runs a multiple of the intended rate, or zero times if the
//      replica holding it is the one that restarts. Neither mistake produces
//      any output to notice. An operation is invoked by whatever the
//      deployment already trusts to run things on a schedule, and that is a
//      decision the deployment gets to make rather than one baked in here.
//   2. **It is observable.** As an operation it gets the same envelope, the
//      same error codes and the same result rendering as everything else, so
//      "did the sweep run and what did it find" is answerable by whoever ran
//      it rather than only from the logs.
//   3. **It runs in one transaction**, because `callOperation` opens one —
//      which is what `sweepLiveness`'s own header requires and could not
//      guarantee for itself.
//
// **What runs it.** Reason 1 is a claim about where the schedule lives, not
// an excuse for there being none — an installation with no schedule leaks
// claims that are reclaimable and never reclaimed, which is the state an
// operator actually experiences. **The repository ships nothing that runs
// it**, deliberately: an operator points a cron entry, a platform scheduler
// or a hand-run command at `POST /api/sweep` or at `standup sweep`, and
// nothing here distinguishes the callers, which is the property reason 1
// buys. README.md's Deployment section is the operator-facing version.
//
// A bundled scheduler was tried and withdrawn, and the reason is worth
// keeping because it constrains what should replace it. It could not
// authenticate — the route is authenticated per machine, the scheduler
// carried no token, and it failed every tick while its container reported
// healthy, which is the silent-success shape this codebase treats as worse
// than an outage. Reclaiming on a fixed tick is also the weakest form of the
// idea: it acts on a liveness signal that may never be written, so a session
// working for half an hour looks like one that crashed. Reclaiming at the
// point of contention — when another session actually wants the item — is
// correct at the instant it matters. Escalation is the part that genuinely
// needs a push, since nobody is reading by definition.
//
// **Why `now` is not an input.** A caller that could set the sweep's clock
// could age every assignment past the dead threshold in one call and release
// every claim in the system — the same authority as reclaiming by hand, but
// unlabelled. Tests inject `now` by calling `sweepLiveness` directly, which
// they already do; nothing is lost by the operation itself always using the
// real clock.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { sweepLiveness, type LivenessSweepResult } from "@/lib/liveness";

const inputSchema = z.object({}).strict();

export type SweepOperationInput = z.infer<typeof inputSchema>;

export interface SweepOperationOutput {
  readonly checkedAt: string;
  readonly moves: LivenessSweepResult["moves"];
  readonly released: LivenessSweepResult["released"];
  readonly escalated: LivenessSweepResult["escalated"];
  readonly capabilityChecks: LivenessSweepResult["capabilityChecks"];
  /**
   * The moves that took a session from `running` straight to `dead` in this
   * one pass, rather than ageing it through `stalled` first.
   *
   * Reported separately because the two are different events wearing the
   * same shape. Ageing a session that was already `stalled` confirms
   * something the previous sweep had already noticed; taking one from
   * `running` to `dead` releases the claim of a session nothing had yet
   * flagged, and that is the move most likely to have hit a session that is
   * in fact alive. A holder running no hook stamps `lastActive` only when it
   * makes a deliberate board call, so a long stretch of reading source or
   * running a test suite is indistinguishable from having died — see the
   * warning in `src/lib/claim-eviction.ts`, which is where that weakness is
   * written down.
   *
   * These ids are also present in `moves` and `released`; this is a view
   * over them, not extra work. It exists so a caller reviewing a sweep can
   * see the consequential releases without deriving them from `from`, which
   * is the step an operator reported skipping — the flat arrays read as one
   * undifferentiated list, and the evictions of live sessions were only
   * noticed because they happened to have the live agent list open.
   */
  readonly evictedWhileRunning: LivenessSweepResult["moves"];
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const sweep = defineOperation({
  name: "sweep",
  kind: "write",
  summary:
    "Runs the liveness sweep: ages quiet sessions, releases claims held by dead ones, escalates stuck items. `evictedWhileRunning` singles out the sessions taken from running straight to dead — the releases most likely to have hit a session that was working quietly rather than one that had stopped.",
  // Stryker restore all
  input: inputSchema,
  // The input is declared and parsed (`.strict()` is what refuses a caller's
  // stray field) but never read — the operation takes nothing, deliberately.
  async handler(ctx: ServiceContext): Promise<SweepOperationOutput> {
    // The sweep is credited to whoever ran it when the caller identifies
    // itself, and to `system` otherwise — a scheduled invocation has no agent
    // behind it, and attributing it to one would put a name on every
    // automatic release that no session actually chose to make.
    const actor = ctx.caller.actor
      ? ({ actorType: "agent", actorId: ctx.caller.actor } as const)
      : ({ actorType: "system", actorId: null } as const);

    const result = await sweepLiveness(ctx.db, ctx.settings, actor);

    return {
      // Serialised here rather than handed back as a `Date`: this is an
      // operation result, and every adapter renders it as JSON.
      checkedAt: result.checkedAt.toISOString(),
      moves: result.moves,
      released: result.released,
      escalated: result.escalated,
      capabilityChecks: result.capabilityChecks,
      evictedWhileRunning: result.moves.filter(
        (move) => move.from === "running" && move.to === "dead",
      ),
    };
  },
});
