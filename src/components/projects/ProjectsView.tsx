// The presentational half of the projects grid — MILESTONES.md #74: the
// load/error/loaded branching, the header, and the cards themselves.
//
// Deliberately prop-driven and hook-free rather than a `useProjects()`
// caller — same reasoning as `BoardView.tsx`: with `environment: "node"`
// and no DOM, a component that takes plain props can be called directly as
// a function and its returned tree inspected, which is what actually proves
// these branches. `Projects.tsx` is the thin client container that fetches
// and hands this component its props.
import type { ProjectsLoadState } from "@/lib/projects/state";
import { sortProjects } from "@/lib/projects/view";
import { ProjectCard } from "./ProjectCard";
import styles from "./Projects.module.css";

export interface ProjectsViewProps {
  readonly loadState: ProjectsLoadState;
  /** The clock, passed down so every card on one render agrees on "now". */
  readonly now: number;
  /** Whether finished projects are being shown, and how to toggle that. */
  readonly includeCompleted?: boolean;
  readonly onToggleCompleted?: () => void;
}

export function ProjectsView({
  loadState,
  now,
  includeCompleted,
  onToggleCompleted,
}: ProjectsViewProps) {
  if (loadState.status === "error") {
    return (
      <div className={styles.centered}>
        <p>{loadState.message}</p>
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className={styles.centered}>
        <p>Loading projects…</p>
      </div>
    );
  }

  const { projects, childlessCount } = loadState.payload;
  const ordered = sortProjects(projects);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.heading}>Projects</h1>
        <div className={styles.headerMeta}>
          {/* The count is the whole page's honesty check: it is taken from
              the payload, so it cannot disagree with the number of cards
              below it the way a hand-maintained heading would. */}
          <span className={styles.count} data-project-count={ordered.length}>
            {ordered.length} {ordered.length === 1 ? "project" : "projects"}
          </span>
          {childlessCount > 0 && (
            // Surfaced at the top rather than left to be discovered by
            // scrolling: this is a structural problem with the data, and a
            // reader should learn how much of the page is affected before
            // they start reading it as a status report.
            <span className={styles.suspectCount} data-childless-count={childlessCount}>
              {childlessCount} with no work under {childlessCount === 1 ? "it" : "them"}
            </span>
          )}
          {onToggleCompleted !== undefined && (
            <button type="button" className={styles.toggle} onClick={onToggleCompleted}>
              {includeCompleted === true ? "Hide finished" : "Show finished"}
            </button>
          )}
        </div>
      </header>

      {ordered.length === 0 ? (
        // An empty result and a failed one must not render identically —
        // this is the empty one, said plainly.
        <p className={styles.empty}>No projects to show.</p>
      ) : (
        <div className={styles.grid}>
          {ordered.map((project) => (
            <ProjectCard key={project.id} project={project} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
