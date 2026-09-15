// Interventions — the shape, not the catalogue. MILESTONES.md #128,
// `docs/plans/INTERVENTIONS.md`.
//
// An intervention is a **detectable situation** plus a **response**. This
// module defines what one *is*; `./registry.ts` defines what the system does
// with a set of them. The catalogue itself — what is worth detecting — lives
// in `docs/plans/INTERVENTIONS.md` and grows independently of this code.
//
// ── The three decisions that keep custom entries possible ──────────────
//
// #128 asks that v1 not foreclose user-supplied interventions, and names
// three cheap things that keep the door open. All three are here, and all
// three are properties of the *types* rather than conventions to remember:
//
//   1. **A predicate declares the context it needs; it does not go and get
//      it.** `InterventionContext` is handed in. There is no database client
//      reachable from a predicate, because the type it is given does not
//      carry one — which is what makes "the built-ins obey a contract they
//      do not strictly need yet" enforceable rather than aspirational. An
//      external script's stdin payload is exactly this object serialised.
//   2. **The verdict is a returned value, never a side effect.**
//      `InterventionVerdict` — `{triggered, level?, message?, data?}` — is
//      the whole of what a predicate may produce. A predicate that emitted
//      its own nudge could not be swapped for an external process; one that
//      returns a finding can. Nothing here has a channel to emit on.
//   3. **The registry is keyed by id, and every entry carries a `source`**
//      (`builtin` | `custom`) from the start, even while only `builtin`
//      exists. A settings row attaches to an id, so a custom entry inherits
//      the whole configuration surface for free rather than needing one
//      built for it.

/**
 * Which side of the tool call an entry runs on.
 *
 * This is the field that decides what responses are even available —
 * see `LEVELS_BY_PHASE` in `./registry.ts`.
 */
export const INTERVENTION_PHASES = ["pre", "post"] as const;
export type InterventionPhase = (typeof INTERVENTION_PHASES)[number];

/**
 * Who the finding is addressed to.
 *
 * `orchestrator` for flow findings — whoever runs the queue is the only
 * party that can spawn a reviewer or start the next step. `agent` for
 * hygiene and correctness — the actor is the only party that can tidy up
 * after itself or not run the command.
 */
export const INTERVENTION_AUDIENCES = ["orchestrator", "agent"] as const;
export type InterventionAudience = (typeof INTERVENTION_AUDIENCES)[number];

/**
 * The response ladder, weakest to strongest.
 *
 * **Prominence is a property of the message, not a level.** Every entry
 * stores a plain and a prominent message and the front end picks between
 * them; both are still `nudge`. Keeping the enum this small is what stops
 * "how alarming is it" being confused with "does it stop me".
 */
export const INTERVENTION_LEVELS = ["nothing", "nudge", "block-overridable", "hard-block"] as const;
export type InterventionLevel = (typeof INTERVENTION_LEVELS)[number];

/** Whether an entry fires at once or rides the next digest (~5 minutes). */
export const INTERVENTION_TIMINGS = ["immediate", "digest"] as const;
export type InterventionTiming = (typeof INTERVENTION_TIMINGS)[number];

/** Where an entry came from. `custom` is not built yet; the field is. */
export const INTERVENTION_SOURCES = ["builtin", "custom"] as const;
export type InterventionSource = (typeof INTERVENTION_SOURCES)[number];

/** The levels that stop a call, as opposed to talking about it. */
const BLOCKING_LEVELS: ReadonlySet<InterventionLevel> = new Set<InterventionLevel>([
  "block-overridable",
  "hard-block",
]);

export function isBlockingLevel(level: InterventionLevel): boolean {
  return BLOCKING_LEVELS.has(level);
}

/**
 * The two default messages an entry ships with.
 *
 * Both are required. An entry with only a plain message would leave the
 * front end nothing to escalate to, and an entry with only a prominent one
 * would shout on every delivery — and shouting on every delivery is
 * indistinguishable, to the reader, from not being worth reading.
 */
export interface InterventionMessages {
  readonly plain: string;
  readonly prominent: string;
}

/** One working tree that more than one of a crew's items is claimed in. */
export interface SharedTree {
  /**
   * The path as the claim recorded it — **raw, never normalised.**
   *
   * Its only consumer is a message a person or an agent reads, and the point
   * of showing it is that they can compare it against what they believe
   * their checkout to be. See `claimedWorktree` for the full reasoning: a
   * normalised form is the right thing to compare and the wrong thing to
   * display.
   */
  readonly worktree: string;
  /** The items claimed in it, sorted. More than one is what makes it shared. */
  readonly itemIds: readonly string[];
}

/** Where a crew's live claims sit on disk — see `crewTerritory`. */
export interface CrewTerritory {
  /** Every tree holding more than one item. Empty means none were found. */
  readonly sharedTrees: readonly SharedTree[];
  /**
   * How many live claims recorded no worktree at all.
   *
   * Non-zero means the overlap check is **incomplete**, not that it passed.
   * A predicate must not read an empty `sharedTrees` as "disjoint" while
   * this is above zero.
   */
  readonly unrecordedWorktrees: number;
}

/**
 * What a predicate is handed.
 *
 * Deliberately a plain, serialisable value: it is what an external script
 * would receive on stdin. Every field is optional because every one comes
 * from a different place and any may be absent — an absent field means
 * "not known", which a well-written predicate answers with `triggered:
 * false` rather than by guessing.
 *
 * This will grow as the catalogue does (item state, claim state, review
 * artifacts, budget). What must not grow is its *kind*: it stays data
 * handed in, never a handle something can be fetched through.
 */
export interface InterventionContext {
  /** The session whose call is being evaluated. */
  readonly sessionId?: string;
  /** The tool being called, e.g. `Bash`. */
  readonly tool?: string;
  /** The command text, when the tool carries one. */
  readonly command?: string;
  /** Whether the session is acting as an orchestrator with crew beneath it. */
  readonly isOrchestrator?: boolean;
  /** The working directory the call was made from, when known. */
  readonly cwd?: string;
  /** Whether that directory is a linked git worktree with its own index. */
  readonly isLinkedWorktree?: boolean;
  /**
   * The working tree this session's claim recorded, as the claim spelled it.
   *
   * The **raw** value rather than the normalised one, because its only
   * consumer is a message shown to a person or an agent, and the point of
   * showing it is that they can compare it against what they believe their
   * checkout to be. A normalised form is the right thing to *compare* and
   * the wrong thing to *display*: lowercased and slash-flipped, it stops
   * resembling the string the caller sent, which invites exactly the "the
   * guard sees something I do not" reading that makes a refusal expensive.
   *
   * Absent when the claim recorded no worktree, which is common — the field
   * is optional on `claim`.
   */
  readonly claimedWorktree?: string;
  /**
   * The item this session holds a claim on, when it holds one.
   *
   * A string, matching `Item.id` in the schema. It was declared `number`
   * when nothing assembled a context and no predicate had ever been handed
   * a real one — an id typed against no data, which typechecked precisely
   * because no caller existed to disagree with it. The first assembler
   * found it immediately.
   */
  readonly itemId?: string;
  /** The item's state, when an item is in play. */
  readonly itemState?: string;
  /** Whether an approving review artifact exists at the current tip. */
  readonly hasApprovalAtTip?: boolean;
  /**
   * Whether an approving review artifact exists on this item **at all**,
   * regardless of round or tip.
   *
   * The companion to `hasApprovalAtTip`, and the pair is what separates two
   * situations that a single field conflated into one refusal:
   *
   *   - **Never approved** (`hasAnyApproval === false`) — nothing has ever
   *     reviewed this work. A merge here is an unreviewed merge, which is
   *     the situation worth blocking.
   *   - **Approved, but not at the tip** (`hasAnyApproval === true`) — a
   *     review exists and does not stand at the tip. Usually nothing about
   *     the code changed: recording a `check_run` or a commit artifact
   *     after an approval raises the item's review round and demotes that
   *     approval on its own. That is a bookkeeping artefact rather than unreviewed
   *     work, and blocking on it produced fourteen false refusals for one
   *     true catch.
   *
   * Absent, like every optional field here, means the server did not ask —
   * never "no". Read it strictly against `true`/`false`.
   */
  readonly hasAnyApproval?: boolean;
  /**
   * The default branch of the repository the claimed item belongs to.
   *
   * Absent means **unknown**, and it is unknown far more often than one
   * would expect: `Repo.defaultBranch` is deliberately nullable
   * (MILESTONES.md #124) so that a repository nobody could inspect records
   * "unknown" rather than a guessed constant. An entry that needs to know
   * which branch is protected must treat absence as "cannot tell" — a
   * check that assumed a name here would silently be guarding the wrong
   * branch on every repository that never recorded one.
   */
  readonly defaultBranch?: string;
  /**
   * Whether this session holds a live claim on any item — I13.
   *
   * Distinct from `itemId` being present, and the distinction is the entry.
   * `itemId` is absent both when the session holds nothing *and* when the
   * assembler never asked, because the assembly is gated on the call being
   * able to need it. A predicate keyed on `itemId === undefined` would
   * therefore fire on every unclaimed call the gate declined to look up —
   * which is most calls in the system. This field is written only by a
   * lookup that actually ran, so `false` means "asked, and it holds
   * nothing" rather than "did not ask".
   */
  readonly holdsClaim?: boolean;
  /**
   * The role this session holds its item in, when it holds one — I14.
   *
   * `Assignment.role`, carried through as a plain string rather than as the
   * schema's enum: this module is the boundary an external predicate reads,
   * and a value it can compare against a literal is worth more here than a
   * type it would have to import. A role this build does not recognise is
   * therefore not an error — it arrives as itself and matches nothing.
   */
  readonly claimedRole?: string;
  /**
   * How much hands-on editing this session has been doing lately — I14.
   *
   * The existing shape reading (`../telemetry/shape.ts`), not a second
   * measure invented for this entry, so that a session is never told it is
   * elevated by one reading and normal by another. `"unknown"` is a real
   * answer meaning too little evidence, and a predicate must not read it as
   * `"normal"` — the distinction is the whole reason that vocabulary has
   * three values rather than two.
   */
  readonly handsOnWork?: "unknown" | "normal" | "elevated";
  /**
   * Another live crew already holding this same checkout — I15.
   *
   * Present only when one exists, and it describes a *different* root
   * session: a worker its own orchestrator spawned shares the checkout
   * legitimately and must never block itself, which is why the assembler
   * compares roots rather than sessions. Absent means either nobody else
   * holds it or the server could not tell, and a predicate reads both the
   * same way — no finding.
   */
  readonly occupyingCrew?: OccupyingCrew;
  /**
   * How many items are in flight awaiting a visual review right now.
   *
   * `Item.needsVisualReview` is true and no visual review has landed yet,
   * counted across the board rather than for this session — the whole point
   * of the entry it serves is concurrency, which is a property of the queue
   * and not of any one item.
   *
   * Absent means the server did not count, which reads as "cannot tell" and
   * produces no finding. A count of 1 is also silent: one pending visual
   * review is not a batching opportunity, it is just a review.
   */
  readonly pendingVisualReviews?: number;
  /**
   * Tools an earlier agent on this item reported it could not use — I19,
   * written by `report_blocked_on_tool`.
   *
   * **This is not the spawn's tool list, and the difference is the entry.**
   * The catalogued I19 asks whether the agent being spawned right now has
   * what its job needs, which this server cannot answer: it never observes
   * a spawn's tool grant, and `builtins.ts` records that gap rather than
   * papering over it. What it *can* see is that an earlier agent on this
   * same item already stopped and said a named tool was unusable — a fact
   * established by a call rather than inferred, and one the orchestrator is
   * demonstrably about to repeat if it dispatches again without acting on it.
   *
   * Absent means the server did not look, or looked and found none; a
   * predicate reads both as no finding. Empty is never written for the same
   * reason every other field here stays absent rather than defaulted.
   */
  readonly unresolvedToolBlocks?: readonly UnresolvedToolBlock[];
  /**
   * How many items this session's crew is holding at once, counting only
   * live assignments held by agents under the same root session.
   *
   * Scoped to the **crew**, not to the whole board, and that is the
   * difference between a signal and a noise source. A board-wide count of
   * concurrent agents says nothing about whether *this* orchestrator is
   * over-extended — several orchestrators each running two crews is a busy
   * system working correctly. A count under one root session is the one
   * this entry can act on, because the reader is the party who can stage
   * the wave.
   *
   * Absent means the server did not count — never zero. A session holding a
   * claim always counts at least itself, so a genuine zero cannot occur on
   * the path that assembles it.
   */
  readonly concurrentCrewItems?: number;
  /**
   * Where this crew's live claims actually sit on disk.
   *
   * The owner's correction to the wide-crew nudge: *"I think this should
   * only be if those 3 are on the same worktree… there's no need to be
   * cautious if they are on separate worktrees."* Width alone says nothing
   * about whether two crews can commit over each other, and a nudge that
   * fires on three crews in three separate trees is telling a careful
   * orchestrator to go and check something it already got right.
   *
   * ── Why both halves are needed ─────────────────────────────────────────
   *
   * `worktree` is **optional** on `claim`, so "no shared tree was found" has
   * two very different causes: every claim recorded a path and they differ,
   * or some claim recorded nothing and the comparison could not be made.
   * Reporting only the overlaps would collapse those into one answer and
   * silence the entry exactly where it knows least. So the unrecorded count
   * travels alongside, and the entry says plainly that it could not rule a
   * conflict out.
   */
  readonly crewTerritory?: CrewTerritory;
  /**
   * How many crew under this session's root are **genuinely running right
   * now**, excluding the session itself.
   *
   * ── Why this is not `concurrentCrewItems`, which it sits beside ────────
   *
   * The two look alike and answer different questions. `concurrentCrewItems`
   * counts *items* a crew holds, to judge how wide a wave is; this counts
   * *holders still working*, to judge whether anyone is still out there. An
   * orchestrator whose six crew have all finished still holds six items and
   * has nobody running — the first number says "wide", the second says
   * "nothing to wait for", and an entry that asked the first while meaning
   * the second would nudge a crew that had already come home.
   *
   * **Excludes the asking session**, which is what makes zero meaningful. A
   * session assembling this context is by definition running, so counting
   * itself would make the number never zero and the signal never false.
   *
   * ── "Genuinely live" means the Fleet page's notion, not the column ─────
   *
   * `Assignment.liveness` is a **stored** column advanced only by the sweep
   * (`../liveness.ts`), so between passes it reports the previous pass's
   * verdict. Reading it alone is exactly the bug #400 fixed: the Fleet page
   * showed "Running (27)" for claims that had been gone for days. So the
   * same two-part test `bandOf`/`isOverdueForSweep` (`../fleet/view.ts`) now
   * uses applies here — the row must still say `running` **and** its
   * `lastActive` must be newer than `liveness.dead_after_seconds`. A third
   * competing definition of liveness is how the four tip-comparison call
   * sites drifted apart, and this deliberately declines to open a fourth.
   *
   * ── Absent is "not known", and stays distinguishable from zero ─────────
   *
   * Absent means the server never counted — a call the gate declined to
   * look up, or a session with no claim to find crew under. `0` is a real
   * answer meaning it counted and nobody is running. A predicate must read
   * `undefined` as no-finding rather than as "no crew", because the two
   * lead to opposite advice: one is "I cannot tell", the other is "you are
   * free to stop".
   */
  readonly crewInFlight?: number;
  /**
   * Whether this item needs a visual review, is closing or closed without
   * one, and nothing links the review that will carry it out.
   *
   * A single boolean rather than its three parts, because no entry has a
   * use for the parts: the finding is the conjunction, and exposing the
   * components would invite a second entry to recombine them differently
   * and disagree with this one.
   *
   * Absent means the server did not ask — never "no". A `false` is a real
   * answer: the question was asked and the item is fine.
   */
  readonly visualReviewDeferredUnrecorded?: boolean;
  /**
   * Whether this call puts a question to the person and waits for an
   * answer.
   *
   * Read off the tool name, so it costs no lookup — which is what lets I31
   * fire on a path that has no claim and no item, the common case for a
   * session that has stopped to ask something.
   *
   * **It says a question is being asked, never that it was unjustified.**
   * No field here can carry the second, and the entry that reads this is
   * written around that limit rather than pretending past it.
   */
  readonly isAskingUser?: boolean;
  /**
   * Where the item's committed work has got to on its way to being merged —
   * I26 and I27.
   *
   * One value rather than two booleans, because the two questions the
   * entries ask are **stages of one pipeline** and reading them as
   * independent flags produces a state that cannot exist: "has a pull
   * request but no commit" is not a situation, and a predicate keyed on a
   * pair of booleans has to remember not to handle it. A stage names where
   * the work actually stopped, so each entry matches the one stage it is
   * about and is silent everywhere else — including on the stages *after*
   * its own, which is what stops I26 firing for the whole life of an item
   * that went on to open a pull request perfectly well.
   *
   * Absent means the server did not look, or the item has no commit
   * artifact at all — read as no finding, like every other optional field
   * here. An item nobody has committed to has not stalled on its way to a
   * pull request; it has not started.
   */
  readonly deliveryStage?: DeliveryStage;
  /**
   * How long ago this item's newest `pull_request` artifact was recorded.
   *
   * The owner's refinement to `pull-request-with-no-review-requested`: *"I
   * think it should be shortly after a PR was created and no reviewer has
   * been dispatched… I bias towards shortly after, giving the agent a chance
   * to go through its flow naturally."* Without an age the entry fires on
   * the first digest after the pull request exists — including when the
   * agent was about to call `request_review` on its very next call, which is
   * nudging somebody for not yet having done what they are in the middle of
   * doing.
   *
   * Present only at the `pull_request_open` stage, since it is the only
   * stage where the question is asked. Absent means the age could not be
   * established, which a predicate must read as **cannot tell** rather than
   * as old enough to speak — the same discipline every field here takes.
   */
  readonly pullRequestAgeSeconds?: number;
  /**
   * A merged review whose nits nothing is tracking — I28.
   *
   * Present only when the situation is live: the item's governing review
   * carried `lgtm_with_nits` **with** findings, and no follow-up item is
   * linked to it. Absent covers every other case — no review, a different
   * verdict, a nits verdict that recorded no findings, or findings that
   * already have somewhere to go.
   *
   * Carries the count because the message's whole job is to say how many
   * observations are about to age out with a closed row, and "nine
   * findings" is a different sentence from "a finding".
   */
  readonly untrackedNits?: UntrackedNits;
}

/**
 * How far an item's committed work has got toward being merged.
 *
 * Deliberately a small closed vocabulary rather than a set of flags, so a
 * predicate compares against a literal and an unrecognised value — from a
 * newer server talking to an older predicate — matches nothing rather than
 * being read as one of the others.
 *
 *   - `committed` — a commit artifact exists and no pull request does.
 *   - `pull_request_open` — a pull request exists, and nothing has asked
 *     for a review of it.
 *   - `review_requested` — a review has been requested. Nothing further to
 *     say: from here the existing flow entries (I1) take over.
 */
export const DELIVERY_STAGES = ["committed", "pull_request_open", "review_requested"] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

/**
 * A `lgtm_with_nits` review whose findings nothing is tracking, as a
 * predicate needs it.
 *
 * `findingCount` rather than the findings themselves: the entry's message
 * names a number and points at the artifact, and carrying the text of every
 * finding through the context would put review prose into a nudge that has
 * no room for it — and into the event payload the firing is recorded on.
 */
export interface UntrackedNits {
  /** How many findings that review recorded. Never zero — absent instead. */
  readonly findingCount: number;
  /** The review round the verdict was given at, so the message can point at it. */
  readonly reviewRound?: number;
}

/**
 * One earlier report that a tool could not be used, as a predicate needs it.
 *
 * Carries `reason` because the remedy differs by it and the message says so:
 * a tool that was never granted needs an edit to the agent definition — which
 * only takes effect in a **new session** — while a tool that was granted and
 * refused needs a different call or a handover of the claim, and editing the
 * tool list would change nothing at all.
 */
export interface UnresolvedToolBlock {
  /** The tool the earlier agent could not use. */
  readonly tool: string;
  /** Why, as that agent classified it. `unknown` when it could not tell. */
  readonly reason: string;
  /** What the brief had asked it to do with the tool. */
  readonly needed?: string;
}

/**
 * Who else is working in a checkout, as a predicate needs to see them.
 *
 * Enough to *name* the holder rather than merely refuse: `INTERVENTIONS.md`
 * asks I15's message to say who holds it, which item, which branch and how
 * long ago they were last active, because a refusal that says only "someone
 * else is here" leaves the caller with no move except to override it.
 */
export interface OccupyingCrew {
  /** The root session of the crew holding it. */
  readonly rootSessionId: string;
  /** The item they hold, so the caller can look it up. */
  readonly itemId: string;
  /** The branch they are on, when the claim recorded one. */
  readonly branch?: string;
  /** Seconds since that crew was last active. */
  readonly lastActiveSecondsAgo?: number;
}

/**
 * What a predicate returns. The *whole* of what it may produce.
 *
 * `level`, `message` and `data` are all optional overrides on a triggered
 * finding — the registry supplies the configured defaults for anything the
 * predicate does not name. A predicate that only answers "yes, this is
 * happening" is a complete and normal predicate.
 */
export interface InterventionVerdict {
  readonly triggered: boolean;
  /** Overrides the entry's configured level for this one firing. */
  readonly level?: InterventionLevel;
  /** Overrides the entry's message for this one firing. */
  readonly message?: string;
  /** Anything worth recording on the resulting event. Must be serialisable. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * A predicate: context in, verdict out.
 *
 * Pure and time-bounded by contract — no writes, no I/O, no clock of its
 * own. That is the sandbox an external script needs, and enforcing it on
 * built-ins from the start is what makes the boundary real instead of
 * retrofitted. It may be async so that an external process can eventually
 * be one without changing this type.
 */
export type InterventionPredicate = (
  context: InterventionContext,
) => InterventionVerdict | Promise<InterventionVerdict>;

/** One entry in the registry. */
export interface Intervention {
  readonly id: string;
  readonly source: InterventionSource;
  /** A one-line statement of the situation, for the settings page. */
  readonly summary: string;
  readonly phase: InterventionPhase;
  readonly audience: InterventionAudience;
  readonly defaultLevel: InterventionLevel;
  readonly defaultTiming: InterventionTiming;
  readonly messages: InterventionMessages;
  readonly predicate: InterventionPredicate;
}

/**
 * An installation's overrides for one entry. Every field is optional; an
 * absent field tracks the product's default, which is what lets a later
 * release retune a message or retire an entry without a migration.
 */
export interface InterventionOverride {
  readonly enabled?: boolean;
  readonly level?: InterventionLevel;
  readonly timing?: InterventionTiming;
  readonly messages?: Partial<InterventionMessages>;
}

/**
 * A finding: an entry that triggered, resolved against its configuration.
 *
 * This is what the registry produces and what a caller acts on. Note it
 * carries no channel and no rendering — deciding *how loudly* to say it is
 * the front end's call between `messages.plain` and `messages.prominent`.
 */
export interface InterventionFinding {
  readonly id: string;
  readonly source: InterventionSource;
  readonly phase: InterventionPhase;
  readonly audience: InterventionAudience;
  readonly level: InterventionLevel;
  readonly timing: InterventionTiming;
  readonly messages: InterventionMessages;
  readonly data?: Readonly<Record<string, unknown>>;
}
