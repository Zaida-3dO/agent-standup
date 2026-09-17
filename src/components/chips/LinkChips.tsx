// An item's external pointers, as a row of key-only chips.
//
// **Only the key is drawn — never the URL.** `[slack](url)`, not
// `slack: https://…`. A URL is long, visually noisy and almost never the
// thing a reader wants to read; what they want is to know a thread exists
// and to get to it in one click. Putting the full URL on a card would cost
// a line of wrapping text per link and push the title — the thing the card
// is actually for — off the visible area. The destination is still fully
// available: it is the `href`, so hovering shows it in the status bar,
// right-click copies it, and a screen reader announces it through the
// accessible name below.
//
// **One component for the card and the item header**, rather than a copy in
// each. The two surfaces render the same fact and got the same treatment
// deliberately: a reader who learns what a chip means on the board should
// not have to relearn it on the item page. Their containers differ, so the
// row's own spacing comes from a prop rather than being baked in here.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts` calls these
// as plain functions under `environment: "node"`, with no DOM.
import styles from "./Chips.module.css";

/** One link, exactly as the wire carries it. */
export interface LinkChipItem {
  readonly key: string;
  readonly url: string;
}

export interface LinkChipsProps {
  readonly links: readonly LinkChipItem[];
  /**
   * The class the row container takes, supplied by the surface that owns
   * the spacing — the card's meta row and the detail header's meta row have
   * different gaps and sizes, and neither should be imposed from here.
   */
  readonly className?: string;
  /**
   * Called on click and on pointer-down, before the event reaches an
   * ancestor.
   *
   * **The card needs this and the header does not**, which is why it is a
   * prop rather than behaviour this component assumes. A board card is
   * draggable, and an anchor is natively draggable too — so without
   * stopping propagation, pressing a link chip starts a card drag and the
   * click never lands. The card passes a stopper; the item header passes
   * nothing and gets a plain link.
   */
  readonly onChipPointerDown?: (event: { stopPropagation: () => void }) => void;
}

export function LinkChips({ links, className, onChipPointerDown }: LinkChipsProps) {
  // Nothing rather than an empty row. A container with no children still
  // takes its gap and margin in a flex column, so rendering one would put
  // unexplained space under every item that carries no links — which is
  // most of them.
  if (links.length === 0) return null;

  return (
    <div className={className} data-link-chips>
      {links.map((link) => (
        <a
          // `key` and `url` together, because the pair is the row's identity
          // in the database: one key can appear twice against different
          // URLs (three docs), and one URL twice under different keys. Using
          // either alone would collide and drop a chip.
          key={`${link.key}\u0000${link.url}`}
          href={link.url}
          className={`${styles.chip} ${styles.outlined} ${styles.linkChip}`}
          // Opens away from the board. A board is a working surface a reader
          // returns to — navigating it away to read a chat thread loses
          // their scroll position, their filters and any card they had
          // open.
          target="_blank"
          // **Mandatory, not decorative.** `target="_blank"` hands the opened
          // page a `window.opener` reference back to this one, which lets an
          // untrusted destination navigate the board away
          // (`opener.location = …`) — and these URLs are supplied by
          // whoever recorded them, so no destination here is trusted.
          // `noreferrer` additionally withholds the originating URL, which
          // can carry item ids in its query string.
          rel="noopener noreferrer"
          // The visible text is a bare label like "slack", which is not a
          // usable link name on its own — a screen reader listing links
          // would read a dozen chips with no way to tell them apart. The
          // accessible name states what it is and where it goes.
          aria-label={`${link.key} (opens ${link.url} in a new tab)`}
          data-link-key={link.key}
          onClick={onChipPointerDown}
          onPointerDown={onChipPointerDown}
        >
          {link.key}
        </a>
      ))}
    </div>
  );
}
