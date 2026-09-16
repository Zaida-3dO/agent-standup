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
// through it while deciding. Every registered guard happens to be a
// read-only validator, so "rehearsal never mutates" holds only by
// convention, not by construction — nothing in the guard contract requires
// it. `runtime.ts`'s own contract is: the
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
// computed `TransitionOutcome` in `details`.
//
// ── Who catches it: the runtime, and nobody else ─────────────────────────
//
// `ServiceRuntime.#dispatch` catches this class immediately outside the
// transaction and resolves it as `{ outcome }` (see step 4 there). That is
// the only catch in the codebase, and the sentinel does not leave the
// service layer: an adapter — HTTP, MCP over either transport, the command
// line on either binding — receives an ordinary resolved result and has no
// rehearsal concern at all.
//
// **One catch, at the seam, rather than one per adapter — and the
// difference is a correctness property, not a tidiness one.** Unwrapping at
// each mount requires every adapter to independently know that this
// operation reports its answer by throwing, which is an internal detail of
// the rehearsal mechanism and something an adapter author has no reason to
// suspect. A mount that misses it reports every rehearsal as a retryable
// `internal` fault — the most damaging available shape, because `retryable`
// on a permanently failing condition burns an autonomous caller's retry
// budget, and because a rehearsal of a *rejected* move is exactly the
// high-value question ("why can't I move this?") that is then destroyed. An
// adapter that cannot see the sentinel cannot forget to handle it; that is
// a structural guarantee, where a convention every mount must remember is
// only a hope.
//
// The `code` is `internal` for the narrow job it can genuinely do: if this
// class ever escapes the runtime's catch — which requires a bug in the
// runtime itself — the caller sees an opaque failure rather than a success
// carrying the wrong body. That is a backstop against one bug in one place,
// not a substitute for the escape being impossible. A loud failure is loud
// only to the caller receiving it, which is not the same as loud to CI, so
// it cannot be relied on to surface a mis-wiring before a user meets it.
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
// database connection). Nothing in this service layer stops that —
// `ctx.db` is the only handle a guard is handed, but TypeScript cannot stop
// a guard from importing something else. That is a gap in the
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
