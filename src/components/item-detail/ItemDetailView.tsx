// The presentational half of MILESTONES.md #72: the load/error/loaded
// branching, the item header, and the four sections.
//
// Deliberately prop-driven and hook-free rather than a `useItemDetail()`
// caller — same reasoning as `BoardView.tsx`: with `environment: "node"`
// and no DOM, a component that takes plain props can be called directly as
// a function and its returned tree inspected, which is what actually proves
// these branches. `ItemDetailContainer.tsx` is the thin client component
// that fetches and hands this one its props.
import type { DetailLoadState } from "@/lib/item-detail/state";
import { humanState, latestVerdict, showsOwnState, waitingReason } from "@/lib/item-detail/view";
import { columnTitle } from "@/lib/board/view";
import { SubtaskTree } from "./SubtaskTree";
import { ArtifactList } from "./ArtifactList";
import { HistoryList } from "./HistoryList";
import { SummaryPanel } from "./SummaryPanel";
import styles from "./ItemDetail.module.css";

export interface ItemDetailViewProps {
  readonly loadState: DetailLoadState;
}

export function ItemDetailView({ loadState }: ItemDetailViewProps) {
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
        <p>Loading this item…</p>
      </div>
    );
  }

  const { item, column, subtasks, artifacts, history, historyTruncated, summary } =
    loadState.detail;
  const reason = waitingReason(item);
  const verdict = latestVerdict(artifacts);

  return (
    <article className={styles.detail} data-item-id={item.id}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.priority} data-priority={item.priority}>
            {item.priority}
          </span>
          <span className={styles.kind}>{item.kind}</span>
          {/* The column is always shown and is the server's answer. For a
              project it is the ONLY honest position — its own `state` is a
              creation leftover (DECISIONS.md §13c) — so `showsOwnState`
              suppresses the raw state there rather than printing something
              that reads as fact. */}
          <span className={styles.column} data-column={column}>
            {columnTitle(column)}
          </span>
          {showsOwnState(item.kind) && (
            <span className={styles.state} data-state={item.state}>
              {humanState(item.state)}
            </span>
          )}
          {verdict !== null && (
            <span className={styles.verdict} data-latest-verdict={verdict}>
              {verdict.replace(/_/g, " ")}
            </span>
          )}
        </div>
        <h1 className={styles.title}>{item.title}</h1>
        <div className={styles.meta}>
          <span>{item.area}</span>
          {item.repo !== null && <span>{item.repo}</span>}
          {item.branch !== null && <span className={styles.sha}>{item.branch}</span>}
        </div>
        {reason !== null && <p className={styles.reason}>{reason}</p>}
        {item.body !== "" && <p className={styles.body}>{item.body}</p>}
      </header>

      <SubtaskTree subtasks={subtasks} />
      <ArtifactList artifacts={artifacts} />
      <HistoryList history={history} truncated={historyTruncated} />
      <SummaryPanel summary={summary} />
    </article>
  );
}
