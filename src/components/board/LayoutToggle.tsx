// The kanban/list switch — MILESTONES.md T6 §3: "there should be an option
// to switch between kanban and sectioned lists".
//
// Hook-free and prop-driven, so a test calls it as a function and inspects
// the returned tree (`tests/helpers/react-element.ts`).
//
// **Real `<Link>`s, not buttons with an onClick.** Choosing a layout is a
// navigation: the address changes, and the result should be
// middle-clickable, openable in a new tab, and visible in the status bar on
// hover — none of which a button silently is. It is also what makes the
// acceptance criterion "a list view can be linked and reloaded" true by
// construction rather than by a handler remembering to push a URL.
//
// **Both hrefs are built from the CURRENT query**, so each carries every
// filter, the sort and the direction that are in force right now. That is
// the whole of "toggling between layouts preserves filter state" — there is
// no state to preserve, because the link the reader follows already spells
// out the view they were looking at. A hand-built `?layout=list` would
// instead carry whatever happened to be in the address, which is the same
// thing only until any other control is touched.
import Link from "next/link";
import {
  BOARD_LAYOUTS,
  boardHref,
  layoutOf,
  withLayout,
  type BoardLayout,
  type BoardQuery,
} from "@/lib/board/filters";
import styles from "./LayoutToggle.module.css";

export interface LayoutToggleProps {
  readonly query: BoardQuery;
}

/** The reader-facing name of each layout — "board" is a poor label for a thing called a board. */
const LAYOUT_LABELS: Record<BoardLayout, string> = {
  board: "Board",
  list: "List",
};

export function LayoutToggle({ query }: LayoutToggleProps) {
  const current = layoutOf(query);

  return (
    // `role="group"` with a name, rather than a bare div: two links whose
    // only relationship is that they are adjacent give a screen-reader user
    // no way to tell this is one choice with two options.
    <div className={styles.toggle} role="group" aria-label="Layout">
      {BOARD_LAYOUTS.map((layout) => {
        const active = layout === current;
        return (
          <Link
            key={layout}
            className={styles.option}
            href={boardHref(withLayout(query, layout))}
            // **`aria-current`, not `aria-pressed`.** These are links, and
            // the state being described is "this is the view you are on"
            // rather than "this control is held down". A screen reader
            // announces the two differently and only one of them is true.
            {...(active ? { "aria-current": "true" as const } : {})}
            // Read by the CSS, so the active styling and the announced
            // state come from ONE decision rather than two that can
            // disagree.
            data-active={active}
            // The active option is still a link — it navigates to the
            // address it is already at, which is a no-op rather than a
            // trap. Not disabled, because a disabled link is unfocusable
            // and would silently drop out of the tab order.
            scroll={false}
          >
            {LAYOUT_LABELS[layout]}
          </Link>
        );
      })}
    </div>
  );
}
