// The command-line surface MILESTONES.md #39 delivers: a small, five-status
// task shape routed at the items API (#26, #27) unchanged, kept for one
// release (DECISIONS.md §11 "Import, and going live") and removed at #40.
//
// **"Unchanged" is the whole point of this row**, so this file is the one
// place that shape is written down precisely enough to test against: a
// five-value status vocabulary and six fields, nothing else. It deliberately
// does not grow to cover the item record's other twenty-odd fields —
// growing it would make this a second, richer surface rather than the thin
// compatibility one the row asks for.
//
// The five statuses are not invented here — they are the source store's own
// spelling, exactly as `import-items.ts`'s `STATUS_REMAP` (#10) already
// names them ("the source store this importer reads used a five-value
// status set"). `SHIM_STATUSES` is written out as a literal list rather than
// derived from `STATUS_REMAP`'s keys, because that map is typed
// `Record<string, ItemState>` and a `keyof` off it would widen straight back
// to `string` — but `tests/task-shim-contract.test.ts` asserts the two lists
// are identical, so the two files cannot describe two different
// vocabularies for the one store shape without a test catching it.
import { STATUS_REMAP } from "@/lib/import-items";

export const SHIM_STATUSES = ["todo", "in-progress", "review", "waiting", "done"] as const;

export type ShimStatus = (typeof SHIM_STATUSES)[number];

export function isShimStatus(value: string): value is ShimStatus {
  return (SHIM_STATUSES as readonly string[]).includes(value);
}

/**
 * The item state a status transition targets. Reads `STATUS_REMAP` (#10)
 * directly rather than a second copy of the mapping, so a status this
 * surface accepts and the state the importer would have written for the
 * same word can never drift apart. The non-null assertion is safe exactly
 * because `SHIM_STATUSES` is asserted equal to `STATUS_REMAP`'s keys — see
 * this file's header — so every `ShimStatus` is a key `STATUS_REMAP` has.
 */
export function stateForStatus(status: ShimStatus): string {
  return STATUS_REMAP[status]!;
}

/**
 * The reverse of `STATUS_REMAP`, built once. Several item states have no
 * entry — this surface's vocabulary is five words wide, the item state
 * machine's is eleven-plus — so `statusForState` falls back to the raw state
 * string for anything outside the five. That fallback is deliberate, not a
 * gap: a task that has moved into a state this surface predates (`blocked`,
 * `planning`, …) still has to be listed and shown, and inventing a sixth
 * word for it would be this file quietly growing the vocabulary the row was
 * scoped to leave alone.
 */
const STATE_TO_STATUS: Readonly<Record<string, ShimStatus>> = Object.freeze(
  Object.fromEntries(SHIM_STATUSES.map((status) => [STATUS_REMAP[status], status])),
) as Readonly<Record<string, ShimStatus>>;

export function statusForState(state: string): string {
  return STATE_TO_STATUS[state] ?? state;
}

/** The six-field shape this surface reads and writes — SourceTask's own fields, plus `status`. */
export interface ShimTask {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly repo: string | null;
  readonly area: string;
}

/**
 * Projects an item record (the API's `{ item }`, already unwrapped) down to
 * `ShimTask`. This is the function that makes the difference between a
 * compatibility shim and a pass-through alias: an item record carries
 * `driveMode`, `mergeAuthority`, `blockedReason` and a dozen other fields
 * this surface never had and must never leak — a caller written against the
 * five-field store this surface fronts has no schema for them, and hanging
 * on to extras "just in case" is exactly the drift #39 exists to prevent.
 */
export function toShimTask(item: Record<string, unknown>): ShimTask {
  const state = typeof item.state === "string" ? item.state : "";
  const repo = typeof item.repo === "string" ? item.repo : null;
  return {
    id: typeof item.id === "string" ? item.id : "",
    title: typeof item.title === "string" ? item.title : "",
    body: typeof item.body === "string" ? item.body : "",
    status: statusForState(state),
    repo,
    area: typeof item.area === "string" ? item.area : "",
  };
}
