// The shape the fleet page renders — M10 T16, over the `GET /api/fleet`
// (`get_fleet`) response.
//
// Deliberately its own type rather than an import from `@/lib/service`, for
// the same reason `@/lib/board/types.ts` and `@/lib/item-detail/types.ts`
// mirror their reads by hand: the front end reaches the service layer only
// through the adapter's JSON, never its modules. Extends `DetailAssignment`
// rather than restating its thirteen fields, so the two cannot drift on
// what they share — the fleet row is exactly the detail row plus the one
// fact a detail view does not need: which item this assignment is *on*.
import type { DetailAssignment } from "@/lib/item-detail/types";

export type { Liveness, AssignmentRole, HolderType } from "@/lib/board/types";

/** One live assignment, as the fleet table renders it. */
export interface FleetAssignment extends DetailAssignment {
  readonly itemId: string;
  readonly itemTitle: string;
  readonly itemKind: "project" | "task" | "subtask";
  /** The item's own stored state — a project's is a creation leftover, same caveat as `BoardItem.state`. */
  readonly itemState: string;
}

/** The whole `GET /api/fleet` response. */
export interface FleetResponse {
  readonly assignments: readonly FleetAssignment[];
}
