"use client";

// The list's thin container — the counterpart to `Board.tsx`, for the other
// layout.
//
// Fetches `GET /api/board` through the same `fetchBoard`/`fetchBoardColumn`
// the kanban uses, reads who's active from the profile context, and hands
// both to `ListView` as plain props. **This is the whole reason the two
// layouts show the same set**: there is one fetch path, one request encoder
// (`boardRequestParams`) and one `BoardQuery`, so a filter cannot be applied
// to one layout's request and not the other's. A second fetch written here
// is exactly how the two would come to disagree.
//
// **No database access, and none possible** — the same constraint
// `Board.tsx` states: nothing under `src/components/` imports the service
// layer or the database client, and `npm run check:db-imports` enforces it
// independently of lint.
//
// **Deliberately no drag wiring.** Reordering by dragging a row is not a
// gesture this layout offers, so none of `@/lib/board/drag-state` is
// imported. That keeps the container to the two things it genuinely needs
// React for — holding the loaded board and issuing the request.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useProfile } from "@/lib/profile/ProfileProvider";
import {
  fetchBoard,
  fetchBoardColumn,
  boardErrorMessageFrom,
  type BoardLoadState,
} from "@/lib/board/state";
import { emptyBoard } from "@/lib/board/view";
import { boardWithPage } from "@/lib/board/paging";
import type { Board, BoardColumnId } from "@/lib/board/types";
import { isFiltered, parseBoardQuery, withoutFilters, boardHref } from "@/lib/board/filters";
import {
  emptyFilterOptions,
  fetchFilterOptions,
  type FilterOptions,
} from "@/lib/board/filter-options";
import { fetchSavedViews } from "@/lib/board/saved-views-client";
import type { SavedViews } from "@/lib/board/saved-views";
import { BoardFilterBar } from "./BoardFilterBar";
import { ListView } from "./ListView";

export function ListViewContainer() {
  const { activeProfile } = useProfile();
  const router = useRouter();
  const searchParams = useSearchParams();

  // **The URL is the state, not a mirror of it** — the same contract
  // `Board.tsx` keeps, and keeping it identically is what makes the toggle
  // between layouts lossless: both components read the SAME query string
  // through the SAME parser, so switching layout re-reads the filters that
  // were already in the address rather than re-deriving them from anything
  // held in memory. There is nothing held in memory to lose.
  const queryString = searchParams.toString();
  const boardQuery = useMemo(() => parseBoardQuery(queryString), [queryString]);
  const filtered = isFiltered(boardQuery.filters);

  // The bar's own data. Fetched here for the same reason `Board.tsx`
  // fetches it: the list renders the SAME filter bar, so it needs the same
  // vocabularies and the same pinned views. Both resolve to empty rather
  // than throwing — a failure to load the select options must not take the
  // list down with it.
  const [options, setOptions] = useState<FilterOptions>(() => emptyFilterOptions());
  const [savedViews, setSavedViews] = useState<SavedViews>([]);

  const [board, setBoard] = useState<Board>(() => emptyBoard());
  const [status, setStatus] = useState<"loading" | "error" | "loaded">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [loadingColumns, setLoadingColumns] = useState<Partial<Record<BoardColumnId, boolean>>>({});
  const [pageErrors, setPageErrors] = useState<Partial<Record<BoardColumnId, string>>>({});
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * The clock, sampled once per load — the same reasoning `Board.tsx`
   * gives: reading `Date.now()` during render would produce a different
   * tree on the server than on the client for the same data (a hydration
   * mismatch), and every row would disagree about "now".
   */
  const [now, setNow] = useState(0);

  // **The ref is the authoritative copy; `board` is what renders.**
  //
  // Both are written together and only ever through `applyBoard`, so they
  // cannot diverge. The ref exists because `onShowMore` has to read the
  // newest cursor synchronously — see the comment there for the defect that
  // costs. It is never read or written during render, which is what
  // `react-hooks/refs` protects: a ref read during render would not
  // re-render when it changed.
  const boardRef = useRef(board);

  /** The single write path — advances the ref synchronously and schedules the render. */
  const applyBoard = useCallback((next: Board) => {
    boardRef.current = next;
    setBoard(next);
  }, []);

  // **`boardQuery` is in the dependency list**, so changing a filter or the
  // sort re-reads the list — the whole of "the filter is applied", with no
  // separate apply step and nothing to keep in step.
  useEffect(() => {
    let cancelled = false;
    fetchBoard(fetch, boardQuery)
      .then((next) => {
        if (cancelled) return;
        applyBoard(next);
        setNow(Date.now());
        setStatus("loaded");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMessage(boardErrorMessageFrom(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [applyBoard, reloadNonce, boardQuery]);

  // Neither depends on the filters, so re-reading them on every filter
  // change would be two requests per keystroke for lists that did not move.
  useEffect(() => {
    let cancelled = false;
    void fetchFilterOptions().then((next) => {
      if (!cancelled) setOptions(next);
    });
    void fetchSavedViews().then((next) => {
      if (!cancelled) setSavedViews(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Fetch one section's next page and append it.
   *
   * The merge rule — append rather than replace, take the cursor and total
   * from the new page, never re-add an entry already shown — is
   * `@/lib/board/paging`'s `boardWithPage`, the same function the kanban
   * pages with. Reimplementing the merge here is how the two layouts would
   * come to page differently over identical data.
   */
  const onShowMore = useCallback(
    (column: BoardColumnId) => {
      setLoadingColumns((current) => ({ ...current, [column]: true }));
      // Cleared on the attempt, not on its success: leaving the previous
      // failure on screen while a retry is in flight reports a stale
      // failure as a current one.
      setPageErrors((current) => ({ ...current, [column]: undefined }));
      // **The cursor is read synchronously from the ref, never out of a
      // `setState` updater.** Two reasons, and the second is the one that
      // bites:
      //
      //   - a `setState` updater must be PURE. React invokes it eagerly or
      //     lazily at its own discretion, and twice in StrictMode — so a
      //     fetch issued from inside one is a fetch that fires twice in
      //     development and at an unpredictable moment in production.
      //   - a cursor read from the render-time `board` would be the
      //     previous page's on a second press before the first render had
      //     committed, which re-requests the page already shown and makes
      //     the control appear to do nothing.
      //
      // The ref is written wherever the board is (see `applyBoard`), so it
      // is always the newest value.
      const section = boardRef.current[column];
      // A withheld column has no cursor and has never been read, so its
      // "load" is a first page rather than a next one — `undefined` asks
      // for exactly that, and is why this is not guarded on `nextCursor`.
      const cursor = section.nextCursor ?? undefined;
      // **The same filters and the same sort as the first page.** A "show
      // more" that dropped them would page an unfiltered, differently
      // ordered sequence into a filtered section — and because the cursor
      // is keyset on the sort key, a page requested under a different sort
      // is drawn from a sequence the cursor does not belong to.
      void fetchBoardColumn(column, {
        query: boardQuery,
        ...(cursor === undefined ? {} : { cursor }),
      })
        .then((page) => {
          applyBoard(boardWithPage(boardRef.current, column, page));
        })
        .catch((err: unknown) => {
          setPageErrors((errors) => ({ ...errors, [column]: boardErrorMessageFrom(err) }));
        })
        .finally(() => {
          setLoadingColumns((columns) => ({ ...columns, [column]: false }));
        });
    },
    [applyBoard, boardQuery],
  );

  const loadState: BoardLoadState =
    status === "error"
      ? { status: "error", message: errorMessage }
      : status === "loading"
        ? { status: "loading" }
        : { status: "loaded", board };

  return (
    <>
      {/* The same bar the kanban renders, with the same props — which is
          what makes the layout toggle preserve the filters in the
          interface as well as in the URL. A list with its own reduced bar
          would be a second place for an axis to be forgotten. */}
      <BoardFilterBar
        query={boardQuery}
        options={options}
        views={savedViews}
        onViewsChange={setSavedViews}
      />
      <ListView
        loadState={loadState}
        personId={activeProfile?.id ?? null}
        now={now}
        filtered={filtered}
        onClearFilter={() =>
          // **`withoutFilters` keeps the layout**, because it spreads the
          // whole query. Clearing a filter must not also throw the reader
          // back to the kanban — that would be the interface undoing a
          // choice the reader did not ask it to undo.
          router.replace(boardHref(withoutFilters(boardQuery)), { scroll: false })
        }
        onRetry={() => {
          setStatus("loading");
          setErrorMessage("");
          setReloadNonce((n) => n + 1);
        }}
        paging={{ onShowMore, loadingColumns, errors: pageErrors }}
      />
    </>
  );
}
