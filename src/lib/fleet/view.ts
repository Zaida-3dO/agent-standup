// The fleet page's display derivations — M10 T16.
//
// Plain functions over plain data, so this repo's DOM-free harness
// (`vitest.config.ts`: `environment: "node"`) can exercise them directly —
// the same split `src/lib/board/view.ts` and `src/lib/since/view.ts`
// follow. The components under `src/components/fleet/` are the thin
// presentational layer over these.
//
// **Grouping and filtering both happen here, client-side, over the one
// full list `get_fleet` already returned.** The operation takes no
// filter — every live assignment in the installation is, by construction,
// a small list (bounded by how many sessions can hold work at once, not by
// how large the item store is), so there is nothing to page and nothing
// gained by pushing the filter to the server.
import type { FleetAssignment, Liveness } from "./types";

/**
 * The display-only band key. Every `Liveness` value is a band, plus one that
 * is **not** a liveness value and deliberately cannot be: `overdue`.
 *
 * `Liveness` is the stored `Assignment.liveness` column's type, shared with
 * the board. `overdue` is a band the fleet page *derives* at render time from
 * `lastActive` and the dead threshold — nothing writes it, no row holds it,
 * and adding it to `Liveness` would claim the sweep can produce a rung it
 * cannot. Keeping it out of that union is what stops this display concern
 * from leaking into the ladder.
 */
export type FleetBand = Liveness | "overdue";

/** Bands in the order the fleet page groups and shows them. */
export const LIVENESS_BANDS: readonly FleetBand[] = [
  "running",
  "overdue",
  "stalled",
  "dead",
  "superseded",
];

const LIVENESS_LABELS: Readonly<Record<FleetBand, string>> = {
  running: "Running",
  overdue: "Overdue for sweep",
  stalled: "Stalled",
  dead: "Dead",
  superseded: "Superseded",
};

export function livenessLabel(liveness: FleetBand): string {
  return LIVENESS_LABELS[liveness];
}

/** One band, with its assignments in the order the read returned them. */
export interface FleetGroup {
  readonly liveness: FleetBand;
  readonly label: string;
  readonly assignments: readonly FleetAssignment[];
}

/**
 * The band a row belongs in: its stored liveness, **except** that a row the
 * sweep would already have moved is banded `overdue` instead.
 *
 * This is the fix for the count Ope could not trust. `Assignment.liveness` is
 * a stored column advanced only by the sweep, so between sweeps it reports
 * the last sweep's verdict, not the current one — and with no sweep ever
 * having run, it reported "running" for sessions that had been gone for days.
 * The page already knew better per-row (`isOverdueForSweep` drew the flag on
 * the row) while the heading above went on counting those same rows under
 * "Running". Banding here is what makes the heading agree with the flag.
 */
export function bandOf(
  assignment: FleetAssignment,
  now: number,
  deadAfterSeconds: number,
): FleetBand {
  return isOverdueForSweep(assignment, now, deadAfterSeconds) ? "overdue" : assignment.liveness;
}

/**
 * Groups assignments by band, in `LIVENESS_BANDS` order — **every band
 * present, even empty ones.** A `dead` band that disappears when nothing is
 * dead is exactly the state this screen exists to make visible reliably: a
 * reader scanning for "is anything dead right now" should see "Dead (0)"
 * rather than wonder whether the band was ever going to render at all.
 *
 * Takes `now` and `deadAfterSeconds` because the `overdue` band is derived
 * rather than stored — see `bandOf`. They are required rather than optional
 * on purpose: an overload defaulting to "band by the stored column" would let
 * a caller opt back into a count that cannot be trusted simply by not passing
 * them, and a correctness property that holds only when the caller remembers
 * an argument is not a property.
 */
export function groupByLiveness(
  assignments: readonly FleetAssignment[],
  now: number,
  deadAfterSeconds: number,
): FleetGroup[] {
  const bands = assignments.map((a) => bandOf(a, now, deadAfterSeconds));
  return LIVENESS_BANDS.map((liveness) => ({
    liveness,
    label: livenessLabel(liveness),
    assignments: assignments.filter((_, i) => bands[i] === liveness),
  }));
}

/** Every distinct machine name across the assignments, sorted — the filter's own option list. */
export function machinesOf(assignments: readonly FleetAssignment[]): string[] {
  return [...new Set(assignments.map((a) => a.machine))].sort((a, b) => a.localeCompare(b));
}

/** Every distinct holder display name across the assignments, sorted — the filter's own option list. */
export function agentsOf(assignments: readonly FleetAssignment[]): string[] {
  return [...new Set(assignments.map((a) => a.displayName))].sort((a, b) => a.localeCompare(b));
}

export interface FleetFilters {
  /** `null` — no filter — matches every machine. */
  readonly machine: string | null;
  /** `null` — no filter — matches every agent. */
  readonly agent: string | null;
}

export const NO_FLEET_FILTERS: FleetFilters = { machine: null, agent: null };

/** Applies both filters. Either or both may be `null`, which excludes it from the match. */
export function filterFleet(
  assignments: readonly FleetAssignment[],
  filters: FleetFilters,
): FleetAssignment[] {
  return assignments.filter((a) => {
    if (filters.machine !== null && a.machine !== filters.machine) return false;
    if (filters.agent !== null && a.displayName !== filters.agent) return false;
    return true;
  });
}

/**
 * A short "how long ago" label — mirrors `relativeTime` in
 * `@/lib/projects/view.ts` exactly (same boundaries, same fallback for an
 * unparseable date), kept as its own copy rather than a shared import
 * because the two modules describe unrelated screens and a change to one's
 * wording should not silently reach the other's tests.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Milliseconds since `lastActive` — the raw age `AgentPresenceDot`'s sibling
 * caption and `StalenessDot` both want, kept separate from `relativeTime` so
 * a caller needing the number (for a threshold, a sort) does not have to
 * parse the label back out of a string.
 */
export function ageMsOf(lastActive: string, now: number): number {
  const then = Date.parse(lastActive);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, now - then);
}

/**
 * Whether an assignment is a dead-but-unswept claim — the exact condition
 * the task's "done when" list names: *"visible as such, rather than looking
 * like live work"*. A row the ladder has already moved to `dead` reads as
 * dead regardless of whether a sweep has run since (the liveness column
 * IS the ladder's verdict); this flags the narrower and more dangerous
 * case — a row still marked `running` or `stalled` whose `lastActive` is
 * already past the point a sweep would move it, so a reader sees the stale
 * claim before the next scheduled sweep gets to it.
 */
export function isOverdueForSweep(
  assignment: FleetAssignment,
  now: number,
  deadAfterSeconds: number,
): boolean {
  if (assignment.liveness === "dead" || assignment.liveness === "superseded") return false;
  return ageMsOf(assignment.lastActive, now) >= deadAfterSeconds * 1000;
}
