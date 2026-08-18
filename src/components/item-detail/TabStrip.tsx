// The tab strip — the six section links across the top of the detail page.
//
// ── Why anchors and not buttons ────────────────────────────────────────
//
// Each tab is an `<a href="#activity">`, not a `<button>`. The tabs have to
// be linkable (a chip on the board points at an item's activity; an
// approval queue points at its findings), which means the URL has to carry
// the active tab either way — and once it does, an anchor is simply the
// honest element: it navigates to a URL, so it can be copied, opened in a
// new tab and followed with the keyboard exactly as a reader expects. A
// button would reproduce all of that in JavaScript and get some of it
// wrong.
//
// The click handler is still here, because the container wants to set state
// and replace the hash without a scroll jump. It is an enhancement over a
// link that already works, not the mechanism.
//
// ── Why it is not `Radix Tabs` ─────────────────────────────────────────
//
// Radix's `Tabs` owns its own state and renders its panels through a
// context, which is a hook the DOM-free harness cannot call — the strip
// would stop being directly testable, which is this repo's strongest
// convention. What Radix would supply is the ARIA wiring and arrow-key
// roving, and both are small enough to do here explicitly and visibly:
// `role="tablist"`, `aria-selected`, and `aria-controls` pointing at the
// panel. Radix stays available for the genuinely stateful widgets where it
// earns the shell.
import { TABS, TAB_LABELS, hashForTab, type DetailTab } from "@/lib/item-detail/tabs";
import styles from "./ItemDetail.module.css";

export interface TabStripProps {
  readonly activeTab: DetailTab;
  /**
   * Called with the tab a reader picked. Optional: with no handler the
   * anchors still navigate, which is the no-JavaScript path and the reason
   * the strip is built from links.
   */
  readonly onTabChange?: (tab: DetailTab) => void;
  /**
   * A count to show beside a tab, for the tabs whose value is partly "how
   * many". Absent means no count is shown — which is different from `0`,
   * and deliberately so: `0` is a fact worth showing ("no reviews yet"),
   * while absent means this tab does not count anything.
   */
  readonly counts?: Partial<Record<DetailTab, number>>;
}

/** The id of a tab's panel, so `aria-controls` and the panel itself agree on one spelling. */
export function tabPanelId(tab: DetailTab): string {
  return `item-detail-panel-${tab}`;
}

/** The id of a tab's own control, for the panel's `aria-labelledby`. */
export function tabControlId(tab: DetailTab): string {
  return `item-detail-tab-${tab}`;
}

export function TabStrip({ activeTab, onTabChange, counts }: TabStripProps) {
  return (
    <div className={styles.tabStrip} role="tablist" aria-label="Item sections">
      {TABS.map((tab) => {
        const selected = tab === activeTab;
        const count = counts?.[tab];
        return (
          <a
            key={tab}
            id={tabControlId(tab)}
            className={`${styles.tab} ${selected ? styles.tabActive : ""}`.trim()}
            href={hashForTab(tab)}
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(tab)}
            data-tab={tab}
            data-active={selected}
            onClick={(event) => {
              if (onTabChange === undefined) return;
              // Only the plain left click is taken over. A modified click
              // is the reader asking for a new tab or window, and
              // preventing it would break the one interaction the anchor
              // was chosen to preserve.
              if (event.defaultPrevented) return;
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              if (event.button !== 0) return;
              event.preventDefault();
              onTabChange(tab);
            }}
          >
            <span className={styles.tabLabel}>{TAB_LABELS[tab]}</span>
            {count !== undefined && (
              <span className={`${styles.tabCount} tabular`} data-count={count}>
                {count}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}
