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
