// The mechanism that makes `dry_run` actually not mutate. See
// MILESTONES.md #27 and the review note on row #15 this row was told to
// resolve deliberately, not by convention.
//
// ── The problem ──────────────────────────────────────────────────────────
//
// `rehearseTransition` (state-machine/transition.ts) never issues a write
// itself. But a guard's `check` gets the same `ctx.db` a real transition
// uses — that is deliberate, so a guard can query whatever it needs inside
// the one transaction — and nothing stops a guard from also *writing*
// through it while deciding. Today every registered guard happens to be a
// read-only validator, so "rehearsal never mutates" currently holds only by
// convention, not by construction. `runtime.ts`'s own contract is: the
// transaction commits when the operation handler *resolves*, and rolls back
// only when it *throws*. If a rehearsal handler simply called
// `rehearseTransition` and returned its outcome, a guard's write would
// commit right alongside it — dry_run would have a side effect the moment
// any future guard (or a guard change) ever adds one.
//
// ── The decision ─────────────────────────────────────────────────────────
//
// **Enforce it structurally, not by convention.** `transition_item`'s
// `dryRun` branch (`transition-item.ts`) always throws after computing the
// outcome, whether the transition was allowed or refused. Throwing is what
// this runtime already treats as "abandon everything this call did" — so a
// rehearsal aborts its own transaction unconditionally, and a future guard
// that writes something while merely being *asked* can never make that
// write outlive the call. This is a small, deliberate echo of
// `applyTransition`'s own precedent for turning a rejection into a throw
// for exactly this reason (see that function's doc comment).
//
// `RehearsalRollback` is the vehicle: a `ServiceError` (so
// `toServiceError` in `runtime.ts` passes it through unchanged instead of
// wrapping it as `InternalError` and losing the payload) carrying the
// computed `TransitionOutcome` in `details`. `transitionItem`'s caller
// (the HTTP route) catches exactly this class and returns its payload as a
// normal 200 — every other thrown value still becomes whatever error
// response it always did. The `code` is `internal` deliberately: if this
// class ever escaped uncaught past the route (a bug in the route's catch,
// or a future adapter that forgets to special-case it), the caller sees a
// 500 and an opaque failure, not a 200 with the wrong body and not a
// rehearsal that silently reports success — a mis-wired adapter fails
// loudly instead of leaking rehearsal machinery into whatever it makes of
// an ordinary rejection code.
//
// ── What this does, and does not, prove ─────────────────────────────────
//
// AC4 for this row is checked by querying the database in a *separate call*
// after a rehearsal, never by trusting the returned outcome — the same
// posture `state-machine-transition.test.ts` already takes for
// `rehearseTransition` itself. What this class adds on top of that existing
// guarantee is specifically the "a guard also writes" case row #15's review
// flagged: `state-machine-transition.test.ts` already proves the transition
// write itself never lands during rehearsal; this row's own
// `tests/transition-complete-operations.test.ts` ("AC4 — a guard's OWN
// ctx.db write during rehearsal…") proves a guard's own write is rolled
// back too, with a guard planted for exactly that purpose.
//
// One thing this does **not** cover: a guard that reaches outside the
// transaction entirely (an HTTP call, a write through a second, independent
// database connection). Nothing in this service layer stops that today —
// `ctx.db` is the only handle a guard is handed, but TypeScript cannot stop
// a guard from importing something else. That is a pre-existing gap in the
// guard contract, not one this row introduces or can close from here.
import { ServiceError } from "../errors";
import type { TransitionOutcome } from "../state-machine/transition";

export class RehearsalRollback extends ServiceError {
  readonly outcome: TransitionOutcome;

  constructor(outcome: TransitionOutcome) {
    super("internal", "Rehearsal complete — this throw exists only to force a rollback.", {
      details: { outcome },
    });
    this.outcome = outcome;
  }
}

/** Whether a thrown value is this rehearsal-rollback sentinel. */
export function isRehearsalRollback(value: unknown): value is RehearsalRollback {
  return value instanceof RehearsalRollback;
}
