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

  const { projects } = loadState.payload;
  const ordered = sortProjects(projects);
  // Projects with nothing under them are normal, not a fault, so they sit in
  // their own quiet section below the rest — the way finished work is set
  // apart — rather than leading the page or carrying a warning.
  const active = ordered.filter((project) => !project.childless);
  const notStarted = ordered.filter((project) => project.childless);

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
        <>
          {active.length > 0 && (
            <div className={styles.grid}>
              {active.map((project) => (
                <ProjectCard key={project.id} project={project} now={now} />
              ))}
            </div>
          )}
          {notStarted.length > 0 && (
            <section className={styles.quietSection} data-section="not-started">
              <h2 className={styles.quietHeading} data-not-started-count={notStarted.length}>
                {`Not started (${notStarted.length})`}
              </h2>
              <div className={styles.grid}>
                {notStarted.map((project) => (
                  <ProjectCard key={project.id} project={project} now={now} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
