// What a read returns by default, and how it says what it left out —
// MILESTONES.md #109 parts (2) and (3).
//
// **Part (2): the default slice is open work.** #103 already took terminal
// work out of the default read, and that was not enough. `backlog` is the
// other unbounded column: it grows every time anybody files anything, it is
// never pruned, and nothing in it is being worked on. A caller asking a
// board read with no filters is asking *"what is being worked on"* — in
// flight, in review, blocked, waiting on a person — and the honest default
// answer is those two columns and no others.
//
// So the default is `in_progress` + `waiting`. Backlog is an explicit ask,
// completed is an explicit ask, and finding one specific item is `search`
// rather than either. Note this is a **narrower** default than #103's, and
// deliberately so: "non-terminal" and "open" are different questions, and
// only the second is the one a caller with no filters is actually asking.
//
// **Part (3): a default read says where the rest is.** A narrower default
// that does not announce itself is not a smaller answer, it is a hidden
// one — the caller cannot tell "there is no backlog" from "backlog was
// withheld", and those are opposite facts. Every bounded read therefore
// carries a `notice`: what it withheld, with the counts, naming the call
// that returns it. That is the same self-routing principle #111's refusals
// use, applied to a read that succeeded rather than a call that failed.
//
// The notice is **built from the counts the read already computed**, never
// from a second query and never from a hardcoded sentence. A notice that
// said "backlog via …" while backlog was empty would be noise, and one that
// went stale against the real totals would be worse than none.
import { BOARD_COLUMNS, type BoardColumn } from "./columns";

/**
 * The columns a read with no explicit column request returns — "what is
 * being worked on".
 *
 * `in_progress` covers `planning`/`plan_review`/`executing`/`in_review`;
 * `waiting` covers `paused`/`blocked`, which is the "waiting on a person"
 * half of the same question. Written out rather than derived as "everything
 * except backlog and completed" so that adding a fifth column later is a
 * decision someone makes here, rather than one that silently lands in every
 * default read.
 */
export const OPEN_COLUMNS: readonly BoardColumn[] = Object.freeze([
  "in_progress",
  "waiting",
] as const);

/** The columns a default read withholds, in the order a notice names them. */
export const WITHHELD_COLUMNS: readonly BoardColumn[] = Object.freeze(
  BOARD_COLUMNS.filter((column) => !OPEN_COLUMNS.includes(column)),
);

/**
 * The bound every list-shaped read applies when the caller names none.
 *
 * 25 rather than `list_items`' 50 because a board read fans out across
 * columns: four columns at 50 is the payload this row exists to stop
 * shipping, and one column is a screenful either way. `MAX_PAGE_LIMIT`
 * matches `list_items` and `get_events` — a caller who genuinely wants a
 * big page gets exactly the same ceiling everywhere, so the cap is one
 * number to know rather than three.
 */
export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 200;

/**
 * The default page for a caller that asked for whole records.
 *
 * **A row bound is not a size bound**, which is #107's whole lesson and the
 * reason this constant exists separately. A slim card is a few hundred
 * characters; a full `items` row carrying `body` and `customFields` is
 * measured in kilobytes, so the same 25 rows are a small response in one
 * projection and an unreadable one in the other. Defaulting `full` to the
 * same page size would leave the default read of the heaviest shape over
 * any sensible ceiling — which `tests/bounded-reads.test.ts` catches, and
 * did catch: it is what put this constant here.
 *
 * Three rather than a rounder number because the default read returns
 * *two* columns, so the response is up to six whole records — measured at
 * roughly 24,000 characters on a corpus with realistic bodies, which sits
 * clearly inside the bound rather than against it. A caller who wants more
 * full records asks for them; `full` remains capped by `MAX_PAGE_LIMIT`
 * like anything else. This changes only what a caller gets for *not*
 * choosing, which is the case that has to be safe.
 */
export const DEFAULT_FULL_PAGE_LIMIT = 3;

/** The default page size for a projection — see `DEFAULT_FULL_PAGE_LIMIT`. */
export function defaultLimitFor(full: boolean): number {
  return full ? DEFAULT_FULL_PAGE_LIMIT : DEFAULT_PAGE_LIMIT;
}

/** How a caller reaches one withheld column — the call a notice names. */
const COLUMN_ROUTE: Readonly<Record<BoardColumn, string>> = {
  backlog: 'get_board with column: "backlog"',
  in_progress: 'get_board with column: "in_progress"',
  waiting: 'get_board with column: "waiting"',
  completed: 'get_board with column: "completed"',
};

/** One withheld column and how many items are in it — the input a notice is built from. */
export interface WithheldSection {
  readonly column: BoardColumn;
  readonly total: number;
}

/**
 * The sentence a default read carries: what it showed, what it withheld,
 * and the call that returns each withheld piece.
 *
 * Returns `null` when nothing was withheld — a notice that announced
 * withholding nothing would train callers to stop reading it, which costs
 * exactly the attention the notice exists to buy on the calls that matter.
 * A column that is genuinely empty is not named either, for the same
 * reason: "backlog via …" pointing at zero items is a false lead.
 */
export function buildSliceNotice(
  shown: number,
  withheld: readonly WithheldSection[],
): string | null {
  const nonEmpty = withheld.filter((section) => section.total > 0);
  if (nonEmpty.length === 0) return null;
  const routes = nonEmpty.map(
    (section) => `${section.total} in ${section.column} via ${COLUMN_ROUTE[section.column]}`,
  );
  return `Showing ${shown} open ${shown === 1 ? "item" : "items"}; also ${routes.join(", ")}, or search to find a specific item.`;
}
