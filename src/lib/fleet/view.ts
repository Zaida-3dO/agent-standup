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

/** Liveness bands, in the order the fleet page groups and shows them. */
export const LIVENESS_BANDS: readonly Liveness[] = ["running", "stalled", "dead", "superseded"];

const LIVENESS_LABELS: Readonly<Record<Liveness, string>> = {
  running: "Running",
  stalled: "Stalled",
  dead: "Dead",
  superseded: "Superseded",
};

export function livenessLabel(liveness: Liveness): string {
  return LIVENESS_LABELS[liveness];
}

/** One liveness band, with its assignments in the order the read returned them. */
export interface FleetGroup {
  readonly liveness: Liveness;
  readonly label: string;
  readonly assignments: readonly FleetAssignment[];
}

/**
 * Groups assignments by liveness, in `LIVENESS_BANDS` order — **every band
 * present, even empty ones.** A `dead` band that disappears when nothing is
 * dead is exactly the state this screen exists to make visible reliably: a
 * reader scanning for "is anything dead right now" should see "Dead (0)"
 * rather than wonder whether the band was ever going to render at all.
 */
export function groupByLiveness(assignments: readonly FleetAssignment[]): FleetGroup[] {
  return LIVENESS_BANDS.map((liveness) => ({
    liveness,
    label: livenessLabel(liveness),
    assignments: assignments.filter((a) => a.liveness === liveness),
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
