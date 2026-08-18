// The shape the project page renders — MILESTONES.md #75, over the
// `GET /api/projects/{id}` response `get_project_detail` produces.
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// the same reason `@/lib/projects/types.ts` and `@/lib/board/types.ts`
// mirror their endpoints by hand: the front end reaches the service layer
// only through the adapter's JSON, never its modules. Importing the
// operation's output type here would couple every component to how that
// operation happens to be typed and — worse — put a module that
// transitively imports the database client's types onto the client
// bundle's import graph, which is exactly what `npm run check:db-imports`
// exists to prevent by accident.
//
// Only the fields the page actually renders are modelled; extra keys the
// response carries are ignored rather than fought with.
import type { BoardAssignment, BoardColumnId, ItemState } from "@/lib/board/types";

export type { BoardAssignment, BoardColumnId, ItemState };

/** Counts of a project's descendants by state — the full vocabulary, so zero is distinguishable from unreported. */
export type StateCounts = Readonly<Record<ItemState, number>>;

/** The project's own identity fields. */
export interface ProjectHeader {
  readonly id: string;
  readonly title: string;
  readonly headline: string | null;
  readonly area: string;
  readonly repo: string | null;
  readonly priority: string;
  readonly kind: string;
}

/**
 * The child a derived reading points at.
 *
 * Its own small shape rather than a whole `ProjectChild`, because the
 * server picks it from a set the client may not have received in full —
 * the causing child can be a grandchild, and `children` holds only direct
 * children.
 */
export interface CausingChild {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly blockedReason: string | null;
}

/**
 * The derived reading and the evidence for it.
 *
 * **The distribution and the causing child are not decoration.** A project
 * has no state of its own; the column is computed from its children, and
 * that computation is lossy in exactly the way that matters — it answers
 * "which column" and discards "made up of what" and "because of which
 * child". Carrying all three together is what makes *"why is this project
 * blocked"* answerable without opening anything.
 */
export interface DerivedStateReading {
  readonly column: BoardColumnId;
  readonly counts: StateCounts;
  /** Null when there are no children — a childless project genuinely has no cause. */
  readonly causingChild: CausingChild | null;
}

/** One direct child, as the children list renders it. */
export interface ProjectChild {
  readonly id: string;
  readonly title: string;
  readonly headline: string | null;
  readonly kind: string;
  readonly state: string;
  readonly priority: string;
  readonly area: string;
  readonly repo: string | null;
  /** Derived by the server: this child's own column, or — for a nested project — one derived from its children. */
  readonly column: BoardColumnId;
  readonly blockedReason: string | null;
  readonly total: number;
  readonly merged: number;
  /** True when this child is itself a project with nothing under it — structurally stuck. */
  readonly childless: boolean;
  readonly updatedAt: string;
  readonly assignments: readonly BoardAssignment[];
}

/** A blocked descendant at any depth — not only a direct child. */
export interface BlockedDescendant {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly blockedReason: string | null;
  readonly blockedOnType: string | null;
  readonly area: string;
  readonly updatedAt: string;
}

/** One entry in the subtree activity feed. */
export interface ProjectActivityEntry {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly body: string | null;
  readonly itemId: string;
  readonly itemTitle: string;
}

/**
 * What a repair of this project would achieve — and what it would not.
 *
 * `historicalVerificationAvailable` is the field the repair UI must not
 * render without: repairing makes an item transitionable, and an item whose
 * work already shipped then meets a merge gate requiring an approving code
 * review. The only honest way past that for already-shipped work is a
 * `historical_verification` artifact, which the merge gate accepts only
 * while a deployment-level window is open. When it is shut, a repair is
 * still worth doing — the item becomes workable — but it cannot be closed,
 * and saying so before the user commits is the whole point of carrying this
 * flag to the client.
 */
export interface RepairAdvice {
  readonly childless: boolean;
  readonly historicalVerificationAvailable: boolean;
}

/** The whole payload. */
export interface ProjectDetail {
  readonly project: ProjectHeader;
  readonly derived: DerivedStateReading;
  readonly total: number;
  readonly merged: number;
  readonly finished: number;
  /** Merged over total, or **null when there are no children** — never zero. */
  readonly progress: number | null;
  readonly childless: boolean;
  readonly lastActivity: string;
  readonly children: readonly ProjectChild[];
  readonly blockedChildren: readonly BlockedDescendant[];
  readonly assignments: readonly BoardAssignment[];
  readonly activity: readonly ProjectActivityEntry[];
  readonly repair: RepairAdvice;
}
