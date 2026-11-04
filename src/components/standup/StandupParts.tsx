// Small pieces the Standup home's panels share: a section that failed to load,
// a project's colour dot and name, and the "9+" count text. Hook-free and
// prop-driven, like the panels that use them.
import type { CSSProperties } from "react";
import { fnv1a } from "@/lib/design/area-colour";
import type { Counted, ProjectRef } from "@/lib/standup/view";
import styles from "./Standup.module.css";

/** The text of a count that may be a floor: "9" or "9+". */
export function countText(counted: Counted): string {
  return `${counted.count}${counted.atLeast ? "+" : ""}`;
}

/**
 * A project's dot hue (0 to 359), derived from its id so the same project is
 * the same colour on every load and every card, with nothing stored. The dot
 * is a recognition aid beside the project's name, never a substitute for it.
 */
export function projectHue(projectId: string): number {
  return fnv1a(projectId) % 360;
}

/** The coloured dot for a project. Decorative: the name always sits beside it. */
export function ProjectDot({ projectId }: { readonly projectId: string }) {
  return (
    <i
      className={styles.dot}
      style={{ "--h": projectHue(projectId) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** A project's dot and name, as plain text (never a second link inside a row or card). */
export function ProjectChip({ project }: { readonly project: ProjectRef }) {
  return (
    <span className={styles.proj}>
      <ProjectDot projectId={project.id} />
      {project.title}
    </span>
  );
}

export interface SectionErrorProps {
  readonly title: string;
  /** The read's own failure message, kept as a tooltip: the line on the page is the short one. */
  readonly message: string;
  /** Re-runs the page load. */
  readonly onRetry: () => void;
}

/**
 * A section whose own read failed: its title, one line, and a Try again that
 * re-runs the page load. It sits where the section would have been, so the
 * other sections render exactly as they would have.
 */
export function SectionError({ title, message, onRetry }: SectionErrorProps) {
  const headingId = `standup-error-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section
      className={`${styles.panel} ${styles.errorPanel}`}
      aria-labelledby={headingId}
      data-section-error="true"
    >
      <div className={styles.panelHead}>
        <h2 id={headingId} className={styles.panelTitle}>
          {title}
        </h2>
      </div>
      <div className={styles.errorBody}>
        <p className={styles.errorLine} title={message}>
          Couldn&apos;t load this just now.
        </p>
        <button type="button" className={styles.retry} onClick={onRetry}>
          Try again
        </button>
      </div>
    </section>
  );
}
