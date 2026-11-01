// The guard framework rows #16-#19 (and #21's completion guard) register
// into. See docs/plans/MILESTONES.md #15, SCHEMA.md §16.
//
// A guard is a required-field check, never a forbidden move (PLAN.md
// "Guards live between states, and they're required-fields rather than
// walls"): every `(from, to)` pair is legal, and what a guard may do is
// demand that something be true or present before the move is allowed —
// never refuse a pair outright because of what the pair *is*. There is no
// edge whitelist here for a guard to consult.
//
// The board nudges rather than blocks (the owner's rule for this tracker:
// it should never stand between an agent and closing work, only point it at
// what good practice would supply). So a guard has two ways to say
// "something is missing", split by *why* the missing thing matters:
//
//   - A **nudge** (`guardNudged`): the requirement is about process —
//     evidence the item ought to carry and can still acquire afterwards
//     (a commit artifact, an approving review, a linked follow-up). The
//     transition is applied and the answer carries the guard's message as
//     a warning, so the agent sees the shortfall without being walled off
//     from finishing the work.
//   - A **refusal** (`guardRejected`): reserved for data integrity — an
//     unrecognised stored value, or a claim that would write something
//     false into the ledger. A refusal says the record cannot be made
//     trustworthy at all, not that the work was done in the wrong order.
//
// Which side a branch falls on is decided at the branch, not here: the
// framework carries both verdicts and never infers one from the other.
import { GuardRejectedError } from "../errors";
import type { TransactionHandle } from "../context";
import { log } from "@/lib/log";
import type { SettingsSnapshot } from "@/lib/settings";

/**
 * The row a guard is evaluated against.
 *
 * Deliberately narrow — a guard gets what it needs to decide, not a live
 * Prisma row it could mutate. `kind` is included so a guard *could* check it,
 * but the state machine itself is what enforces "never runs against a
 * project" (see `transition.ts`), so a guard is never actually handed one.
 */
export interface GuardableItem {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly blockedReason: string | null;
  readonly blockedOnType: string | null;
  readonly blockedOnPersonId: string | null;
  readonly unblockAt: Date | null;
  readonly pauseReason: string | null;
  readonly resumeCondition: string | null;
  readonly needsVisualReview: boolean;
  readonly mergeAuthority: string;
}

/** What a guard is asked to decide. */
export interface GuardInput {
  readonly item: GuardableItem;
  readonly from: string;
  readonly to: string;
  /**
   * Fields the caller supplied alongside the transition request — e.g.
   * `blocked_reason` when moving into `blocked`. A guard reads from here,
   * never from a second, separate argument, so rehearsal and a real
   * transition see identically-shaped input.
   */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly db: TransactionHandle;
  readonly settings: SettingsSnapshot;
  /**
   * The call this evaluation belongs to, so a refusal logged here can be
   * matched to the request that provoked it.
   *
   * Optional because a guard's decision must not depend on it: a rule that
   * behaved differently with and without a request id would be a rule the
   * conformance suite could not compare across adapters. It is carried for
   * the log line and read by nothing else — `runGuards` is the only code
   * in the repository that touches it.
   */
  readonly requestId?: string;
}

/**
 * A nudge carried on the transition's answer: the guard's id and the
 * warning it raised. Shaped deliberately small — `guard` because §22's
 * coverage ledger reads guard ids and a caller deciding what to fix needs
 * to know which rule spoke, and no `fields`/`details`: those existed to
 * make a refusal actionable, and a nudge asks for evidence, not a retry.
 */
export interface GuardNudge {
  readonly guard: string;
  readonly message: string;
}

/**
 * A guard's verdict. Three kinds:
 *
 *   - `guardOk` — nothing to say.
 *   - `guardNudged` — the move is allowed and the answer should carry the
 *     message as a warning (process requirements; see this module's header).
 *   - `guardRejected` — the move is refused, and the rejection carries
 *     everything `GuardRejectedError` needs (integrity only).
 */
export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: true; readonly nudge: { readonly message: string } }
  | {
      readonly ok: false;
      readonly message: string;
      readonly fields?: readonly string[];
      readonly details?: Readonly<Record<string, unknown>>;
    };

export const guardOk: GuardResult = Object.freeze({ ok: true });

export function guardNudged(message: string): GuardResult {
  return { ok: true, nudge: { message } };
}

/** Whether an OK verdict is a nudged one (the move proceeds either way). */
export function isNudgedResult(result: GuardResult): result is Extract<
  GuardResult,
  { ok: true }
> & { readonly nudge: { readonly message: string } } {
  return result.ok === true && "nudge" in result;
}

export function guardRejected(
  message: string,
  options: { fields?: readonly string[]; details?: Readonly<Record<string, unknown>> } = {},
): GuardResult {
  return { ok: false, message, ...options };
}

/**
 * A registered rule.
 *
 * `id` is the identifier `GuardRejectedError.guard` carries — the value
 * §22's coverage assertion is computed from, so it must be stable and unique
 * per rule, never derived from message text.
 *
 * `appliesTo` narrows which transitions a guard is even asked about. Most
 * guards care about entering one state (`blocked`, `paused`, a `completed`
 * state) regardless of where the move started; a few care about the specific
 * pair (`executing` **from** `plan-review`). Returning `false` here is not a
 * rejection — it means "this rule has nothing to say", so a guard that never
 * applies to the transition in front of it is invisible to the outcome,
 * exactly as SCHEMA.md §16's table reads ("Entering" / "from X").
 */
export interface Guard {
  readonly id: string;
  readonly description: string;
  appliesTo(from: string, to: string): boolean;
  check(input: GuardInput): GuardResult | Promise<GuardResult>;
}

/**
 * The registry every guard lives in.
 *
 * A class instance rather than a module-level array, so tests can build a
 * scratch registry instead of mutating the shared one — the same shape
 * `service-runtime.test.ts` uses for the operation registry, minus the
 * global-mutation trick, because a guard registry never needs to be reached
 * by name from an adapter the way an operation does.
 */
export class GuardRegistry {
  readonly #guards = new Map<string, Guard>();

  /**
   * Registers `guard`. Throws on a duplicate `id` rather than silently
   * overwriting — two guards sharing an id would make §22's coverage
   * assertion, and any rejection an adapter renders, ambiguous about which
   * rule actually fired.
   */
  register(guard: Guard): void {
    if (this.#guards.has(guard.id)) {
      throw new Error(`A guard named "${guard.id}" is already registered.`);
    }
    this.#guards.set(guard.id, guard);
  }

  /** Removes a guard by id. Used by tests to install and tear down scratch guards. */
  unregister(id: string): void {
    this.#guards.delete(id);
  }

  has(id: string): boolean {
    return this.#guards.has(id);
  }

  /** Every guard whose `appliesTo(from, to)` is true, in registration order. */
  applicable(from: string, to: string): readonly Guard[] {
    return [...this.#guards.values()].filter((guard) => guard.appliesTo(from, to));
  }

  /** Every registered guard, for §22's non-empty-registry assertion and for listings. */
  all(): readonly Guard[] {
    return [...this.#guards.values()];
  }

  size(): number {
    return this.#guards.size;
  }
}

/** The process-wide registry rows #16-#19 and #21 register their guards into. */
export const guardRegistry = new GuardRegistry();

/** What one pass over the applicable guards reports. */
export interface GuardRunOutcome {
  /**
   * The first hard rejection, when some guard refused outright. Absent
   * when every applicable guard was content or nudged — and with nudges
   * collected even when present, so a rehearsal shows what the caller
   * would have been warned about even after clearing the blocker.
   */
  readonly rejection?: GuardRejectedError;
  /** Every process guard that spoke while the move proceeded, in registration order. */
  readonly nudges: readonly GuardNudge[];
}

/**
 * Runs every guard `appliesTo` selects, in registration order.
 *
 * A **nudge does not stop the run** — the point of nudging is that the
 * move proceeds, so the run continues and collects the warning, and a
 * caller with four missing pieces of merge evidence learns all four in one
 * answer rather than one guard-rejection round trip at a time.
 *
 * A hard **refusal still stops at the first one** (and the refusals that
 * remain are integrity-only, decided at the branch — see this module's
 * header). The property that made first-refusal-wins worth having still
 * holds for those: the rejection a caller receives is always the rejection
 * of the guard whose `id` it names, with nothing left ambiguous about
 * which rule fired. Ordering guards so the cheapest or most informative
 * check runs first is a registration-time concern, not this function's.
 *
 * ── Why the refusal is logged *here* ────────────────────────────────────
 *
 * This is where the rule fires and where its reasoning still exists. By the
 * time a refusal reaches an adapter it is a `code`, a `guard` id and a
 * message; the item it was about, the pair it was moving between and the
 * `details` the guard computed are gone. The API responder logs only
 * `internal`, deliberately, so no layer above this one is in a position to
 * write a refusal down with anything in it worth reading — an operator
 * asking "why does that transition keep failing" would have to reproduce it
 * to find out.
 *
 * **At `info`, and that is the whole point of the level.** A guard refusing
 * is the system working, not a fault: PLAN.md's guards are required-field
 * checks, and a required field being absent is an ordinary answer. Logging
 * it at `warn` or `error` would put thousands of correct refusals in the
 * same stream as the failures that need a human, which is how the failures
 * stop being read. At `info` it is on by default (that is the default
 * threshold) and it is where an operator following a stuck item will
 * actually look.
 *
 * `details` is included because it *is* the reasoning — which field was
 * missing, which artifact was looked for. It is already the client-facing
 * extras field (`ServiceErrorOptions.details`: "Never contains
 * credentials"), so logging it discloses nothing the caller was not about
 * to be told; there is no separate operator-only channel being opened
 * here. The `fields` a guard names are logged for the same reason.
 */
export async function runGuards(
  guards: readonly Guard[],
  input: GuardInput,
): Promise<GuardRunOutcome> {
  const nudges: GuardNudge[] = [];
  for (const guard of guards) {
    const result = await guard.check(input);
    if (result.ok === true) {
      if (isNudgedResult(result)) {
        nudges.push({ guard: guard.id, message: result.nudge.message });
        // The same disclosure reasoning that puts refusals in the log at
        // `info` puts nudges there too: the rule fired, its message is the
        // whole of its reasoning, and the caller is about to be handed the
        // same sentence. An operator following a stuck item asks "what did
        // the board tell that agent" — this is where that answer lives.
        log.info("Guard nudged an applied transition.", {
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          guard: guard.id,
          itemId: input.item.id,
          from: input.from,
          to: input.to,
          reason: result.nudge.message,
        });
      }
      continue;
    }
    log.info("Guard refused a transition.", {
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      guard: guard.id,
      itemId: input.item.id,
      from: input.from,
      to: input.to,
      reason: result.message,
      ...(result.fields === undefined ? {} : { fields: [...result.fields] }),
      ...(result.details === undefined ? {} : { details: result.details }),
    });
    return {
      rejection: new GuardRejectedError(guard.id, result.message, {
        fields: result.fields,
        details: result.details,
      }),
      nudges,
    };
  }
  return { nudges };
}
