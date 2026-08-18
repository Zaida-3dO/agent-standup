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
// **What runs it on a schedule.** Reason 1 is a claim about where the
// schedule lives, not an excuse for there being none — an installation with
// no schedule leaks claims that are reclaimable and never reclaimed, which is
// the state an operator actually experiences. So the repository ships one, at
// the layer the reasoning puts it: `docker-compose.prod.yml`'s
// `sweep-scheduler` service runs `scripts/sweep-schedule.mjs` beside the app,
// calling `POST /api/sweep` every `SWEEP_INTERVAL_SECONDS` (default 300). An
// operator who would rather use a scheduler they already have drops that
// service and points a cron entry at the same endpoint or at `standup sweep`;
// nothing here distinguishes the callers, which is the property reason 1 buys.
// README.md's Deployment section is the operator-facing version.
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
}

// Stryker disable all : this object is evaluated once at import, before any
// mutant is activated. Stryker switches a mutant at RUNTIME, by checking
// `global.activeMutant` where the mutated expression evaluates; an operation's
// metadata is read into the registry (`registry.ts` keys it by `sweep.name`)
// as the module loads, which happens before the first test body runs and is
// never re-evaluated per mutant. So a mutation here changes nothing any test
// can observe, and reports Survived however thoroughly the metadata is
// asserted — `tests/service-registry.test.ts` and
// `tests/sweep-takeover-operations.test.ts` both assert `name`, `kind` and
// `summary`, and both genuinely fail when the source is edited. Disabled
// because these mutants are unkillable by construction, NOT because the
// behaviour is untested. See issue #166 — this applies to every operation.
export const sweep = defineOperation({
  name: "sweep",
  kind: "write",
  summary:
    "Runs the liveness sweep: ages quiet sessions, releases claims held by dead ones, escalates stuck items.",
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
    };
  },
});
