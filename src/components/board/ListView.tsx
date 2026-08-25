// The list view — MILESTONES.md T6 §3: "a dense, sortable table as an
// alternative to the kanban … the right shape when a column holds 68
// items."
//
// **Hook-free and prop-driven**, the same way `BoardView.tsx` and
// `AppShellView.tsx` are, and for the same reason: with `environment:
// "node"` and no DOM, a component that takes plain props can be called
// directly as a function and its returned tree inspected, which is what
// actually proves these branches. `ListViewContainer.tsx` is the thin
// client wrapper that fetches and hands this component its props.
//
// **The same set as the kanban, in a different shape.** Every row here
// comes from the same `GET /api/board` response, grouped into the same four
// sections by the same server-side `entry.column`, in the same server-side
// sort order. Nothing is re-filtered, re-grouped or re-sorted on the way —
// see `@/lib/board/list`, whose header says why that is a rule rather than
// an implementation detail. A list showing a set the kanban does not is the
// single defect this view could have that a reader would not notice.
//
// **Why a table and not a stack of cards.** The row this implements says a
// 68-item column is "the wrong shape entirely", and the thing a column
// cannot do is let you compare two rows that are not adjacent. Aligned
// columns can: state, priority, area and owner each sit at a fixed x, so a
// reader scanning for every P0 reads down one narrow strip rather than
// across sixty-eight cards. That is the whole justification for the density
// choices below — one line per row, no card chrome, no per-row padding
// beyond what keeps the text legible.
import Link from "next/link";
import type { BoardLoadState } from "@/lib/board/state";
import type { BoardColumnId, BoardEntry, ItemState } from "@/lib/board/types";
import { listSections, listShown, listTotal } from "@/lib/board/list";
import { waitingTone, needsYou, columnCount } from "@/lib/board/view";
import { hasDistinctHeadline, primaryLine } from "@/lib/item-headline-display";
import { relativeTime } from "@/lib/projects/view";
import { StateChip } from "@/components/chips/StateChip";
import { PriorityChip } from "@/components/chips/PriorityChip";
import { AreaChip } from "@/components/chips/AreaChip";
import { TrustBadge } from "@/components/chips/TrustBadge";
import { AgentPresenceDot } from "@/components/chips/AgentPresenceDot";
import { EmptyState, ErrorState, LoadingState, emptinessOf } from "@/components/states";
import styles from "./ListView.module.css";

export interface ListViewProps {
  readonly loadState: BoardLoadState;
  /** The active profile's id — decides which rows are marked as needing you. */
  readonly personId: string | null;
  /**
   * The clock, sampled once by the container on load — the same reasoning
   * `Board.tsx` gives: reading `Date.now()` during render would produce a
   * different tree on the server than on the client for the same data.
   */
  readonly now: number;
  /** True when a filter is narrowing the board — lets an empty section say the filter did it. */
  readonly filtered?: boolean;
  readonly onClearFilter?: () => void;
  readonly onRetry?: () => void;
  /** Per-section paging, keyed by column exactly as the kanban's is. */
  readonly paging?: ListPagingProps;
}

/**
 * The paging wiring, keyed by column for the same reason `BoardView`'s is:
 * the columns page independently server-side, so a "show more" on Backlog
 * must not put Completed into a loading state.
 */
export interface ListPagingProps {
  readonly onShowMore: (column: BoardColumnId) => void;
  readonly loadingColumns: Readonly<Partial<Record<BoardColumnId, boolean>>>;
  readonly errors: Readonly<Partial<Record<BoardColumnId, string>>>;
}

/**
 * The detail page for a row.
 *
 * **A project goes to `/projects/{id}`, not `/items/{id}`** — the same rule
 * `ItemCard` follows, and for the same reason: a project's stored `state`
 * is a creation leftover (DECISIONS.md §13c), so the item view would render
 * a reading nobody wrote. Duplicated as a two-line function rather than
 * imported from `ItemCard`, which is a component and does not export it.
 */
function detailHref(entry: BoardEntry): string {
  return entry.item.kind === "project" ? `/projects/${entry.item.id}` : `/items/${entry.item.id}`;
}

/**
 * The reason a Waiting row is waiting — the blocked reason or the pause
 * reason, whichever applies.
 *
 * Shown because in a list the tone alone is a thin signal: a card can
 * afford a coloured border, but a table row's colour has to compete with
 * three chips on the same line. The words are what actually answer "why is
 * this here".
 */
function waitingReason(entry: BoardEntry): string | null {
  if (entry.item.state === "blocked") return entry.item.blockedReason;
  if (entry.item.state === "paused") return entry.item.pauseReason;
  return null;
}

export function ListView({
  loadState,
  personId,
  now,
  filtered,
  onClearFilter,
  onRetry,
  paging,
}: ListViewProps) {
  if (loadState.status === "error") {
    return (
      <div className={styles.centered}>
        {/* The message already names the failing call — the same whole
            message the kanban shows, so the two layouts report one failure
            in one set of words. */}
        <ErrorState message={loadState.message} onRetry={onRetry} centered />
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className={styles.list}>
        <LoadingState rows={8} label="list" />
      </div>
    );
  }

  const board = loadState.board;
  const sections = listSections(board);
  const shown = listShown(board);
  const total = listTotal(board);

  return (
    <div className={styles.list}>
      {/* **"Showing N of M" is the list's headline fact**, and the two
          numbers are deliberately different quantities: `shown` counts the
          rows actually rendered, `total` the server's counted totals across
          every column. On a 68-item backlog they disagree, and that
          disagreement is precisely what a reader needs to know before
          concluding the list is complete. */}
      <p className={styles.summary} data-testid="list-summary">
        Showing {shown} of {total}
      </p>
      {sections.map(({ column, title, section }) => {
        const emptiness = emptinessOf({
          shown: section.entries.length,
          total: section.total,
          withheld: section.withheld,
          filtered: filtered ?? false,
        });
        const pageError = paging?.errors[column];
        return (
          <section key={column} className={styles.section} aria-label={title}>
            <h2 className={styles.sectionTitle}>
              {title}
              {/* The server's counted total, never `entries.length` —
                  `columnCount` exists so that "the heading count is the
                  server's total" is a statement a test can make directly
                  (MILESTONES.md #123). */}
              <span className={styles.sectionCount}>{columnCount(section)}</span>
            </h2>

            {emptiness !== null ? (
              <EmptyState
                kind={emptiness}
                noun="item"
                total={section.total}
                {...(onClearFilter ? { onClearFilter } : {})}
                {...(paging ? { onLoad: () => paging.onShowMore(column) } : {})}
              />
            ) : (
              // `role="table"` on a real <table>. The rows are a table
              // because they ARE tabular — four aligned facts per item —
              // and a table gives a screen reader the column headers for
              // free, which a stack of divs has to reproduce by hand and
              // usually does not.
              <table className={styles.table}>
                <thead>
                  <tr>
                    {/* The header row is what makes the aligned columns
                        legible as columns rather than as a coincidence of
                        spacing. `scope="col"` so a screen reader announces
                        the header with each cell. */}
                    <th scope="col" className={styles.colState}>
                      State
                    </th>
                    <th scope="col" className={styles.colPriority}>
                      Priority
                    </th>
                    <th scope="col" className={styles.colTitle}>
                      Item
                    </th>
                    <th scope="col" className={styles.colArea}>
                      Area
                    </th>
                    <th scope="col" className={styles.colOwner}>
                      Owner
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {section.entries.map((entry) => {
                    const tone = waitingTone(entry);
                    const mine = needsYou(entry, personId);
                    const reason = waitingReason(entry);
                    const distinct = hasDistinctHeadline(entry.item);
                    return (
                      <tr
                        key={entry.item.id}
                        className={styles.row}
                        // The amber/red split, carried into the list.
                        // SCHEMA.md §1.1 makes it a property of the DATA,
                        // so a layout that dropped it would be showing a
                        // paused and a blocked row as the same thing.
                        // `data-` rather than a class per tone so the CSS
                        // states the mapping once.
                        {...(tone ? { "data-tone": tone } : {})}
                        {...(mine ? { "data-needs-you": "true" } : {})}
                      >
                        <td className={styles.colState}>
                          {/* A project's own `state` is a creation leftover
                              and NOT its column (`get-board.ts` says so
                              outright), so the chip is withheld for a
                              project rather than printing a reading nobody
                              wrote. The section it sits in still says where
                              it is. */}
                          {entry.item.kind === "project" ? (
                            <span className={styles.projectMark}>Project</span>
                          ) : (
                            <StateChip state={entry.item.state as ItemState} />
                          )}
                        </td>
                        <td className={styles.colPriority}>
                          <PriorityChip priority={entry.item.priority} />
                        </td>
                        <td className={styles.colTitle}>
                          <Link className={styles.rowTitle} href={detailHref(entry)}>
                            {primaryLine(entry.item)}
                          </Link>
                          {/* The source title, only when a headline is
                              standing in for it — the same rule
                              `ItemCard` follows. Rendering it
                              unconditionally would print every plain
                              item's title twice. */}
                          {distinct && (
                            <span className={styles.rowSourceTitle}>{entry.item.title}</span>
                          )}
                          {/* The facts that stop being columns below
                              560px, restated here so a narrow row still
                              carries them. CSS-only: this is always in the
                              tree and `.rowMeta` is `display: none` at
                              full width, where the real columns show it.
                              Rendering it conditionally would need a
                              viewport width during render, which this
                              hook-free component deliberately has not got
                              — and would make the tree differ between
                              server and client for the same data. */}
                          <span className={styles.rowMeta} aria-hidden="true">
                            <AreaChip area={entry.item.area} />
                            {entry.item.repo && (
                              <span className={styles.rowRepo}>{entry.item.repo}</span>
                            )}
                          </span>
                          {reason && <span className={styles.rowReason}>{reason}</span>}
                          {entry.trust && (
                            <TrustBadge
                              verified={entry.trust.verification !== null}
                              {...(entry.trust.verification
                                ? {
                                    checkedAt: entry.trust.verification.checkedAt,
                                    checkedByType: entry.trust.verification.checkedByType,
                                    checkedById: entry.trust.verification.checkedById,
                                  }
                                : {})}
                            />
                          )}
                        </td>
                        <td className={styles.colArea}>
                          <AreaChip area={entry.item.area} />
                          {entry.item.repo && (
                            <span className={styles.rowRepo}>{entry.item.repo}</span>
                          )}
                        </td>
                        <td className={styles.colOwner}>
                          {/* One line per live assignment — SCHEMA.md §2
                              allows more than one holder at once. An
                              unheld row shows nothing rather than a dash,
                              which would read as a value. */}
                          {entry.assignments.map((assignment) => (
                            <span
                              key={`${assignment.holderType}:${assignment.holderId}:${assignment.role}`}
                              className={styles.owner}
                            >
                              <AgentPresenceDot liveness={assignment.liveness} />
                              <span className={styles.ownerName}>{assignment.displayName}</span>
                              <span className={styles.ownerAge}>
                                {relativeTime(assignment.lastActive, now)}
                              </span>
                            </span>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* The page error sits under the section it belongs to, not at
                the top of the list: one section's failed page says nothing
                about the other three. */}
            {pageError && <ErrorState message={pageError} call="GET /api/board" />}

            {/* "Show more" is offered whenever the server left a cursor —
                the same condition the kanban's is. A withheld section's
                control is on its empty state instead (`onLoad` above),
                because there is nothing above it to append to. */}
            {paging && section.nextCursor !== null && (
              <button
                type="button"
                className={styles.showMore}
                onClick={() => paging.onShowMore(column)}
                disabled={paging.loadingColumns[column] === true}
              >
                {paging.loadingColumns[column] === true
                  ? "Loading…"
                  : `Show more ${title.toLowerCase()}`}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
