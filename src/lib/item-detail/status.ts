// The status block's derivations — everything *"why is this stuck"* is
// answered from, as plain functions over the detail payload.
//
// The block exists because the answer was already in the data and never in
// one place: ownership is in `assignments`, who had it before is in
// `previousHolders`, what it is waiting on is spread across four columns on
// the item, how long it has sat is a subtraction, and where it got to is
// the newest checkpoint buried in a hundred-entry ledger. A reader
// assembling that themselves is reading a page and inferring; the point of
// the block is that they read one thing.
//
// Pure and DOM-free for this repo's harness (`vitest.config.ts`:
// `environment: "node"`), the same split `view.ts` follows: every decision
// about *what the block says* is asserted here directly, and the components
// are the thin presentational layer over it.
//
// **Nothing here re-derives what the server derived.** The column, the
// assignment split into live-and-released, and each event's stored headline
// all arrive decided. This module folds, formats and orders them.
import { checkpointHeadline } from "./checkpoint-headline";
import { deriveOpenLoops, type OpenLoop } from "@/lib/open-loops";
import type { DetailAssignment, DetailHistoryEntry, DetailItem } from "./types";

/**
 * The four liveness values, with the two things a renderer needs: a word
 * and a shape.
 *
 * **All four are distinct and none is a synonym.** The temptation is to
 * treat `superseded` as a flavour of `dead`, since neither session is
 * working — but a superseded claim is a *handover that went correctly*, and
 * a dead one is a session that stopped without releasing. Rendering them
 * alike reports every normal takeover as a failure, which would make the
 * one signal meaning "somebody should look at this" fire constantly and
 * therefore mean nothing.
 */
export type DetailLiveness = "running" | "stalled" | "dead" | "superseded";

export interface LivenessPresentation {
  /** The word, for the label and the accessible name. Never colour alone. */
  readonly word: string;
  /**
   * The non-colour channel — the shape the dot takes. Colour is not enough
   * on its own: `stalled` amber and `dead` grey are the two most likely to
   * be confused in greyscale or by a colour-blind reader, and they are
   * exactly the pair whose difference decides whether anyone intervenes.
   */
  readonly shape: "filled" | "half" | "hollow" | "ring";
  /** One line of why this matters, for the dot's tooltip. */
  readonly hint: string;
}

const LIVENESS: Record<DetailLiveness, LivenessPresentation> = {
  running: {
    word: "running",
    shape: "filled",
    hint: "This session is still working.",
  },
  stalled: {
    word: "stalled",
    shape: "half",
    hint: "This session has stopped reporting. It may come back.",
  },
  dead: {
    word: "dead",
    shape: "hollow",
    hint: "This session is gone without releasing its claim.",
  },
  superseded: {
    word: "superseded",
    shape: "ring",
    hint: "A takeover replaced this session — a normal handover, not a failure.",
  },
};

/**
 * How a liveness value renders.
 *
 * Falls back to the `dead` presentation for a value this build has never
 * seen, rather than throwing or rendering nothing. A vocabulary that grows
 * server-side should degrade to "we cannot vouch for this session" — which
 * is the honest reading of an unknown value — instead of taking out the one
 * screen that would show what happened.
 */
export function livenessPresentation(liveness: string): LivenessPresentation {
  return LIVENESS[liveness as DetailLiveness] ?? LIVENESS.dead;
}

/** True for a liveness value this build actually knows. */
export function isKnownLiveness(liveness: string): liveness is DetailLiveness {
  return Object.prototype.hasOwnProperty.call(LIVENESS, liveness);
}

/**
 * How a role reads on screen. `visual_reviewer` as "visual reviewer", and a
 * `custom` role as the free text its holder gave it — which is the whole
 * reason `roleCustom` exists, so falling back to the literal word "custom"
 * would show the placeholder instead of the answer.
 */
export function roleLabel(assignment: {
  readonly role: string;
  readonly roleCustom: string | null;
}): string {
  if (assignment.role === "custom" && assignment.roleCustom !== null) {
    return assignment.roleCustom;
  }
  return assignment.role.replace(/_/g, " ");
}

/**
 * The three kinds of blocker, told apart.
 *
 * A discriminated union rather than the raw column plus three optional
 * fields, because the fields that are meaningful differ per kind: only
 * `person` has somebody to name, only `time` has a moment to count down to.
 * Modelling it as one bag would let a renderer print "unblocks at —" on a
 * blocker that has no clock.
 */
export type BlockedOn =
  | { readonly kind: "person"; readonly personId: string | null; readonly reason: string | null }
  | { readonly kind: "external_process"; readonly reason: string | null }
  | { readonly kind: "time"; readonly unblockAt: string | null; readonly reason: string | null }
  | { readonly kind: "unspecified"; readonly reason: string | null };

/**
 * What this item is blocked on, or `null` when it is not blocked.
 *
 * **Keyed on `state`, not on the presence of a reason.** A `blockedReason`
 * left behind by an earlier block is still on the row after the item moves
 * on — the column is not cleared — so reading the reason as the trigger
 * would report a long-unblocked item as blocked. The state is the fact.
 *
 * A blocked item whose `blockedOnType` was never recorded is `unspecified`
 * rather than being quietly filed under one of the three. Guessing would be
 * worse than saying so: a sibling surface routes a person's queue off this
 * distinction, and an item guessed into `person` would land in somebody's
 * inbox on no evidence.
 */
export function blockedOn(item: {
  readonly state: string;
  readonly blockedReason: string | null;
  readonly blockedOnType: string | null;
  readonly blockedOnPersonId: string | null;
  readonly unblockAt: string | null;
}): BlockedOn | null {
  if (item.state !== "blocked") return null;
  const reason = item.blockedReason;
  switch (item.blockedOnType) {
    case "person":
      return { kind: "person", personId: item.blockedOnPersonId, reason };
    case "external_process":
      return { kind: "external_process", reason };
    case "time":
      return { kind: "time", unblockAt: item.unblockAt, reason };
    default:
      return { kind: "unspecified", reason };
  }
}

/** What each blocker kind means in one line — the text beside the treatment. */
const BLOCKED_LABELS: Record<BlockedOn["kind"], string> = {
  person: "Waiting on a person",
  external_process: "Waiting on an external process",
  time: "Waiting on a clock",
  unspecified: "Blocked — on what was not recorded",
};

export function blockedLabel(kind: BlockedOn["kind"]): string {
  return BLOCKED_LABELS[kind];
}

/**
 * The one-line "where is this up to" — the newest checkpoint reduced to a
 * line, or `null` when the item has none.
 *
 * Ends at `checkpointHeadline`, which is the same precedence rule the
 * server applies (a stored headline wins; prose is the floor), so this and
 * every other reader answer identically. A copy of the ternary here would
 * be a second place for that rule to drift.
 *
 * **Newest by event id, not by timestamp.** `id` is monotonic per insert
 * and breaks ties between two checkpoints written inside the same
 * millisecond, which `ts` alone cannot — the same ordering `orientation`
 * uses. Two checkpoints in one millisecond is not hypothetical on a session
 * that batches its writes.
 */
export function latestCheckpoint(
  history: readonly DetailHistoryEntry[],
): { readonly headline: string; readonly ts: string } | null {
  let newest: DetailHistoryEntry | null = null;
  for (const entry of history) {
    if (entry.type !== "checkpoint") continue;
    if (newest === null || compareEventIds(entry.id, newest.id) > 0) newest = entry;
  }
  if (newest === null) return null;
  const headline = checkpointHeadline(newest);
  if (headline === null) return null;
  return { headline, ts: newest.ts };
}

/**
 * Compares two stringified event ids numerically.
 *
 * Via `BigInt` rather than `Number`, because these are `bigint` columns
 * stringified for the JSON boundary and are free to exceed
 * `Number.MAX_SAFE_INTEGER`; past that point `Number` comparison starts
 * reporting distinct ids as equal. A plain string compare would be worse
 * still — it orders "9" after "10".
 *
 * A malformed id sorts as lowest rather than throwing: the ledger is the
 * thing this screen exists to show, and one unparseable row should cost
 * that row's position, not the screen.
 */
function compareEventIds(a: string, b: string): number {
  const left = toBigInt(a);
  const right = toBigInt(b);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

/**
 * The loops still open on this item — an `open_loop` with no matching
 * `open_loop_closed`.
 *
 * Folded client-side from the history already in the payload rather than
 * asked of the server, because `deriveOpenLoops` is pure and the events are
 * already here: a second round trip would buy nothing and could disagree
 * with the ledger rendered beside it.
 *
 * **This inherits the fold's slice caveat, and it is worth stating.**
 * History is capped (`historyLimit`), so a loop whose `open_loop` is older
 * than the returned window is invisible here, while one whose *close* is
 * older still resolves correctly — the fold collects closes first and is
 * order-independent. The failure direction is therefore under-reporting an
 * old loop, never showing a closed one as open, which is the right way
 * round for a list whose whole purpose is "somebody meant to come back to
 * this".
 */
export function openLoops(history: readonly DetailHistoryEntry[]): OpenLoop[] {
  return deriveOpenLoops(history);
}

/**
 * How long since the item was last touched, in milliseconds, given what the
 * caller means by "now".
 *
 * Takes `now` rather than reading the clock, for the reason `StalenessDot`
 * gives for taking a duration: a component that read `Date.now()` would be
 * non-deterministic, would mismatch on hydration, and could not be tested
 * without freezing time. Never negative — an `updatedAt` in the future
 * (clock skew between the writer and this reader) reads as fresh rather
 * than as a negative age that would fall through the staleness bands.
 */
export function ageMsOf(iso: string, now: number): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(now - then, 0);
}

/**
 * Everything the status block renders, derived in one pass.
 *
 * One function rather than the component calling six, so the block's
 * content is assertable as a value — and so a component cannot quietly
 * start deriving a seventh thing inline, where no test would see it.
 */
export interface StatusSummary {
  readonly holders: readonly DetailAssignment[];
  readonly previousHolders: readonly DetailAssignment[];
  readonly blocked: BlockedOn | null;
  readonly checkpoint: { readonly headline: string; readonly ts: string } | null;
  readonly loops: readonly OpenLoop[];
  readonly ageMs: number;
  /** True when nobody holds this item — the state that must render as a sentence, not a blank. */
  readonly unowned: boolean;
}

export function statusSummary(
  detail: {
    readonly item: DetailItem;
    readonly assignments: readonly DetailAssignment[];
    readonly previousHolders: readonly DetailAssignment[];
    readonly history: readonly DetailHistoryEntry[];
  },
  now: number,
): StatusSummary {
  return {
    holders: detail.assignments,
    previousHolders: detail.previousHolders,
    blocked: blockedOn(detail.item),
    checkpoint: latestCheckpoint(detail.history),
    loops: openLoops(detail.history),
    ageMs: ageMsOf(detail.item.updatedAt, now),
    unowned: detail.assignments.length === 0,
  };
}
