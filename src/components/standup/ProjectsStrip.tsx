// The Standup home's "Projects at a glance" strip — a compact row of
// progress bars, linking into the full projects grid. Reuses
// `get_projects`'s rollup (`@/lib/projects/types`, `@/lib/projects/view`)
// rather than composing its own — the task's own instruction, and the same
// data `/projects` already renders. Hook-free and prop-driven; see
// `TopBar.tsx`'s header.
import Link from "next/link";
import type { ProjectsPayload } from "@/lib/projects/types";
import { progressOf, sortProjects } from "@/lib/projects/view";
import { EmptyState } from "@/components/states";
import styles from "./Standup.module.css";

export interface ProjectsStripProps {
  readonly payload: ProjectsPayload;
  readonly previewCount?: number;
}

export function ProjectsStrip({ payload, previewCount = 6 }: ProjectsStripProps) {
  const sorted = sortProjects(payload.projects);
  const preview = sorted.slice(0, previewCount);

  return (
    <section className={styles.block} aria-label="Projects at a glance">
      <div className={styles.blockHead}>
        <h2 className={styles.blockTitle}>Projects at a glance</h2>
      </div>

      {preview.length === 0 ? (
        <EmptyState kind="empty" noun="project" title="No projects yet" />
      ) : (
        <ul className={styles.projectStrip}>
          {preview.map((project) => {
            const progress = progressOf(project);
            return (
              <li key={project.id} className={styles.projectStripItem}>
                <Link href={`/projects/${project.id}`} className={styles.projectStripTitle}>
                  {project.title}
                </Link>
                {progress.kind === "ratio" ? (
                  <div className={styles.projectStripBar} aria-hidden="true">
                    <div
                      className={styles.projectStripFill}
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                ) : (
                  <span className={styles.projectStripEmpty}>no work yet</span>
                )}
                {progress.kind === "ratio" && (
                  <span className={styles.projectStripPercent}>{progress.percent}%</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Link href="/projects" className={styles.seeAll}>
        Open projects
      </Link>
    </section>
  );
}
