// "This item was approved and never merged" — the one flow signal this
// schema can answer, surfaced on the read a session already makes.
//
// ── The failure this exists to catch ────────────────────────────────────
//
// The board records state transitions faithfully and never notices that a
// state has **stopped changing**. Those are different capabilities and only
// the second one carries work to merge. Two sessions on two machines hit
// the same wall on the same day without knowing about each other: one
// produced four branches, dispatched reviewers who approved them, and left
// all four unmerged; the other minted three rows, got three working PRs,
// and left every row untouched. In both cases the owner noticed before the
// board did.
//
// The mechanism was never missing. Once prompted, the second session
// claimed, recorded artifacts and transitioned three rows in about four
// minutes, and nothing refused it — the vocabulary and the tools are right.
// What was absent is anything that **points a session at them**: roughly
// thirty calls were made across that session and not one response ever
// suggested an item might need merging.
//
// ── Why this predicate, and not the others ──────────────────────────────
//
// `docs/plans/INTERVENTIONS.md` catalogues four unbuilt "flow" entries, and
// each names a signal this server cannot observe:
//
//   - **I2** (an available row nobody is building) needs a dependency graph
//     that exists as prose rather than as a relation — `Item.blockedOnType`
//     has no `item` member, so one row cannot be recorded as waiting on
//     another. Its own entry rejects the cheap substitute (a row with no
//     open children) because that "would fire on every leaf in the backlog,
//     which is most of the board".
//   - **I3** (a claim held while its holder works elsewhere) needs a tool
//     call attributed to an item, and nothing attributes one.
//   - **I4** (a subagent finished and the orchestrator has not picked it
//     up) cannot tell that from "picked it up half a second ago", because
//     nothing records that the parent was told.
//   - **I5** (`lgtm_with_followups` with no follow-up minted) has its
//     signal, and `merge.requires_linked_followup` already refuses that
//     combination outright — so an entry here would be a second voice on a
//     decision already made.
//
// What is left is the situation those four talk around: an item carrying an
// **approving review** that has not reached a closed state. That is a
// question about rows this server owns, answerable without a graph, without
// attributing a call, and without guessing at intent.
//
// ── Approval means approval ─────────────────────────────────────────────
//
// The verdict set is `APPROVING_VERDICTS` from `@/lib/verdicts`, imported
// rather than restated. It is the same set every merge gate reads, so the
// nudge and the gate cannot drift apart about what an approval is — and it
// already carries the reading the field notes got wrong by hand:
// `lgtm_with_nits` and `lgtm_with_followups` **are approvals**. A reviewer
// returning one has said the change is sound; the tiers differ only in what
// else must be true before it lands. Read as "not finished yet" — the
// reading one of the reporting sessions made, and the reason four branches
// sat parked — it becomes the most expensive verdict in the vocabulary.
//
// ── Why an age threshold, and why it is the whole design ────────────────
//
// A signal that fires on everything is worse than none, because readers
// learn to skip it. An approval recorded seconds ago is not stalled work;
// it is work in progress, and the session that just recorded it is the
// least likely party in the system to have forgotten about it. Firing there
// would put a line on the response of the very call that was doing the
// right thing.
//
// So the finding is gated on the newest approval being older than
// `interventions.approved_unmerged_after_seconds`. The threshold is what
// separates "this stopped" from "this is happening", and it is the only
// reason the quiet case stays quiet.
import { APPROVING_VERDICTS } from "@/lib/verdicts";

/** Item states that mean the work is finished or abandoned — nothing to nudge about. */
const CLOSED_STATES: ReadonlySet<string> = new Set(["merged", "wont_do", "cancelled"]);

/**
 * The states an approved-but-unmerged finding can be raised against.
 *
 * Exported for the test that asserts a closed item produces nothing: the
 * quiet case deserves to be pinned by name rather than by an example.
 */
export function isClosedState(state: string): boolean {
  return CLOSED_STATES.has(state);
}

/** One item's approval facts, as the query below reads them. */
export interface ApprovalFacts {
  readonly itemId: string;
  readonly title: string;
  readonly state: string;
  /**
   * When the newest approving review artifact was recorded, or `null` when
   * the item has none.
   *
   * `null` is the overwhelmingly common answer and is deliberately not
   * conflated with "old": an item nobody has reviewed is not stalled at
   * this step, it is simply earlier in its life.
   */
  readonly approvedAt: Date | null;
}

/** A single stalled-work finding, as `my_work` reports it. */
export interface StalledWorkFinding {
  readonly itemId: string;
  readonly title: string;
  readonly state: string;
  /** ISO 8601 — when the approval that is waiting was recorded. */
  readonly approvedAt: string;
  /** How long it has waited, in whole seconds. What "how long has it waited" answers. */
  readonly waitingSeconds: number;
  /** One line naming the situation and the call that resolves it. */
  readonly message: string;
}

/**
 * Turns approval facts into findings — the whole decision, as a pure
 * function of values already in memory.
 *
 * Pure and synchronous on purpose. It reaches no database and is handed no
 * handle, which is the same contract `InterventionContext` holds its
 * predicates to (`src/lib/interventions/types.ts`) and the property that
 * lets the threshold be tested at its boundary without a fixture at every
 * age.
 *
 * `now` is a parameter rather than a call to `Date.now()` inside, so a test
 * can sit an approval exactly on the threshold instead of racing the clock.
 */
export function findStalledWork(
  facts: readonly ApprovalFacts[],
  thresholdSeconds: number,
  now: Date,
): readonly StalledWorkFinding[] {
  const findings: StalledWorkFinding[] = [];

  for (const fact of facts) {
    // No approval: earlier in its life, not stalled. Checked first because
    // it is the common case and because `approvedAt` is read below.
    if (fact.approvedAt === null) continue;
    // Finished or abandoned work has nowhere left to go.
    if (isClosedState(fact.state)) continue;

    const waitingSeconds = Math.floor((now.getTime() - fact.approvedAt.getTime()) / 1000);

    // Strictly greater than, so an approval exactly at the threshold is not
    // yet a finding. The boundary has to fall on one side or the other and
    // this is the quiet side, consistent with the rest of the design: the
    // cost of being one second late is nothing, and the cost of firing on
    // fresh work is a reader who stops reading.
    if (waitingSeconds <= thresholdSeconds) continue;

    findings.push({
      itemId: fact.itemId,
      title: fact.title,
      state: fact.state,
      approvedAt: fact.approvedAt.toISOString(),
      waitingSeconds,
      message:
        `Approved and not merged for ${describeDuration(waitingSeconds)}. ` +
        `An approving review is an approval — including lgtm_with_nits and ` +
        `lgtm_with_followups, which merge now and raise the follow-ups as their own rows. ` +
        `Transition it to merged, or say why it is waiting.`,
    });
  }

  return findings;
}

/**
 * A duration a reader can act on, rather than a raw second count.
 *
 * Whole units only, largest that fits. "2 hours" is what decides whether
 * someone looks; "7412 seconds" is a number they have to convert first, and
 * the conversion is exactly the friction that gets a line skipped.
 */
export function describeDuration(seconds: number): string {
  if (seconds >= 86_400) return plural(Math.floor(seconds / 86_400), "day");
  if (seconds >= 3_600) return plural(Math.floor(seconds / 3_600), "hour");
  if (seconds >= 60) return plural(Math.floor(seconds / 60), "minute");
  return plural(seconds, "second");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * The approving-verdict list, as a value the SQL below binds as a parameter.
 *
 * Bound and cast rather than interpolated, for the reason
 * `guards/artifact-tip.ts` gives about the same set: the values come from a
 * module constant rather than from a caller, but building a query string out
 * of an array is a habit that stops being safe the first time the array's
 * source changes.
 */
export const APPROVING_VERDICT_VALUES: readonly string[] = APPROVING_VERDICTS;
