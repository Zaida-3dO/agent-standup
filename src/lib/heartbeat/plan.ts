// The planner — MILESTONES.md #59, DECISIONS.md §5 ("Allocation").
//
// ── What this is, and why it is a pure function ─────────────────────────
//
// §5 states the shape outright: each machine "runs a scheduled task that
// polls and launches whatever comes back. ~30 lines, no decisions. The
// server-side planner is **pure code**." That is the whole architecture in
// two sentences, and this module is the second one.
//
//   > "Budget headroom as **points = percentage points of the window** — no
//   > new unit, estimates and budget are automatically in the same currency.
//   > Estimates from cost history, or from `difficulty` facets for unseen
//   > work. In-flight work subtracts. Sort by priority, fill until
//   > exhausted, return the list."
//
// **Pure code, and not an LLM, is the single biggest cost decision in the
// design.** A scheduler that has to *reason* costs millions of
// input-equivalents per tick, so its interval gets stretched to an hour just
// to stay affordable. A tick that finds nothing costs one HTTP request here,
// so the interval can be chosen for responsiveness instead. Everything in
// this file is therefore arithmetic and sorting — no I/O, no clock, no
// database handle. What it cannot see, it takes as an argument.
//
// ── Determinism is the correctness property, not a nicety ───────────────
//
// §5's "two-machine race" is the reason. The design deliberately has **no
// reservation table**: two machines polling at the same moment are both
// handed a plan, and the race resolves because "the **list is the
// allocation**, and both machines fulfilling the same list fulfils it once
// (whoever wins each atomic claim, wins; the other fails)".
//
// That argument holds only under two conditions, and §5 names them:
//
//   > "Two conditions, both just 'write it correctly': **deterministic
//   > ordering** (stable tiebreak on item ID) and **the server subtracts
//   > in-flight work**."
//
// So a non-deterministic sort is not a cosmetic defect here — it is the
// thing that turns a race the design has *already argued is safe* into one
// that is not. If two machines are handed the same items in different
// orders, they pack different subsets against their own headroom, and the
// allocation is no longer "fulfilled once".
//
// This is a real failure mode, not a hypothetical one: a merge gate
// elsewhere ordered by `createdAt DESC, id DESC` where the id was a random
// UUID, so ties resolved by coin flip. It was misfiled as a flaky test for
// weeks. The lesson taken here is that **every comparison must end in a
// total order** — a tiebreak that can itself tie is not a tiebreak.
//
// ── Why packing continues past a candidate that does not fit ────────────
//
// This is first-fit, not greedy-stop: an item too expensive for the
// remaining headroom is skipped and packing continues with the next one.
// The alternative — stopping at the first item that does not fit — would let
// one expensive P0 block a machine that had room for three cheap P1s, and
// §5's "fill until exhausted" is explicit that the headroom is what runs
// out, not the patience of the loop.
//
// The cost of first-fit is that a large item can be starved by a stream of
// small ones. That is accepted, and §5 licenses it: "**The allocator doesn't
// need to be accurate** — wind-down is the backstop for an overrun, so it
// only has to be roughly right." Priority ordering already gives the large
// item first refusal on a full window; being skipped means the window was
// genuinely too full, and the next tick reconsiders it from scratch.

/**
 * Priority, most urgent first. The order of this array **is** the sort
 * order — see `priorityRank`.
 */
export const PLAN_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];

/**
 * One thing that could be dispatched this tick.
 *
 * Deliberately not the database row. The planner needs four facts about an
 * item and taking the whole row would couple a pure function to a schema it
 * has no other reason to know — and would make every test construct a
 * complete item to assert something about sorting.
 */
export interface PlanCandidate {
  /** The item's id. Also the tiebreak — see `comparePlanCandidates`. */
  readonly id: string;
  readonly priority: PlanPriority;
  /**
   * What this is expected to cost, in **points: percentage points of the
   * window** (§5).
   *
   * The unit is the whole reason this is comparable to headroom without a
   * conversion. Note `items.estimated_cost` in SCHEMA.md §1 is deliberately
   * *not* stored in this unit — it is a cost at list price, because "a
   * share is volatile, meaningless once the window definition moves". The
   * conversion to points happens at decision time, upstream of here, which
   * is exactly why this module takes points and never a currency amount.
   */
  readonly estimatedPoints: number;
}

/** What was planned, and the arithmetic that produced it. */
export interface Plan {
  /** The items to dispatch, in the order they should be dispatched. */
  readonly dispatch: readonly PlanCandidate[];
  /** Points committed by `dispatch` — the sum of its estimates. */
  readonly committedPoints: number;
  /** Headroom left after `dispatch`. Never negative. */
  readonly remainingPoints: number;
  /**
   * Candidates that were considered and not planned, each with the reason.
   *
   * Carried because "why was nothing dispatched?" is otherwise unanswerable
   * without re-running the planner by hand, and it is the first question
   * asked of a heartbeat that looks idle. It costs one array on a path that
   * runs once per machine per five minutes.
   */
  readonly skipped: readonly PlanSkip[];
}

/** Why one candidate did not make the plan. */
export interface PlanSkip {
  readonly id: string;
  /**
   * `no-headroom` — it did not fit in the headroom remaining when it was
   * reached. `not-estimable` — its estimate was absent or not a usable
   * number, so packing it could not be reasoned about at all.
   */
  readonly reason: "no-headroom" | "not-estimable";
}

export interface PlanInput {
  /**
   * Everything eligible for dispatch. Eligibility (state, claims, machine
   * capability) is decided upstream — this function does not filter, it
   * allocates.
   */
  readonly candidates: readonly PlanCandidate[];
  /**
   * Total headroom for this window, in points.
   *
   * Comes from the budget bands (#57). A non-positive value plans nothing,
   * which is the correct reading of "no headroom" and also of a window
   * already overspent.
   */
  readonly headroomPoints: number;
  /**
   * Points already committed to work that is running now.
   *
   * §5: "In-flight work subtracts", and it is one of the two conditions
   * that make the no-reservation-table design safe. Subtracted here rather
   * than by the caller so that a caller which forgets cannot silently
   * double-book a window — the parameter is not optional for the same
   * reason.
   */
  readonly inFlightPoints: number;
}

/**
 * Where a priority sorts. Lower is more urgent.
 *
 * An unrecognised priority sorts **last** rather than throwing. The planner
 * runs unattended every five minutes on every machine, and a single row
 * carrying a priority this build does not know is not a reason to dispatch
 * nothing at all — it is a reason to consider that row after the ones this
 * build does understand.
 */
function priorityRank(priority: PlanPriority): number {
  const rank = (PLAN_PRIORITIES as readonly string[]).indexOf(priority);
  return rank === -1 ? PLAN_PRIORITIES.length : rank;
}

/**
 * A **total** order over candidates: priority first, then id.
 *
 * The id tiebreak is what makes the plan reproducible, and it is compared
 * with `<`/`>` rather than `localeCompare` deliberately — `localeCompare` is
 * locale-sensitive, so the same two ids can order differently on two
 * machines with different locales configured. That is precisely the
 * cross-machine divergence the determinism requirement exists to prevent,
 * and it would be invisible in a test suite that runs in one locale.
 *
 * Because ids are unique, this never returns 0 for two distinct candidates,
 * so the sort has nothing left to resolve arbitrarily.
 */
export function comparePlanCandidates(a: PlanCandidate, b: PlanCandidate): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Whether an estimate can be packed against headroom at all. */
function isEstimable(points: number): boolean {
  return typeof points === "number" && Number.isFinite(points) && points >= 0;
}

/**
 * Plans one tick: sort by priority, pack against headroom, deterministically.
 *
 * Pure. Given the same input it returns the same plan, on any machine, in
 * any order of arrival, for ever — which is the property the two-machine
 * race depends on (see the module note).
 *
 * The input is never mutated: the sort runs on a copy, because a planner
 * that reordered its caller's array would be a surprising side effect in a
 * function documented as pure.
 */
export function planDispatches(input: PlanInput): Plan {
  const available = input.headroomPoints - input.inFlightPoints;

  const ordered = [...input.candidates].sort(comparePlanCandidates);

  const dispatch: PlanCandidate[] = [];
  const skipped: PlanSkip[] = [];
  let committed = 0;

  for (const candidate of ordered) {
    if (!isEstimable(candidate.estimatedPoints)) {
      skipped.push({ id: candidate.id, reason: "not-estimable" });
      continue;
    }
    // `<=` so that an item costing exactly the remaining headroom fits.
    // Headroom is a budget to spend, not a level to stay under, and the
    // band above it is a wind-down rather than a hard stop — so refusing
    // the item that exactly fills the window would leave a machine idle
    // against a window it was entitled to spend.
    if (committed + candidate.estimatedPoints <= available) {
      dispatch.push(candidate);
      committed += candidate.estimatedPoints;
      continue;
    }
    skipped.push({ id: candidate.id, reason: "no-headroom" });
  }

  return {
    dispatch,
    committedPoints: committed,
    // Clamped at zero: `available` is negative when in-flight work already
    // exceeds the window, and a negative "remaining" would read as a number
    // to spend rather than as nothing left.
    remainingPoints: Math.max(0, available - committed),
    skipped,
  };
}
