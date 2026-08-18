// Guard — hierarchy: a parent cannot finish while a child is still
// actionable. See docs/plans/MILESTONES.md #19, SCHEMA.md §5a, §1.1,
// DECISIONS.md §13c.
//
// SCHEMA.md §5a states the rule for a `not_done` follow-up and then extends
// it up the tree in the same sentence: "an item cannot complete while any
// child is actionable — every child must be completed, blocked or paused."
// That is the rule this guard enforces, generalised from "a linked follow-up
// item" to "any child row in the tree" — the same test, run against the
// `items.parent_id` relationship instead of a `not_done` entry's `item_id`.
import { guardOk, guardRejected, type Guard, type GuardInput } from "../state-machine/guard";
import { NOT_ARCHIVED_CONDITION } from "../items/row";

/**
 * The four states SCHEMA.md §1.1's "Completed" column and §16's `blocked`/
 * `paused` handling put outside "still needs doing": `merged`, `research_done`,
 * `wont_do`, `cancelled` (finished, one way or another) plus `blocked` and
 * `paused` (waiting on something outside the agent's control, not on more
 * work). Everything else — `someday`, `on_deck`, `planning`, `plan_review`,
 * `executing`, `in_review` — is **actionable**: there is more for an agent to
 * do on it right now, with nothing external in the way.
 *
 * This is the same set `transition.ts`'s `completedStates` names for
 * `merged`/`research_done`/`wont_do`/`cancelled` (clearing `blocked`/`paused`
 * fields on exit), plus `blocked` and `paused` themselves — re-declared here
 * rather than imported, because this guard's question ("is this state
 * actionable") is a different cut of the vocabulary than `applyTransition`'s
 * ("does entering this state stamp `completedAt`"), and the two sets
 * happening to differ by exactly `{blocked, paused}` is a fact about the
 * vocabulary, not a relationship either module should depend on the other to
 * maintain.
 */
const NON_ACTIONABLE_STATES: ReadonlySet<string> = new Set([
  "blocked",
  "paused",
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

function isActionable(state: string): boolean {
  return !NON_ACTIONABLE_STATES.has(state);
}

/** The four states this guard's `appliesTo` fires on entering. */
const COMPLETED_STATES: ReadonlySet<string> = new Set([
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

interface ChildStateRow {
  state: string;
}

/**
 * Whether `itemId` has at least one **direct** child in an actionable state.
 *
 * Direct children only — not the whole subtree — and that is deliberately
 * sound rather than a narrowing of the rule, by induction on this same
 * guard: nesting is unbounded (SCHEMA.md §1's `kind` note — depth ≥ 2 is
 * still `subtask`), so a grandchild is a child of a child. That inner child
 * can only itself be sitting in a completed state — the one state family
 * that would make it invisible to a direct-children-only check on its
 * parent — if *it* passed this exact guard when *it* finished, which means
 * *its* children (the grandchildren) were already required to be
 * non-actionable at that point. A live grandchild therefore always keeps its
 * immediate parent non-actionable first, and transitively blocks the
 * grandparent's finish too, without this query ever walking more than one
 * level down. What this check does not see: an in-progress child's
 * *grandchildren* directly — it only ever queries `parent_id = itemId`, one
 * level, on every call, and never queries "any descendant" as a single
 * recursive shape.
 */
async function hasActionableChild(db: GuardInput["db"], itemId: string): Promise<boolean> {
  // Archived children are not asked about (MILESTONES.md #137). An archived
  // row is one the installation has said should never have existed, and it
  // will never be transitioned again because no ordinary read can reach it
  // to transition — so counting it as actionable would block its parent from
  // ever finishing, citing a child the caller cannot see, cannot open, and
  // cannot move. That is a deadlock, not a guard.
  //
  // The induction in this function's header survives the exclusion. It turns
  // on a live grandchild keeping its immediate parent non-actionable, and an
  // archived item has no bearing on that: a live child is still asked about
  // here whatever its own children are doing, and archiving is never applied
  // to a row on behalf of its descendants.
  const rows = await db.$queryRawUnsafe<ChildStateRow[]>(
    `SELECT "state" FROM "Item" WHERE "parentId" = $1 AND ${NOT_ARCHIVED_CONDITION}`,
    itemId,
  );
  return rows.some((row) => isActionable(row.state));
}

/**
 * Registered as `hierarchy.no_finish_with_actionable_child`.
 *
 * `appliesTo` fires on **entering** any completed state, from anywhere —
 * SCHEMA.md §16's table reads transitions by "Entering", not by a specific
 * `(from, to)` pair, and this rule is no exception. It never fires for a
 * `project`: `transition.ts`'s `evaluate()` refuses a transition against a
 * project's own state before any guard is asked anything (DECISIONS.md
 * §13c — "a project's column is computed on read, so guards never run
 * against a project's own state"), so this guard is only ever asked about a
 * `task` or `subtask` finishing — which is exactly the shape it needs: it
 * queries that item's own children, and a project's "children" (its tasks)
 * are reached the same way, as the children of whichever task or subtask is
 * actually transitioning.
 */
export const hierarchyGuard: Guard = {
  id: "hierarchy.no_finish_with_actionable_child",
  description:
    "A parent cannot finish while a child is still actionable (SCHEMA.md §5a) — every child must " +
    "already be completed, blocked or paused.",
  appliesTo: (_from, to) => COMPLETED_STATES.has(to),
  async check(input: GuardInput) {
    const actionable = await hasActionableChild(input.db, input.item.id);
    if (actionable) {
      return guardRejected(
        "This item has a child that is still actionable. Every child must be completed, blocked " +
          "or paused before this item can finish.",
        { fields: ["parent_id"] },
      );
    }
    return guardOk;
  },
};
