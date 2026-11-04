// `/` — the Standup home's presentational half. Load/error/loaded branching,
// then the page laid out from a finished view-model. Hook-free and
// prop-driven so this repo's DOM-free harness can call it directly
// (`tests/helpers/react-element.ts`), the same split `SinceLastVisitView` uses.
//
// Every rule (which clause a failed read drops, what counts as stuck, how a
// bar is cut) lives in `@/lib/standup/view`; the components here draw what
// they are given and decide nothing.
//
// DOM order is reading order: the sentence, Needs you, Stuck, Projects, Done.
// Desktop placement is done with CSS grid areas, so the keyboard path follows
// importance and not the column a panel happens to sit in.
import type { StandupLoadState } from "@/lib/standup/state";
import {
  buildStandupView,
  everySectionFailed,
  pageErrorMessage,
  type StandupView,
} from "@/lib/standup/view";
import { ErrorState } from "@/components/states";
import { BriefSentence } from "./BriefSentence";
import { DoneSincePanel } from "./DoneSincePanel";
import { NeedsYouPanel } from "./NeedsYouPanel";
import { ProjectGrid } from "./ProjectGrid";
import { StandupSkeleton } from "./StandupSkeleton";
import { StuckPanel, showsStuck } from "./StuckPanel";
import styles from "./Standup.module.css";

export interface StandupHomeViewProps {
  readonly loadState: StandupLoadState;
  readonly now: number;
  /** Re-runs the page load: behind every "Try again" on the page. */
  readonly onRetry: () => void;
}

export interface StandupPageProps {
  readonly view: StandupView;
  readonly onRetry: () => void;
}

/** The loaded page, drawn from a finished view-model. */
export function StandupPage({ view, onRetry }: StandupPageProps) {
  return (
    <section className={styles.page} aria-label="Standup">
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h1 className={styles.date}>Standup · {view.dateLine}</h1>
          <BriefSentence sentence={view.sentence} />
        </div>
        {view.spend !== null && <p className={styles.spend}>{view.spend}</p>}
      </header>

      <div className={styles.layout} data-has-stuck={showsStuck(view.stuck) ? "true" : "false"}>
        <div className={styles.areaNeeds}>
          <NeedsYouPanel view={view.needsYou} onRetry={onRetry} />
        </div>
        {showsStuck(view.stuck) && (
          <div className={styles.areaStuck}>
            <StuckPanel view={view.stuck} onRetry={onRetry} />
          </div>
        )}
        <div className={styles.areaProjects}>
          <ProjectGrid view={view.projects} onRetry={onRetry} />
        </div>
        <div className={styles.areaDone}>
          <DoneSincePanel view={view.done} sinceLabel={view.sinceLabel} onRetry={onRetry} />
        </div>
      </div>
    </section>
  );
}

export function StandupHomeView({ loadState, now, onRetry }: StandupHomeViewProps) {
  if (loadState.status === "loading") return <StandupSkeleton />;

  // `fetchStandup` never rejects: it settles every read on its own. When all
  // five fail there is nothing to draw, so that is the whole-page error too.
  if (loadState.status === "error" || everySectionFailed(loadState.data)) {
    const message =
      loadState.status === "error" ? loadState.message : pageErrorMessage(loadState.data);
    return (
      <section className={styles.page} aria-label="Standup">
        <header className={styles.head}>
          <div className={styles.headMain}>
            <h1 className={styles.date}>Standup</h1>
          </div>
        </header>
        <ErrorState message={message} centered />
        <div className={styles.errorActions}>
          <button type="button" className={styles.retry} onClick={onRetry}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  return <StandupPage view={buildStandupView(loadState.data, now)} onRetry={onRetry} />;
}
