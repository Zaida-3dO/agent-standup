// One project card in the grid — MILESTONES.md #74.
//
// Hook-free and prop-driven, like every other component here, so a test
// calls it as a function and inspects the element tree it returns
// (`tests/helpers/react-element.ts`).
//
// **The card's job is to be honest about a project whose data is broken.**
// Roughly half the projects in a real store have no children at all — a
// bulk import from a store with no project/task distinction types every
// root it loads as a project — and the failure mode this card is shaped
// against is rendering one of those as "0% complete", which asserts that
// work exists and none of it is done. Both halves of that are false. So a
// childless project gets a flag and an explicit *no work under this yet*,
// never a progress bar at zero.
import Link from "next/link";
import type { ProjectRollup } from "@/lib/projects/types";
import { distributionOf, liveCrewCount, progressOf, relativeTime } from "@/lib/projects/view";
import { STATE_LABELS, stateTokens } from "@/lib/design/tokens";
import { AreaChip } from "@/components/chips/AreaChip";
import { AgentPresenceDot } from "@/components/chips/AgentPresenceDot";
import styles from "./Projects.module.css";

export interface ProjectCardProps {
  readonly project: ProjectRollup;
  /**
   * The clock, passed in rather than read here.
   *
   * A component that called `Date.now()` itself would render differently on
   * the server and on the client for the same props, which is a hydration
   * mismatch — and it could not be tested at a boundary without faking time
   * globally.
   */
  readonly now: number;
}

export function ProjectCard({ project, now }: ProjectCardProps) {
  const progress = progressOf(project);
  const segments = distributionOf(project.counts, project.total);
  const crew = liveCrewCount(project);

  return (
    <article
      className={`${styles.card}${project.childless ? ` ${styles.cardSuspect}` : ""}`}
      data-project-id={project.id}
      // Read by the tests, and the honest summary of the card's whole
      // reason for existing in this shape.
      data-childless={project.childless ? "true" : "false"}
    >
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>
          {/* `/projects/{id}`, not `/items/{id}` — a project's own row has
              no state to show, so the item view would render the leftover
              default `create_item` writes. The project page derives the
              reading from the children instead, which is the only honest
              answer for this kind. */}
          <Link href={`/projects/${project.id}`} className={styles.cardLink}>
            {project.title}
          </Link>
        </h2>
        {crew > 0 && (
          <span
            className={styles.crew}
            data-crew-count={crew}
            // The count is the number; the label is what makes it mean
            // something to a reader who cannot see the dot beside it.
            aria-label={`${crew} live ${crew === 1 ? "agent" : "agents"} on this project`}
            title={project.assignments.map((a) => a.displayName).join(", ")}
          >
            <span className={styles.crewDot} aria-hidden="true" />
            {crew}
          </span>
        )}
      </div>

      {/* Null renders as nothing rather than as an empty line. */}
      {project.headline !== null && project.headline !== "" && (
        <p className={styles.headline}>{project.headline}</p>
      )}

      {project.childless ? (
        // **Not a bar at zero.** See the module header — this is the whole
        // honesty requirement, and it is a different sentence rather than a
        // different value, because the number 0 cannot say "there is
        // nothing here" no matter how it is styled.
        <p className={styles.suspect} data-suspect-reason="no-children">
          <span className={styles.suspectBadge}>Needs attention</span>
          <span className={styles.suspectText}>
            No work under this project yet — it cannot show progress or be completed until it has
            children.{" "}
            {/* The flag now leads somewhere. A condition a reader can see and
                cannot act on teaches them to ignore the flag; the project
                page carries the two repairs, and — just as importantly —
                what those repairs will and will not achieve. */}
            <Link href={`/projects/${project.id}`} className={styles.suspectLink}>
              Repair it
            </Link>
          </span>
        </p>
      ) : (
        <div className={styles.progressBlock}>
          <div className={styles.progressLabels}>
            <span className={styles.progressCount}>
              {project.merged} of {project.total} merged
            </span>
            {progress.kind === "ratio" && (
              <span className={styles.progressPercent}>{progress.percent}%</span>
            )}
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={project.total}
            aria-valuenow={project.merged}
            aria-label={`${project.merged} of ${project.total} children merged`}
          >
            <div
              className={styles.progressFill}
              data-percent={progress.kind === "ratio" ? progress.percent : 0}
              style={{ width: `${progress.kind === "ratio" ? progress.percent : 0}%` }}
            />
          </div>

          {/* The spread beneath the rollup — the thing a single summary
              state throws away. Each band is coloured from the state's own
              token, so a state that is amber here is amber on the board. */}
          <div className={styles.strip} aria-hidden="true" data-segments={segments.length}>
            {segments.map((segment) => (
              <span
                key={segment.state}
                className={styles.stripSegment}
                data-state={segment.state}
                style={{
                  width: `${segment.share * 100}%`,
                  background: stateTokens(segment.state).border,
                }}
                title={`${STATE_LABELS[segment.state]}: ${segment.count}`}
              />
            ))}
          </div>
          {/* The strip is decorative; this is the same information as text,
              so it is not lost to a reader who cannot see the bands. */}
          <p className={styles.stripLegend}>
            {segments
              .map((segment) => `${STATE_LABELS[segment.state]} ${segment.count}`)
              .join(" · ")}
          </p>
        </div>
      )}

      <div className={styles.meta}>
        <AreaChip area={project.area} />
        {project.repo !== null && (
          <span className={styles.repo} data-repo={project.repo}>
            {project.repo}
          </span>
        )}
        <span className={styles.activity}>{relativeTime(project.lastActivity, now)}</span>
      </div>

      {/* Presence — who holds this project right now, and how long since
          they last reported (M10 T16). Additive to the crew badge above
          rather than a replacement: the badge is the at-a-glance count
          (and stays exactly as tested), this is the per-holder detail —
          same split `ItemCard` draws between its priority chip and its
          presence rows. */}
      {project.assignments.length > 0 && (
        <ul className={styles.projectPresence}>
          {project.assignments.map((assignment) => (
            <li key={`${assignment.holderId}-${assignment.role}`} className={styles.presenceRow}>
              <AgentPresenceDot liveness={assignment.liveness} agentName={assignment.displayName} />
              <span className={styles.presenceName}>{assignment.displayName}</span>
              <span className={styles.presenceAge}>{relativeTime(assignment.lastActive, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
