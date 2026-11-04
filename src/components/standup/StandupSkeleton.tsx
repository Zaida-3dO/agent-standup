// The Standup home while it loads: the page's own shape in outline (a line for
// the sentence, a Needs-you panel with three row bars, six card outlines and a
// block for the rail), not a spinner. It occupies the space the content will,
// so nothing jumps when the data lands. The shimmer is gated on
// `prefers-reduced-motion` in the stylesheet; static, it still does its job.
import styles from "./Standup.module.css";

const ROWS = [0, 1, 2];
const CARDS = [0, 1, 2, 3, 4, 5];

export function StandupSkeleton() {
  return (
    <section className={styles.page} aria-label="Standup" aria-busy="true" data-state="loading">
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h1 className={styles.date}>Standup</h1>
          <div className={`${styles.skel} ${styles.skelSentence}`} aria-hidden="true" />
        </div>
      </header>
      <p className={styles.srOnly} role="status">
        Loading the standup
      </p>
      <div className={styles.layout} data-has-stuck="false" aria-hidden="true">
        <div className={styles.areaNeeds}>
          <div className={`${styles.panel} ${styles.skelPanel}`}>
            {ROWS.map((row) => (
              <div key={row} className={`${styles.skel} ${styles.skelRow}`} />
            ))}
          </div>
        </div>
        <div className={styles.areaProjects}>
          <ul className={styles.grid}>
            {CARDS.map((card) => (
              <li key={card} className={`${styles.skel} ${styles.skelCard}`} />
            ))}
          </ul>
        </div>
        <div className={styles.areaDone}>
          <div className={`${styles.skel} ${styles.skelRail}`} />
        </div>
      </div>
    </section>
  );
}
