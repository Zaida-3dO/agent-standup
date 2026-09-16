// The producer for the service-delivery channel — MILESTONES.md #128.
//
// ── The gap this closes, stated as it was found ────────────────────────
//
// `./delivery.ts` exists so findings ride the ordinary service response
// "not only through the hook, which decouples the whole feature from the
// hook being wired". Its payload has **two members answering two different
// questions**, and the distinction is the whole of what this module is for:
//
//   - **`digest`** — findings held from earlier calls, delivered when a
//     batch comes due. This half has a producer: `hold()`, called from
//     `src/app/api/hook/route.ts`. `decideDelivery` calls
//     `accumulator.take()` unconditionally, so it drains whatever the hook
//     put there whether or not this call found anything itself.
//   - **`findings`** — "what this very call triggered, delivered now", in
//     the header's own words. Only `immediate`-timed findings ride here.
//
// **The immediate half had no producer at all.** `createServiceDeliverer`'s
// `deliver` called `decideDelivery(accumulator, { sessionId, now })` with no
// `findings` key, and `decideDelivery` reads `options.findings ?? []` — so
// it partitioned an empty list on every call in the system. Nothing
// anywhere evaluated the registry on a service call: `evaluate()` had
// exactly one non-test caller, `hook_decision`.
//
// So the asymmetry was total. A session could receive a batch of things the
// *hook* noticed five minutes ago, and could never be told anything the
// call it just made had triggered — on a path built precisely so the
// feature would survive the hook not being wired.
//
// **This is oversight rather than intent, which is worth establishing
// before building.** The immediate lane is fully constructed and entirely
// uncalled: `partitionFindings` splits on it, `decideDelivery` promotes a
// finding the accumulator refused into it rather than dropping it, and
// `renderPayload` deliberately orders it ahead of the digest because
// otherwise it "would bury the thing they can act on right now under five
// things they cannot". A design that wanted a digest only would not have
// built, documented and tested the lane beside it.
//
// This module is that missing producer.
//
// ── Why the producer CANNOT live in the deliverer ──────────────────────
//
// The obvious-looking fix is to evaluate inside `deliver`. It is not
// available, for two structural reasons rather than one stylistic one:
//
//   1. **The deliverer is synchronous.** `ServiceRuntimeOptions.
//      deliverInterventions` is `(result, caller) => unknown` and its own
//      docstring says "Synchronous on purpose. An async deliverer would put
//      an await on every response in the system to compute an advisory
//      field." `evaluate` is async and `InterventionPredicate` may return a
//      promise, deliberately, so that an external predicate can eventually
//      be a process.
//   2. **The deliverer holds no database handle, and the transaction has
//      already closed by the time it runs.** That is not an oversight to
//      route around — `runtime.ts` calls it "the property that keeps the
//      ordinary path query-free, and the same contract the predicates
//      themselves are held to". Every entry this module can fire needs item
//      state, which only a handle can answer.
//
// So the producer runs **inside the transaction**, which is the one place
// that has both the handle and the call, and hands what it found forward to
// the delivery step that runs after the transaction closes. The deliverer
// stays synchronous, stays query-free, and stays exactly as cheap as it was.
//
// ── What it can actually produce, and why that is not nothing ──────────
//
// A service call carries no command text and no tool name, so every entry
// keyed on a command's *shape* — the broad `git add`, the process kill, the
// merge attempt — correctly declines, and `needs()` reports nothing needed
// for such a context. `./service-delivery.ts` already records this and
// treats it as the reason the path is affordable.
//
// What is left is the entries that read **item and board state alone**, and
// there are eight of them. Each one's predicate touches neither `command`
// nor `tool`:
//
//   - `finished-with-no-reviewer` (I1) — `itemState` + `hasApprovalAtTip`
//   - `review-without-approval-at-tip` — the same three fields
//   - `committed-with-no-pull-request` (I26) — `deliveryStage`
//   - `pull-request-with-no-review-requested` (I27) — `deliveryStage` +
//     `pullRequestAgeSeconds`
//   - `nits-merged-with-nothing-tracking-them` (I28) — `untrackedNits`
//   - `visual-reviews-in-flight-concurrently` (I25) — `pendingVisualReviews`
//   - `visual-review-deferred-without-record` (I30) —
//     `visualReviewDeferredUnrecorded`
//   - `crew-in-flight-without-check-in` — `crewInFlight`, for an
//     orchestrator-held claim
//
// That list is **not** hand-maintained prose: `tests/interventions-producer-
// reachability.test.ts` derives it by running every predicate in the
// registry against contexts narrowed to what this producer can assemble, and
// fails if the set changes. The hand-written version had **six** entries and
// the test found two more — one reading exactly the same fields as the
// first, missed because its name reads as a review-time check. Both would
// have been entries that silently never fired here.
//
// These are exactly the "work has stopped moving" entries, and a service
// call is the *better* moment to ask them than a tool call is. A session
// calling `note` or `transition_item` has just finished something and is
// recording it — the "natural juncture" the design asks for, described
// exactly — whereas the hook asks the same questions in the middle of a
// `Read`.
//
// ── Why it is gated on a WRITE, and gated hard ─────────────────────────
//
// These lookups are real queries, and the runtime is the seam every call in
// the system crosses. Running them on every `get_item` and every
// `list_items` would put **12 sequential queries** on the read path — the
// precise cost `../service/operations/hook-decision.ts` and `./context.ts`
// are shaped around avoiding.
//
// Twelve rather than the one-per-field the list above suggests, because
// `hasApprovingArtifactAtCurrentRoundAndTip` fans out into five of its own.
// Measured for an `in_review` item with a commit, a pull request and a
// `lgtm_with_nits` review, by instrumenting `$queryRawUnsafe`:
//
//   1. the assignment/item/repo join   7. `currentReviewRound`
//   2. `deliveryFor`                   8. approving artifacts at round
//   3. `untrackedNitsFor`              9. artifact kinds at round
//   4. `pendingVisualReviewsFor`      10. `currentTipCommitSha` again
//   5. `deferredVisualReviewFor`      11. `crewInFlightFor`
//   6. `currentTipCommitSha`          12. `readInterventionSettingRows`
//
// (6 and 10 are byte-identical — a cheap memoisation for anyone who wants
// it. The common case is far shorter: a session holding no claim exits
// after query 1.)
//
// A write is the honest gate, and it is not merely the cheap one. **Six of
// the eight** entries above describe a fact about an item that changes only
// when somebody *does* something: a commit is recorded, a review is
// requested, a state moves. A read cannot change any of those, so asking
// after one would re-derive an answer identical to the last write's.
//
// The remaining two are **time-dependent**, and the gate treats them
// differently — worth knowing before extending it:
//
//   - `pull-request-with-no-review-requested` reads `pullRequestAgeSeconds`,
//     computed as `NOW() - MAX(a."createdAt")`. A pull request simply ages
//     past the grace window.
//   - `crew-in-flight-without-check-in` filters on
//     `a."lastActive" > NOW() - MAKE_INTERVAL(...)`. A crewmate goes quiet
//     and ages past the dead threshold.
//
// Both can become true with nobody writing anything. The gate **defers**
// them to the session's next write rather than dropping them, and a session
// doing work writes constantly — so the practical loss is a delay, not a
// missed finding. That is a weaker claim than "free of missed findings",
// and it is the one the code supports.
//
// ── Time is an argument, never a reading ───────────────────────────────
//
// Like every other module on this path, this one never calls `Date.now()`.
// The caller supplies it, which is what keeps "a batch is due five minutes
// later" assertable as a value.

import { evaluate } from "./registry";
import { BUILTIN_INTERVENTIONS } from "./builtins";
import { assembleServiceContext } from "./context";
import { readInterventionSettingRows, resolveInterventionSettings } from "./settings";
import type { InterventionFinding } from "./types";
import type { TransactionHandle } from "@/lib/service/context";

/**
 * What the producer needs to know about the call it is riding on.
 *
 * A handle and a session, and nothing else. Notably no operation name: the
 * entries this path can fire are facts about an item rather than about
 * which call surfaced them, and gating them by operation would be a second
 * catalogue to keep in step with the first.
 */
export interface ProduceOptions {
  readonly db: TransactionHandle;
  /** The session the response will go back to. */
  readonly sessionId: string;
  /** `liveness.dead_after_seconds`, handed in like every other threshold. */
  readonly crewInFlightDeadAfterSeconds?: number;
}

/**
 * Finds what is worth saying to this session, from inside the transaction.
 *
 * Returns the findings rather than delivering them, for the same reason
 * `evaluate` does and `DigestAccumulator.add` does: this function has no
 * response to attach anything to, and the decision about what to do with a
 * finding belongs where the context to make it exists.
 *
 * **Every failure produces an empty array rather than a throw.** This runs
 * inside the caller's transaction, on a write that is about to commit, and
 * an advisory field must never be the reason a real write rolls back. That
 * is the same fail-open reasoning DECISIONS.md sec.16 records for the hook,
 * applied at the other place a finding can be produced — and it matters
 * more here than there, because here the call has genuine work to lose.
 */
export async function produceServiceFindings(
  options: ProduceOptions,
): Promise<readonly InterventionFinding[]> {
  const { db, sessionId, crewInFlightDeadAfterSeconds } = options;

  try {
    const context = await assembleServiceContext({
      db,
      sessionId,
      ...(crewInFlightDeadAfterSeconds === undefined ? {} : { crewInFlightDeadAfterSeconds }),
    });

    // No claim, no item, nothing any of these entries can be about. Answered
    // before the settings read for the same reason `readOverridesIfUseful`
    // gates its own: a call that cannot produce a finding must not pay for
    // the configuration that would have shaped one.
    if (context === null) return [];

    const stored = await readInterventionSettingRows(db);
    const overrides =
      stored.length === 0
        ? {}
        : resolveInterventionSettings({ stored, entries: BUILTIN_INTERVENTIONS }).overrides;

    // `post`, and only ever `post`. A service call has already committed by
    // the time this runs — the transaction is open but the work is done and
    // the operation's handler has returned — so a `pre` entry evaluated here
    // would be asked whether to refuse something that has already happened.
    // The registry's own invariant says a `post` entry cannot block, which
    // means nothing produced on this path can ever reach a caller as a
    // refusal, only as a message. That is the correct and only available
    // answer for a surface that cannot say no.
    return await evaluate({
      entries: BUILTIN_INTERVENTIONS,
      overrides,
      phase: "post",
      context,
    });
  } catch {
    // Swallowed deliberately, and the swallow is narrow in effect rather
    // than in scope: the only thing lost is an advisory message, and the
    // thing protected is a write the caller asked for and the database has
    // already done the work for.
    return [];
  }
}
