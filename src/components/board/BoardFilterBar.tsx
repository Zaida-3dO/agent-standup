"use client";

// The filter bar's container — MILESTONES.md #75.
//
// Holds the two things that genuinely need React (the search draft and the
// saved-view name draft) and owns the navigation. Everything that is a
// *decision* — what a press means, what a name may be, what the URL for a
// query is — lives in `@/lib/board/filter-state` and `@/lib/board/filters`
// as plain functions, so it is provable without a DOM.
//
// **Navigation is `replace`, not `push`.** Turning a select changes what you
// are looking at, not where you are: pushing would make the back button walk
// backwards through every axis a reader touched before it left the board,
// which is the behaviour that makes filter bars feel like traps. A saved
// view applied from the sidebar is an ordinary `<Link>` and does push,
// because that genuinely is going somewhere.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  directionToggled,
  filterChanged,
  filtersCleared,
  hrefFor,
  queryStringFor,
  sortChanged,
  viewDeleted,
  viewSaved,
  SEARCH_DEBOUNCE_MS,
} from "@/lib/board/filter-state";
import { withFilter, type BoardFilters, type BoardQuery } from "@/lib/board/filters";
import { savedViewNameProblem, type SavedViews } from "@/lib/board/saved-views";
import { writeSavedViews } from "@/lib/board/saved-views-client";
import type { FilterOptions } from "@/lib/board/filter-options";
import { BoardFilterBarView } from "./BoardFilterBarView";
import { SavedViewsView } from "./SavedViewsView";

export interface BoardFilterBarProps {
  readonly query: BoardQuery;
  readonly options: FilterOptions;
  readonly views: SavedViews;
  /** Applied after a successful write, so the sidebar and the chips update together. */
  readonly onViewsChange: (views: SavedViews) => void;
}

export function BoardFilterBar({ query, options, views, onViewsChange }: BoardFilterBarProps) {
  const router = useRouter();
  const [nameDraft, setNameDraft] = useState("");
  const [writeError, setWriteError] = useState<string | null>(null);

  // **`null` means "the reader has not typed since the last navigation."**
  // Distinct from `""`, which means they typed and then cleared it — the two
  // have to be different, or a cleared box would immediately be refilled
  // from the URL it is in the middle of clearing.
  const [searchDraft, setSearchDraft] = useState<string | null>(null);

  const navigate = useCallback(
    (next: BoardQuery) => {
      router.replace(hrefFor(next), { scroll: false });
    },
    [router],
  );

  // The pending debounce, so a second keystroke cancels the first rather
  // than both landing. A ref, not state: changing it must not re-render, and
  // the cleanup has to read the newest value synchronously.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Cleared on unmount so a debounce cannot fire a navigation after the
    // board has gone — the same class of defect as an uncancelled fetch.
    return () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    };
  }, []);

  const onSearchDraftChange = useCallback(
    (value: string) => {
      setSearchDraft(value);
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        searchTimer.current = null;
        // Read from `query` captured at the time the keystroke happened,
        // which is correct here precisely because a navigation re-renders
        // this component with a fresh `query` and re-creates this callback.
        navigate(withFilter(query, "search", value === "" ? undefined : value));
      }, SEARCH_DEBOUNCE_MS);
    },
    [navigate, query],
  );

  const onFilterChange = useCallback(
    <K extends keyof BoardFilters>(key: K, value: BoardFilters[K] | undefined) => {
      navigate(filterChanged(query, key, value));
    },
    [navigate, query],
  );

  const persist = useCallback(
    (next: SavedViews) => {
      // Optimistic: the chips and the sidebar update immediately and the
      // write reports only if it fails. A saved view is not the data — a
      // spinner on a bookmark costs more than the rare failure does.
      onViewsChange(next);
      setWriteError(null);
      void writeSavedViews(next).then((outcome) => {
        if (!outcome.ok) setWriteError(outcome.message);
      });
    },
    [onViewsChange],
  );

  const onSave = useCallback(() => {
    const result = viewSaved(views, nameDraft, query);
    if (!result.ok) {
      setWriteError(result.reason);
      return;
    }
    setNameDraft("");
    persist(result.views);
  }, [nameDraft, persist, query, views]);

  const currentQueryString = queryStringFor(query);
  // The name box's own objection takes precedence over a stale write error,
  // so a reader who has just fixed the name is not still being told about
  // the last failure.
  const saveProblem = savedViewNameProblem(views, nameDraft)?.reason ?? writeError;

  return (
    <>
      <BoardFilterBarView
        query={query}
        onFilterChange={onFilterChange}
        onSortChange={(sort) => navigate(sortChanged(query, sort))}
        onToggleDirection={() => navigate(directionToggled(query))}
        onClearFilters={() => {
          // The draft is dropped as well as the URL parameter. Leaving the
          // typed word in a box whose filter has just been cleared is the
          // interface disagreeing with itself.
          setSearchDraft(null);
          navigate(filtersCleared(query));
        }}
        searchDraft={searchDraft ?? query.filters.search ?? ""}
        onSearchDraftChange={onSearchDraftChange}
        areas={options.areas}
        repos={options.repos}
        people={options.people}
        assignees={options.people}
      />
      <SavedViewsView
        views={views}
        currentQuery={currentQueryString}
        onApply={(view) => router.replace(`/board${view.query === "" ? "" : `?${view.query}`}`)}
        onDelete={(name) => persist(viewDeleted(views, name))}
        nameDraft={nameDraft}
        onNameDraftChange={(value) => {
          setNameDraft(value);
          setWriteError(null);
        }}
        onSave={onSave}
        saveProblem={saveProblem}
      />
    </>
  );
}
