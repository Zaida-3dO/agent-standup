// The guard framework rows #16-#19 (and #21's completion guard) register
// into. See docs/plans/MILESTONES.md #15, SCHEMA.md §16.
//
// A guard is a required-field check, never a forbidden move (PLAN.md
// "Guards live between states, and they're required-fields rather than
// walls"): every `(from, to)` pair is legal, and what a guard may do is
// demand that something be true or present before the move is allowed —
// never refuse a pair outright because of what the pair *is*. There is no
// edge whitelist here for a guard to consult.
import { GuardRejectedError } from "../errors";
import type { TransactionHandle } from "../context";
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
}

/** A guard's verdict. Rejection carries everything `GuardRejectedError` needs. */
export type GuardResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      readonly fields?: readonly string[];
      readonly details?: Readonly<Record<string, unknown>>;
    };

export const guardOk: GuardResult = Object.freeze({ ok: true });

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

/**
 * Runs every guard `appliesTo` selects, in registration order, and stops at
 * the first rejection.
 *
 * Stopping at the first rejection (rather than collecting all of them) keeps
 * one property simple to state and simple to test: the rejection a caller
 * receives is always the rejection of the guard whose `id` it names, with
 * nothing left ambiguous about which rule fired. Ordering guards so the
 * cheapest or most informative check runs first is a registration-time
 * concern, not this function's.
 */
export async function runGuards(
  guards: readonly Guard[],
  input: GuardInput,
): Promise<GuardRejectedError | undefined> {
  for (const guard of guards) {
    const result = await guard.check(input);
    if (!result.ok) {
      return new GuardRejectedError(guard.id, result.message, {
        fields: result.fields,
        details: result.details,
      });
    }
  }
  return undefined;
}
