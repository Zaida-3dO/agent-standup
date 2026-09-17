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
import { bandsOf, countsOf, liveCrewCount, progressOf, relativeTime } from "@/lib/projects/view";
import { projectBoardHref } from "@/lib/board/filters";
import { AreaChip } from "@/components/chips/AreaChip";
import { RepoChip } from "@/components/chips/RepoChip";
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
  const bands = bandsOf(project.counts, project.total);
  const tally = countsOf(project.counts, project.total);
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
          {/* **The card leads to the BOARD scoped to this project, not to
              the project page.** The grid answers "what projects are
              there"; the question a reader has after choosing one is "what
              is the work under it", and that is a board rather than a
              rollup. The project's own ROW on the board is the way to its
              detail page, so both destinations stay reachable and each is
              reached from the surface where it is the obvious next step.

              Never `/items/{id}` either way — a project's own row has no
              state to show, so the item view would render the leftover
              default `create_item` writes. */}
          <Link href={projectBoardHref(project.id)} className={styles.cardLink}>
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
            {/* "Closed", not "merged" — the number counts every terminal
                state, and calling it merged invited exactly the reading
                this card is being fixed for. */}
            <span className={styles.progressCount}>
              {tally.done} of {project.total} closed
            </span>
            {progress.kind === "ratio" && (
              <span className={styles.progressPercent}>{progress.percent}%</span>
            )}
          </div>
          {/* **One bar, three bands** — see `bandsOf`. Done and started are
              drawn as widths off the same total, and whatever is left of the
              track is the backlog remainder. */}
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={project.total}
            aria-valuenow={tally.done}
            aria-label={`${tally.done} of ${project.total} children closed, ${tally.started} started, ${tally.backlog} in backlog`}
          >
            <div
              className={styles.progressFill}
              data-band="done"
              data-percent={progress.kind === "ratio" ? progress.percent : 0}
              style={{ width: `${bands.done * 100}%` }}
            />
            <div
              className={styles.progressActive}
              data-band="started"
              style={{ width: `${bands.started * 100}%` }}
            />
          </div>

          {/* The bands as text, so nothing here is lost to a reader who
              cannot see colour. Three numbers that sum to the total, under
              the board's own column names. */}
          <p className={styles.stripLegend}>
            Backlog {tally.backlog} · Started {tally.started} · Done {tally.done}
          </p>
        </div>
      )}

      <div className={styles.meta}>
        <AreaChip area={project.area} />
        {project.repo !== null && <RepoChip repo={project.repo} />}
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
