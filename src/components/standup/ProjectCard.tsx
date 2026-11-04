// One project on the Standup home: its name, one line on what it is for, up to
// two things being worked on right now, a progress bar, and when it was last
// active. The whole card is ONE link to the project, so the live titles are
// text and never links of their own (a link inside a link is invalid, and two
// tab stops per card would double the keyboard path for no gain).
import Link from "next/link";
import type { ProjectCardView } from "@/lib/standup/view";
import { ProjectDot } from "./StandupParts";
import styles from "./Standup.module.css";

export function ProjectCard({ card }: { readonly card: ProjectCardView }) {
  const { bar, liveItems } = card;
  return (
    <Link
      href={card.href}
      className={styles.card}
      // The accent border is the card's "something here is for you" mark; the
      // badge beside the name says the same in words.
      data-flagged={card.flagged ? "true" : undefined}
    >
      <span className={styles.cardTop}>
        <ProjectDot projectId={card.id} />
        <span className={styles.cardName}>{card.title}</span>
        {(card.needsYouBadge !== null || card.stuckBadge !== null) && (
          <span className={styles.badges}>
            {card.needsYouBadge !== null && (
              <span className={`${styles.badge} ${styles.badgeYou}`}>{card.needsYouBadge}</span>
            )}
            {card.stuckBadge !== null && (
              <span className={`${styles.badge} ${styles.badgeStuck}`}>{card.stuckBadge}</span>
            )}
          </span>
        )}
      </span>

      {card.headline !== null && <span className={styles.cardLine}>{card.headline}</span>}

      {liveItems !== null && liveItems.length > 0 && (
        <span className={styles.live}>
          {liveItems.map((item) => (
            <span key={item.id} className={styles.liveItem}>
              <i className={styles.pulse} aria-hidden="true" />
              <span className={styles.liveTitle}>{item.title}</span>
            </span>
          ))}
          {card.moreLiveText !== null && (
            <span className={styles.liveMore}>{card.moreLiveText}</span>
          )}
        </span>
      )}
      {card.noOneWorking && <span className={styles.idle}>No one is working on it right now.</span>}

      {(bar !== null || card.lastActive !== null) && (
        <span className={styles.cardFoot}>
          {bar !== null && (
            <span className={styles.bar} role="img" aria-label={bar.ariaLabel}>
              <i className={styles.barDone} style={{ width: `${bar.doneWidth}%` }} />
              <i className={styles.barActive} style={{ width: `${bar.inProgressWidth}%` }} />
              <i className={styles.barStuck} style={{ width: `${bar.stuckWidth}%` }} />
            </span>
          )}
          <span className={styles.cardMeta}>
            {bar !== null && <span>{bar.caption}</span>}
            {card.lastActive !== null && (
              <span className={styles.lastActive}>{card.lastActive}</span>
            )}
          </span>
        </span>
      )}
    </Link>
  );
}
