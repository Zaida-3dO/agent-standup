// `/` — the Standup home's presentational half. Load/error/loaded branching
// plus the four blocks the task's brief names, exactly like
// `SinceLastVisitView`'s split: hook-free and prop-driven so this repo's
// DOM-free harness can call it directly (`tests/helpers/react-element.ts`).
import type { StandupLoadState } from "@/lib/standup/state";
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
        <NeedsYouBlock items={data.needsYou} now={now} />
        <InFlightBlock entries={data.inFlight} />
        <OvernightBlock report={data.overnight} now={now} />
        <ProjectsStrip payload={data.projects} />
      </div>
    </section>
  );
}
