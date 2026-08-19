// A chip that is also a link back to a filtered board — M10 T10: "when you
// open a file, clicking on any of these tags should just take you back to
// the kanban board with that filter applied."
//
// **Wraps a chip rather than teaching the shared chip components to link.**
// `StateChip`, `PriorityChip` and `AreaChip` live under
// `src/components/chips/` and are used by the board itself and by every
// other detail tab — teaching them to be anchors would be a change to
// shared, cross-territory code for a behaviour only this tab needs. An
// `<a>` wrapping a `<span>` chip is visually identical (the chip supplies
// its own padding and border; the anchor supplies only the click target)
// and keeps the change local to the one tab that wants it.
//
// Plain `<a href>`, not a click handler pushing a router — for the same
// reason `TabStrip.tsx` chose an anchor over a button: the destination is a
// real URL, so a reader can open it in a new tab, copy it, or follow it
// with the keyboard exactly as any other link, with no JavaScript required
// to make it work at all.
import type { ReactNode } from "react";
import styles from "./ItemDetail.module.css";

export interface ChipLinkProps {
  readonly href: string;
  readonly children: ReactNode;
  /** What the link is going to, for the accessible name — "Filter the board by area: web". */
  readonly label: string;
}

export function ChipLink({ href, children, label }: ChipLinkProps) {
  return (
    <a href={href} className={styles.chipLink} aria-label={label} data-chip-link>
      {children}
    </a>
  );
}
