// One of the four columns — MILESTONES.md #37, bounded and paged.
//
// The column is three fixed pieces: a sticky heading carrying the column's
// **true** count, a scrolling trough holding the cards, and a footer holding
// the "show more" control. Only the middle one scrolls, which is what lets a
// 146-item backlog sit beside a 2-item column without either dictating the
// height of the page.
//
// The empty/withheld/filtered states are NOT written here — they come from
// `@/components/states`, shared with every other region in the app, because
// the distinction between them is one a region gets wrong silently and a
// per-region copy is a per-region chance to get it wrong (#123).
//
// Hook-free and prop-driven so it can be called directly in a test; see
// `TopBar.tsx`'s header.
import type { BoardColumnId, BoardSection } from "@/lib/board/types";
import { columnCount, columnTitle, needsYou, type WaitingSplit } from "@/lib/board/view";
import { hasMore } from "@/lib/board/paging";
import { acceptsDrop } from "@/lib/board/drag";
import { emptinessOf } from "@/lib/states/empty";
import { EmptyState } from "@/components/states/EmptyState";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";
import { ItemCard } from "./ItemCard";
import styles from "./Board.module.css";

export interface BoardColumnProps {
  readonly column: BoardColumnId;
  /**
   * This column's page and its true size (MILESTONES.md #123). The whole
   * section rather than just its entries, because the heading count and the
   * empty state are both answers the page alone cannot give: a page of zero
   * means "nothing here" or "not loaded" depending on `withheld`, and the
   * count is `total`, never the page length.
   */
  readonly section: BoardSection;
  /** The active profile's id, or `null` when none is chosen — decides which cards are flagged. */
  readonly personId: string | null;
  /** The clock — threaded to every card's presence "last active" caption. See `BoardView.tsx`'s prop. */
  readonly now: number;
  /**
   * The amber/red tally, passed only for the Waiting column. Rendering it
   * under the heading is what keeps the shared column readable at a glance
   * — SCHEMA.md §1.1's "sharing a column loses that".
   */
  readonly split?: WaitingSplit;
  /** Called when a card is dropped on this column (#73). Absent on a board with no drag wired up. */
  readonly onDrop?: (column: BoardColumnId) => void;
  /** Called when a dragged card enters or leaves this column, so it can show itself as the target. */
  readonly onDragEnter?: (column: BoardColumnId) => void;
  /** True while a dragged card is over this column. */
  readonly isDropTarget?: boolean;
  /** Passed to each card — see `ItemCardProps`. */
  readonly onCardDragStart?: (itemId: string) => void;
  readonly onCardDragEnd?: () => void;
  /** The item whose move is in flight, if it is in this column. */
  readonly pendingItemId?: string | null;
  /** Fetches this column's next page — the "show more" control. Absent leaves the column unpaged. */
  readonly onShowMore?: (column: BoardColumnId) => void;
  /** True while this column's next page is in flight. */
  readonly loadingMore?: boolean;
  /** Why this column's last page request failed, or `null`. Rendered by the shared error state, which names the call. */
  readonly pageError?: string | null;
  /** True while the column's FIRST page is loading — the skeleton, rather than an empty column. */
  readonly loading?: boolean;
  /** True when a filter is narrowing the board, so an empty column can say the filter did it. */
  readonly filtered?: boolean;
  /** Clears that filter — offered by the filtered-to-nothing state. */
  readonly onClearFilter?: () => void;
  /**
   * The pointer-drag drop-target ref (T6-A), supplied by `DroppableColumn`.
   * Absent leaves the column with only its native `onDrop` — see this
   * component's hook-free note and `DragLayer.tsx`'s header.
   */
  readonly dropRef?: (element: HTMLElement | null) => void;
  /**
   * True while a dragged card is over this column, so it can show where the
   * card will land. Distinct from `isDropTarget`, which tints the whole
   * column: this draws the actual landing site among the cards.
   */
  readonly showPlaceholder?: boolean;
  /**
   * The card component to render (T6-A). `DroppableColumn` passes
   * `DraggableCard` — the hook-holding wrapper that registers each card with
   * the drag library; absent renders the plain hook-free `ItemCard`.
   *
   * Injected rather than imported so this component still has no knowledge
   * of `dnd-kit` and stays callable as a plain function in a test.
   */
  readonly cardComponent?: typeof ItemCard;
}

/** The singular noun a column's states talk about. */
const COLUMN_NOUN = "item";

export function BoardColumn({
  column,
  section,
  personId,
  now,
  split,
  onDrop,
  onDragEnter,
  isDropTarget,
  onCardDragStart,
  onCardDragEnd,
  pendingItemId,
  onShowMore,
  loadingMore,
  pageError,
  loading,
  filtered,
  onClearFilter,
  dropRef,
  showPlaceholder,
  cardComponent,
}: BoardColumnProps) {
  const entries = section.entries;
  // Waiting accepts no drops at all — both its states need fields a drag
  // cannot supply, so every drop would be refused (see `TARGET_STATE`). A
  // column that always refuses teaches that the interface is unreliable, so
  // it simply is not a target.
  const droppable = onDrop !== undefined && acceptsDrop(column);
  // Never highlight a column that cannot be dropped on — the highlight is a
  // promise that letting go here will do something.
  const highlighted = droppable && isDropTarget === true;
  // Which "nothing to show" answer this column is giving, or `null` when it
  // has cards. The decision is `emptinessOf`'s, shared with every other
  // region, rather than a chain of conditionals rebuilt here.
  const emptiness = emptinessOf({
    shown: entries.length,
    total: section.total,
    withheld: section.withheld,
    filtered: filtered === true,
  });
  const more = hasMore(section);
  // The plain card, or the drag-registered one. Same component underneath —
  // `DraggableCard` renders `ItemCard` with one extra prop — so a test
  // walking this tree for `ItemCard` still finds every card when no drag
  // layer is mounted, which is every existing test.
  const Card = cardComponent ?? ItemCard;

  return (
    <section
      className={`${styles.column} ${highlighted ? styles.columnDropTarget : ""}`.trim()}
      aria-label={columnTitle(column)}
      data-column={column}
      data-drop-target={highlighted ? true : undefined}
      // The pointer-drag drop target, when one was registered. The native
      // handlers below are untouched and still fire for a browser drag.
      ref={dropRef}
      // `preventDefault` on dragOver is what makes an element a drop target
      // at all — the HTML drag-and-drop default is to refuse the drop, so
      // without it `onDrop` never fires and a card silently springs back
      // with no request ever having been made.
      onDragOver={
        droppable
          ? (event) => {
              event.preventDefault();
            }
          : undefined
      }
      onDragEnter={droppable && onDragEnter ? () => onDragEnter(column) : undefined}
      onDrop={
        droppable
          ? (event) => {
              event.preventDefault();
              onDrop(column);
            }
          : undefined
      }
    >
      <header className={styles.columnHead}>
        <h2 className={styles.columnTitle}>{columnTitle(column)}</h2>
        {/* The server's counted total, never the page length — see
            `columnCount`. These differ on every paginated column, and
            #123 is what the page length renders as: a column showing `0`
            while the store holds 175 finished items. */}
        <span className={styles.count}>{columnCount(section)}</span>
      </header>
      {/* **Focusable on purpose.** Bounding the column is what makes this
          necessary: the page used to scroll, and page scroll is reachable
          from the keyboard for free. A scroll region that cannot be focused
          cannot be scrolled with the arrow keys, so a keyboard-only reader
          could reach the first screenful of a 146-item column and nothing
          past it. `tabIndex={0}` is what puts it in the tab order; the role
          and label are what stop it being an unexplained tab stop, since a
          focusable element with no accessible name is announced as nothing
          at all. */}
      <div
        className={styles.columnBody}
        tabIndex={0}
        role="group"
        aria-label={`${columnTitle(column)} items`}
      >
        {split && (
          <p className={styles.split}>
            <span className={styles.splitAmber}>{split.amber} paused</span>
            <span className={styles.splitRed}>{split.red} blocked</span>
            {/* `waitingSplit` counts a third bucket — a project in Waiting,
                or a state that should not be in this column — and rendering
                only the first two let a card exist in the header count while
                appearing in neither tallied number, which is the exact
                "silently goes missing from the count" failure `waitingSplit`
                says it exists to prevent. Shown only when non-zero: a
                permanent "0 other" would be noise on the common board. */}
            {split.other > 0 && <span className={styles.splitOther}>{split.other} other</span>}
          </p>
        )}
        {/* The first load shows skeletons in the shape of the cards, rather
            than an empty column — a column rendering nothing while it loads
            is indistinguishable from one that came back empty, which is the
            same confusion the states below exist to prevent. */}
        {loading === true ? (
          <LoadingState rows={3} label={`${columnTitle(column)} column`} />
        ) : emptiness !== null ? (
          // **The placeholder wins over the empty state while a card is
          // held here.** An empty column is exactly where a landing site
          // matters most — there are no cards to imply where the drop goes
          // — and "nothing here yet" is the wrong thing to say about a
          // column that is about to receive something. The empty state
          // returns the moment the card leaves.
          showPlaceholder === true ? (
            <ul className={styles.cards}>
              <li className={styles.dropPlaceholder} data-drop-placeholder aria-hidden="true" />
            </ul>
          ) : (
            <EmptyState
              kind={emptiness}
              noun={COLUMN_NOUN}
              total={columnCount(section)}
              onClearFilter={onClearFilter}
              onLoad={emptiness === "withheld" && onShowMore ? () => onShowMore(column) : undefined}
            />
          )
        ) : (
          <ul className={styles.cards}>
            {entries.map((entry) => (
              <Card
                key={entry.item.id}
                entry={entry}
                needsYou={needsYou(entry, personId)}
                now={now}
                onDragStart={onCardDragStart}
                onDragEnd={onCardDragEnd}
                pending={pendingItemId === entry.item.id}
              />
            ))}
            {/* The landing site (T6-A) — where the card will go if it is
                released now. Rendered LAST because that is where the drop
                actually puts it: `relocate` appends the moved entry to the
                target column's entries, so a placeholder drawn anywhere
                else would promise a position the drop does not deliver.
                Only ever rendered on a column that accepts drops, since
                `showPlaceholder` comes from `DroppableColumn`, which does
                not register Waiting at all. */}
            {showPlaceholder === true && (
              <li className={styles.dropPlaceholder} data-drop-placeholder aria-hidden="true" />
            )}
          </ul>
        )}
        {/* A failed *page* request, not a failed board load — the column
            already has cards, so this reports beneath them and names the
            call, leaving what the reader is looking at in place. */}
        {pageError != null && (
          <ErrorState
            message={pageError}
            onRetry={onShowMore ? () => onShowMore(column) : undefined}
            retrying={loadingMore === true}
          />
        )}
      </div>
      {/* The consumer for `nextCursor` (MILESTONES.md #109), which the board
          read has returned since that row shipped and nothing has ever
          read back. */}
      {more && onShowMore && (
        <div className={styles.columnFoot}>
          <p className={styles.pageStatus}>
            Showing {entries.length} of {columnCount(section)}
          </p>
          <button
            type="button"
            className={styles.showMore}
            onClick={() => onShowMore(column)}
            disabled={loadingMore === true}
          >
            {loadingMore === true ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </section>
  );
}
