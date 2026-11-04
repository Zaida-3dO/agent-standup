// `/` — the Standup home's presentational half. Load/error/loaded branching
// plus the four blocks the task's brief names, exactly like
// `SinceLastVisitView`'s split: hook-free and prop-driven so this repo's
// DOM-free harness can call it directly (`tests/helpers/react-element.ts`).
import type { SectionState, StandupLoadState } from "@/lib/standup/state";
import { ErrorState, LoadingState } from "@/components/states";
import { NeedsYouBlock } from "./NeedsYouBlock";
import { InFlightBlock } from "./InFlightBlock";
import { OvernightBlock } from "./OvernightBlock";
import { ProjectsStrip } from "./ProjectsStrip";
import styles from "./Standup.module.css";

export interface StandupHomeViewProps {
  readonly loadState: StandupLoadState;
  readonly now: number;
}

/**
 * A section whose own read failed: its title, then the short line saying why.
 * Sits in the grid where the section would have been, so the other three
 * blocks render exactly as they would have.
 */
export function SectionError({
  title,
  message,
}: {
  readonly title: string;
  readonly message: string;
}) {
  return (
    <section className={styles.block} aria-label={title} data-section-error="true">
      <div className={styles.blockHead}>
        <h2 className={styles.blockTitle}>{title}</h2>
      </div>
      <ErrorState message={message} />
    </section>
  );
}

/** Renders a loaded section with `render`, or its own error line. */
function renderSection<T>(
  title: string,
  section: SectionState<T>,
  render: (data: T) => React.ReactElement,
): React.ReactElement {
  return section.status === "loaded" ? (
    render(section.data)
  ) : (
    <SectionError title={title} message={section.message} />
  );
}

export function StandupHomeView({ loadState, now }: StandupHomeViewProps) {
  if (loadState.status === "loading") {
    return (
      <section className={styles.page} aria-label="Standup">
        <h1 className={styles.pageTitle}>Standup</h1>
        <LoadingState rows={4} label="the standup digest" />
      </section>
    );
  }

  if (loadState.status === "error") {
    return (
      <section className={styles.page} aria-label="Standup">
        <h1 className={styles.pageTitle}>Standup</h1>
        <ErrorState message={loadState.message} centered />
      </section>
    );
  }

  const { data } = loadState;

  return (
    <section className={styles.page} aria-label="Standup">
      <h1 className={styles.pageTitle}>Standup</h1>
      <div className={styles.grid}>
        {renderSection("Needs you", data.needsYou, (items) => (
          <NeedsYouBlock items={items} now={now} />
        ))}
        {renderSection("In flight now", data.inFlight, (entries) => (
          <InFlightBlock entries={entries} />
        ))}
        {renderSection("Last 24 hours", data.overnight, (report) => (
          <OvernightBlock report={report} now={now} />
        ))}
        {renderSection("Projects at a glance", data.projects, (payload) => (
          <ProjectsStrip payload={payload} />
        ))}
      </div>
    </section>
  );
}
