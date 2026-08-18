// The presentational half of the item detail page: the load/error/loaded
// branching, the item header, and the six tabbed sections.
//
// Deliberately prop-driven and hook-free rather than a `useItemDetail()`
// caller — same reasoning as `BoardView.tsx`: with `environment: "node"`
// and no DOM, a component that takes plain props can be called directly as
// a function and its returned tree inspected, which is what actually proves
// these branches. `ItemDetailContainer.tsx` is the thin client component
// that fetches, owns the active tab, and hands this one its props.
//
// ── Why the sections are tabs ──────────────────────────────────────────
//
// Rendered as one column, the sections stack: a full subtask tree, then
// every artifact expanded, then every history event, then the summary. The
// page has no upper bound on its height, and — more damagingly — nothing on
// it is more prominent than anything else, so the item's live state sits at
// the same visual weight as a superseded review from three rounds ago.
//
// Tabs fix both at once. Only the active section occupies vertical space,
// and the reader chooses which question they are asking rather than
// scrolling past the answers to the other five. The header stays outside
// the tabs, because the identity of the item is the one thing that is true
// on every tab.
//
// **Every tab renders something honest.** A tab with nothing to show says
// why it is empty — "no summary, an item gets one when it is completed" —
// rather than rendering a blank panel, which a reader cannot distinguish
// from a section that failed to load.
import type { ReactNode } from "react";
import type { DetailLoadState } from "@/lib/item-detail/state";
import { artifactsForTab, latestVerdict, waitingReason } from "@/lib/item-detail/view";
import { DEFAULT_TAB, type DetailTab } from "@/lib/item-detail/tabs";
import { SubtaskTree } from "./SubtaskTree";
import { ArtifactList } from "./ArtifactList";
import { HistoryList } from "./HistoryList";
import { SummaryPanel } from "./SummaryPanel";
import { Markdown } from "./Markdown";
import { TabStrip, tabControlId, tabPanelId } from "./TabStrip";
import { StatusBlock } from "./StatusBlock";
import { statusSummary } from "@/lib/item-detail/status";
import styles from "./ItemDetail.module.css";

export interface ItemDetailViewProps {
  readonly loadState: DetailLoadState;
  /** Which section is showing. Defaults to Overview so a caller that does not track tabs still renders. */
  readonly activeTab?: DetailTab;
  /** Called when a reader picks a tab. Absent leaves the strip's anchors to navigate on their own. */
  readonly onTabChange?: (tab: DetailTab) => void;
  /**
   * What this render means by "now", in epoch ms — what the item's age is
   * measured against.
   *
   * A prop rather than a `Date.now()` call inside the tree, for the reason
   * `StatusBlock`'s header gives: an age is the one thing on this page that
   * changes without the data changing, so reading the clock here would make
   * the component non-deterministic and would mismatch between the server's
   * HTML and the first client render. Defaulted so a caller that does not
   * care still renders — the container passes a value it captured once.
   */
  readonly now?: number;
}

/**
 * The panel wrapper every tab's content sits in.
 *
 * A plain function returning an element rather than a nested component,
 * deliberately — the same reasoning `SummaryPanel`'s `entryGroup` gives: a
 * nested component would appear in the returned tree as an unrendered
 * *reference*, so the DOM-free harness could not walk inside it, and the
 * panels would be untestable without a renderer this harness does not have.
 */
function panel(tab: DetailTab, active: boolean, children: ReactNode) {
  // Inactive panels are not rendered at all, rather than rendered and
  // hidden with CSS. Hiding them would keep every section's cost on every
  // page — the whole history, the whole subtree — which is the thing the
  // tabs exist to stop, and it would leave the hidden content in the
  // accessibility tree and in a page search, where it reads as content the
  // reader can see and cannot find.
  if (!active) return null;
  return (
    <div
      className={styles.panel}
      id={tabPanelId(tab)}
      role="tabpanel"
      aria-labelledby={tabControlId(tab)}
      data-panel={tab}
    >
      {children}
    </div>
  );
}

export function ItemDetailView({
  loadState,
  activeTab = DEFAULT_TAB,
  onTabChange,
  now = 0,
}: ItemDetailViewProps) {
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
  // Everything the status block shows, derived in one pass — see
  // `@/lib/item-detail/status`. Derived here rather than inside the block so
  // the block stays a renderer of an already-decided answer.
  const status = statusSummary(loadState.detail, now);
  const reason = waitingReason(item);
  const verdict = latestVerdict(artifacts);
  const planArtifacts = artifactsForTab(artifacts, "plan");
  const reviewArtifacts = artifactsForTab(artifacts, "reviews");

  return (
    <article className={styles.detail} data-item-id={item.id} data-active-tab={activeTab}>
      <header className={styles.header}>
        {/* The title alone. The item's identity is the one thing true on
            every tab, so it sits outside them; the state/priority/column
            chips belong to the status block below, where they are one part
            of a larger answer rather than a row of their own. Rendering
            them here as well would show the same three chips twice. */}
        <h1 className={styles.title}>{item.title}</h1>
        <div className={styles.meta}>
          <span>{item.area}</span>
          {item.repo !== null && <span>{item.repo}</span>}
          {item.branch !== null && <span className={styles.sha}>{item.branch}</span>}
          {verdict !== null && (
            <span className={styles.verdict} data-latest-verdict={verdict}>
              {verdict.replace(/_/g, " ")}
            </span>
          )}
        </div>
        {/* The one-line reason an item gives for being in Waiting. Kept
            here as well as in the status block's blocked treatment: this
            covers `paused`, which is not a block and has no
            `blockedOnType`. */}
        {reason !== null && <p className={styles.reason}>{reason}</p>}
      </header>

      {/* ABOVE the tabs, deliberately — and this is the point of the whole
          block. Inside a tab it would answer "why is this stuck" only for
          the reader who already guessed which tab to open; the question is
          asked of every item, on arrival, before anything else. */}
      <StatusBlock item={item} column={column} status={status} now={now} />

      <TabStrip
        activeTab={activeTab}
        onTabChange={onTabChange}
        counts={{
          plan: planArtifacts.length,
          reviews: reviewArtifacts.length,
          subtasks: subtasks.length,
          activity: history.length,
        }}
      />

      {/* Overview — the item's own brief. This is where the markdown
          complaint actually bites: every imported item carries a full
          brief, and it is the longest markdown on the page. */}
      {panel(
        "overview",
        activeTab === "overview",
        item.body === "" ? (
          <p className={styles.empty}>This item has no description.</p>
        ) : (
          <Markdown source={item.body} />
        ),
      )}

      {/* Plan and Reviews are both artifact-derived. Each shows the
          artifacts, filtered to the kinds that answer its own question, so
          a reader reaches a plan or a review body from the tab that names
          it. `ArtifactList` renders each body as markdown. */}
      {panel("plan", activeTab === "plan", <ArtifactList artifacts={planArtifacts} />)}
      {panel("reviews", activeTab === "reviews", <ArtifactList artifacts={reviewArtifacts} />)}

      {panel("subtasks", activeTab === "subtasks", <SubtaskTree subtasks={subtasks} />)}

      {/* Activity — the event ledger. The list states outright when it has
          been truncated, rather than letting a capped list read as the
          whole history. */}
      {panel(
        "activity",
        activeTab === "activity",
        <HistoryList history={history} truncated={historyTruncated} />,
      )}

      {/* A summary exists only once an item has been completed (SCHEMA.md
          §5a), so `SummaryPanel` renders nothing at all when there is none
          — which on a tab of its own would be an empty panel. The tab says
          why it is empty instead. */}
      {panel(
        "summary",
        activeTab === "summary",
        summary === null ? (
          <p className={styles.empty}>No summary — an item gets one when it is completed.</p>
        ) : (
          <SummaryPanel summary={summary} />
        ),
      )}
    </article>
  );
}
