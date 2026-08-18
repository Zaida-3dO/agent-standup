// The stand-in for a screen a later task owns.
//
// **It says what it is.** A route that resolves to a blank page, or to a
// convincing-looking empty state, is indistinguishable from a screen that
// loaded and found nothing — and the reader who concludes "there is no
// work in this project" from an unbuilt page has been misled by the
// product. Naming the destination and stating plainly that it is not built
// yet costs one sentence and is the difference between an honest frame and
// a hollow one.
//
// Hook-free and prop-driven, so it is callable as a plain function in this
// repo's DOM-free harness — see `TopBar.tsx`'s header.
import styles from "./Placeholder.module.css";

export interface PlaceholderProps {
  /** The screen's name, as the sidebar spells it. */
  readonly title: string;
  /** What this screen will show, in one sentence. Written in the present tense about the destination, not about the state of the work. */
  readonly summary: string;
}

export function Placeholder({ title, summary }: PlaceholderProps) {
  return (
    <section className={styles.wrap} aria-labelledby="placeholder-title">
      <h1 id="placeholder-title" className={styles.title}>
        {title}
      </h1>
      <p className={styles.summary}>{summary}</p>
      <p className={styles.note}>This screen is not built yet.</p>
    </section>
  );
}
