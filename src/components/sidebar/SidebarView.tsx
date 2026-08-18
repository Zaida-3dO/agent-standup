// The persistent rail, plus the same nav rendered as a mobile sheet.
//
// **One nav, two placements.** `SidebarNav` is rendered twice rather than
// the rail being re-styled into a drawer, because the two have genuinely
// different chrome (the sheet has a scrim, a close control and a title; the
// rail has none of them) and sharing the *list* is the part that matters —
// a second copy of the destinations is how a route ends up in one and not
// the other.
//
// Hook-free and prop-driven; the open/closed state and the viewport
// listener live in `Sidebar.tsx`.
import { X } from "lucide-react";
import type { NavCounts } from "@/lib/nav/counts";
import { SidebarNav } from "./SidebarNav";
import styles from "./Sidebar.module.css";

export interface SidebarViewProps {
  readonly pathname: string | null;
  readonly counts: NavCounts;
  /** Whether the mobile sheet is open. Ignored above the breakpoint, where the rail is always visible. */
  readonly sheetOpen: boolean;
  readonly onCloseSheet: () => void;
}

export function SidebarView({ pathname, counts, sheetOpen, onCloseSheet }: SidebarViewProps) {
  return (
    <>
      {/* The rail. CSS hides it under the breakpoint rather than a JS
          viewport check deciding not to render it: a media query applies
          before first paint and on every resize with no listener, and a
          server render that guessed the viewport would flash the wrong
          layout on load. */}
      <aside className={styles.rail} aria-label="Main navigation">
        <div className={styles.brand}>Agent Standup</div>
        <SidebarNav pathname={pathname} counts={counts} />
      </aside>

      {sheetOpen && (
        <div className={styles.sheetLayer}>
          {/* The scrim closes the sheet. A `button` rather than a `div` with
              a click handler, so it is reachable and operable from the
              keyboard as well as the pointer. */}
          <button
            type="button"
            className={styles.scrim}
            onClick={onCloseSheet}
            aria-label="Close navigation"
          />
          <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Navigation">
            <div className={styles.sheetHeader}>
              <span className={styles.brand}>Agent Standup</span>
              <button
                type="button"
                className={styles.sheetClose}
                onClick={onCloseSheet}
                aria-label="Close navigation"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            {/* Choosing a destination closes the sheet — it covers the page
                it just navigated to, so leaving it open would hide the
                result of the reader's own action. */}
            <SidebarNav pathname={pathname} counts={counts} onNavigate={onCloseSheet} />
          </div>
        </div>
      )}
    </>
  );
}
