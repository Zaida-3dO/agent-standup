// The Standup home's Projects section: a card for every project with open
// work, then one line of names each for what is quiet, not started, or beyond
// the card cap. Nothing is dropped by a preview limit: a project is either a
// card or a name. Which list a project lands in is the view-model's decision.
import Link from "next/link";
import type { ProjectNameView, ProjectsView } from "@/lib/standup/view";
import { ProjectCard } from "./ProjectCard";
import { SectionError } from "./StandupParts";
import styles from "./Standup.module.css";

export interface ProjectGridProps {
  readonly view: ProjectsView;
  readonly onRetry: () => void;
}

const HEADING_ID = "standup-projects-heading";

/** "Quiet this week: a · b · c": a label and project names, each name its own link. */
function NameLine({
  label,
  names,
  trailing,
}: {
  readonly label: string;
  readonly names: readonly ProjectNameView[];
  readonly trailing?: React.ReactNode;
}) {
  if (names.length === 0 && trailing === undefined) return null;
  return (
    <p className={styles.nameLine}>
      {names.length > 0 && <span className={styles.nameLabel}>{label}</span>}
      {names.map((name) => (
        <Link key={name.id} href={name.href} className={styles.nameLink}>
          {name.title}
        </Link>
      ))}
      {trailing}
    </p>
  );
}

export function ProjectGrid({ view, onRetry }: ProjectGridProps) {
  if (view.status === "error") {
    return <SectionError title="Projects" message={view.message} onRetry={onRetry} />;
  }

  if (view.empty) {
    return (
      <section className={styles.projects} aria-labelledby={HEADING_ID}>
        <div className={styles.sectionHead}>
          <h2 id={HEADING_ID} className={styles.sectionTitle}>
            Projects
          </h2>
        </div>
        <div className={styles.emptyPanel}>
          <p className={styles.emptyLine}>
            No projects yet. Projects appear here as agents pick up work.
          </p>
          <Link href="/projects" className={styles.emptyLink}>
            Open projects
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.projects} aria-labelledby={HEADING_ID}>
      <div className={styles.sectionHead}>
        <h2 id={HEADING_ID} className={styles.sectionTitle}>
          Projects
        </h2>
        <span className={styles.sectionSub}>{view.activeText}</span>
        <ul className={styles.legend} aria-hidden="true">
          <li data-part="done">done</li>
          <li data-part="active">in progress</li>
          <li data-part="stuck">stuck or paused</li>
          <li data-part="todo">to do</li>
        </ul>
      </div>

      {view.cards.length > 0 && (
        <ul className={styles.grid}>
          {view.cards.map((card) => (
            <li key={card.id} className={styles.gridItem}>
              <ProjectCard card={card} />
            </li>
          ))}
        </ul>
      )}

      <NameLine label="Also active:" names={view.alsoActive} />
      <NameLine label="Quiet this week:" names={view.quiet} />
      <NameLine
        label="Not started:"
        names={view.notStarted}
        trailing={
          <Link href="/projects" className={styles.allProjects}>
            All projects <span aria-hidden="true">→</span>
          </Link>
        }
      />
    </section>
  );
}
