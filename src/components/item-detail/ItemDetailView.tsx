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
// scrolling past the answers to the others. The header stays outside
// the tabs, because the identity of the item is the one thing that is true
// on every tab.
//
// **Every tab renders something honest.** A tab with nothing to show says
// why it is empty — "no summary, an item gets one when it is completed" —
// rather than rendering a blank panel, which a reader cannot distinguish
// from a section that failed to load.
import type { ReactNode } from "react";
import type { DetailLoadState } from "@/lib/item-detail/state";
import type { DetailHistoryEntry } from "@/lib/item-detail/types";
import {
  artifactsForTab,
  currentTipCommitSha,
  isUnverifiedOrigin,
  latestVerdict,
  newestVerification,
  waitingReason,
} from "@/lib/item-detail/view";
import { primaryLine, hasDistinctHeadline } from "@/lib/item-headline-display";
import { DEFAULT_TAB, type DetailTab } from "@/lib/item-detail/tabs";
import type { ItemEditProps } from "@/lib/item-detail/edit-state";
import type { EventType } from "@/lib/events";
import { boardLinkFor } from "@/lib/item-detail/board-link";
import { SubtaskTree } from "./SubtaskTree";
import { HistoryList } from "./HistoryList";
import { PlanPanel } from "./PlanPanel";
import { ReviewsPanel } from "./ReviewsPanel";
import { AgentPanel, type AgentPanelState } from "./AgentPanel";
import { SummaryPanel } from "./SummaryPanel";
import { Markdown } from "./Markdown";
import { VerdictBadge } from "./VerdictBadge";
import { TrustBadge } from "@/components/chips/TrustBadge";
import { VerifyStateAction, type VerifyStateStatus } from "./VerifyStateAction";
import { TabStrip, tabControlId, tabPanelId } from "./TabStrip";
import { StatusBlock } from "./StatusBlock";
import { ArchiveAction, type ArchiveActionState } from "./ArchiveAction";
import { CancelAction, type CancelActionState } from "./CancelAction";
import { isAlreadyClosed } from "@/lib/item-detail/cancel-state";
import { InlineEditField } from "./InlineEditField";
import { ChipLink } from "./ChipLink";
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
  /**
   * The agent view's own load state — separate from `loadState` because
   * `orientation` is a second, much more expensive read that is only made
   * when a reader asks for it. Defaults to idle so a caller that does not
   * wire it still renders every tab.
   */
  readonly agentState?: AgentPanelState;
  /** Fetches the agent view. Absent renders that panel read-only. */
  readonly onLoadAgentView?: () => void;
  /** Inline edit on title, headline, priority and area — see `ItemEditProps`. */
  readonly edit?: ItemEditProps;
  /** The Activity tab's own state — which event type is filtered and which page is showing. See `HistoryList`. */
  readonly historyTypeFilter?: EventType | null;
  readonly onHistoryTypeFilterChange?: (type: EventType | null) => void;
  readonly historyPage?: number;
  readonly onHistoryPageChange?: (page: number) => void;
  /**
   * History fetched from the server *beyond* the detail payload's window
   * (T24), appended after it. Separate from `detail.history` so the
   * snapshot the rest of the screen was drawn from stays identifiable —
   * see `ItemDetailContainer`'s own note on why the two are not merged
   * upstream.
   */
  readonly olderHistory?: readonly DetailHistoryEntry[];
  /** Asks for the next page of older entries. */
  readonly onLoadOlderHistory?: () => void;
  readonly loadingOlderHistory?: boolean;
  readonly olderHistoryError?: string | null;
  /** Whether anything older than what is shown remains to be fetched. */
  readonly hasOlderHistory?: boolean;
  /**
   * The "confirm state" action's own submit state (MILESTONES.md #131).
   * Defaults to idle so a caller that does not wire it still renders the
   * button — same convention as `agentState`.
   */
  /**
   * Archive and restore — the affordance `restore_item` was built for.
   *
   * Optional like every other action on this view, and for the same
   * documented reason: a caller that wires no handlers gets a read-only
   * page rather than controls that do nothing when pressed. `ItemDetailView`
   * is rendered in tests and fragments that have no container behind them.
   */
  readonly archive?: ItemDetailArchiveProps;
  /**
   * The cancel affordance, wired the same optional way `archive` is and for
   * the same reason — a view rendered without a container behind it shows no
   * control rather than a control that does nothing.
   */
  readonly cancel?: ItemDetailCancelProps;
  readonly verifyStateStatus?: VerifyStateStatus;
  /**
   * Records a check of the item's `state` — `agrees` or `disagrees` with
   * what is stored. Absent hides the action entirely rather than rendering
   * a button that does nothing, which is the same "read-only when unwired"
   * rule `onLoadAgentView` follows.
   */
  readonly onVerifyState?: (outcome: "agrees" | "disagrees") => void;
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

/** Everything the cancel affordance needs, as one prop rather than five. */
export interface ItemDetailCancelProps {
  readonly state: CancelActionState;
  readonly onBegin: () => void;
  readonly onDismiss: () => void;
  readonly onDecisionChange: (decision: string) => void;
  readonly onCancelItem: () => void;
}

/** Everything the archive/restore affordance needs, as one prop rather than seven. */
export interface ItemDetailArchiveProps {
  readonly state: ArchiveActionState;
  readonly onBeginArchive: () => void;
  readonly onCancel: () => void;
  readonly onReasonChange: (reason: string) => void;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
  readonly onAcknowledge: () => void;
}

export function ItemDetailView({
  loadState,
  activeTab = DEFAULT_TAB,
  onTabChange,
  now = 0,
  agentState = { status: "idle" },
  onLoadAgentView,
  edit = {},
  historyTypeFilter = null,
  onHistoryTypeFilterChange,
  historyPage = 0,
  onHistoryPageChange,
  olderHistory = [],
  onLoadOlderHistory,
  loadingOlderHistory = false,
  olderHistoryError = null,
  hasOlderHistory = false,
  verifyStateStatus = { status: "idle" },
  onVerifyState,
  archive,
  cancel,
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
  // MILESTONES.md #131: the header leads with `headline` where one exists,
  // never rewriting `title` — see `item-headline-display.ts`'s header for
  // why. `project`/`task`/`subtask` all carry `originType`, so the trust
  // marker is unconditional here, unlike the board card's `entry.trust`,
  // which is `null` for a project entry specifically because THAT read
  // never resolves a per-item origin — the detail read for one item
  // always has it.
  const distinctHeadline = hasDistinctHeadline(item);
  const unverified = isUnverifiedOrigin(item.originType);
  const verification = newestVerification(artifacts);
  const tipCommitSha = currentTipCommitSha(artifacts);

  const editingTitle = edit.editingField === "title";
  const editingHeadline = edit.editingField === "headline";
  const draft = edit.draft ?? "";

  return (
    <article className={styles.detail} data-item-id={item.id} data-active-tab={activeTab}>
      <header className={styles.header}>
        {/* The title alone. The item's identity is the one thing true on
            every tab, so it sits outside them; the state/priority/column
            chips belong to the status block below, where they are one part
            of a larger answer rather than a row of their own. Rendering
            them here as well would show the same three chips twice.

            Inline-editable (M10 T10): every item is minted by an agent and
            nothing in the UI could correct one, so a badly-titled item
            stays badly titled. `<h1>` is preserved in view mode; in edit
            mode `InlineEditField` renders its own control, so the
            heading's semantics are not lost, only interrupted for the
            duration of the edit.

            **View mode shows `primaryLine(item)`, not raw `item.title`**
            (MILESTONES.md #131) — the same headline-first rule the board
            card follows, and for the same reason: an imported title is a
            work order written for an agent, so the heading a person reads
            first should be the BLUF where one has been written. Editing
            still targets the real `title` field underneath — a reader
            fixing a bad title corrects the stored value, never the derived
            display line, which is why `editingTitle` reads `item.title`
            unchanged below. */}
        {editingTitle ? (
          <div className={styles.title}>
            <InlineEditField
              label="Title"
              value={item.title}
              kind="text"
              editing
              draft={draft}
              onDraftChange={edit.onDraftChange}
              onSave={edit.onSaveEdit}
              onCancel={edit.onCancelEdit}
              saving={edit.saving}
              error={edit.editError}
              advice={edit.titleAdvice}
            />
          </div>
        ) : (
          <h1 className={styles.title}>
            {primaryLine(item)}
            {edit.onStartEdit && (
              <button
                type="button"
                className={styles.inlineEditButton}
                aria-label="Edit title"
                onClick={() => edit.onStartEdit?.("title")}
              >
                Edit
              </button>
            )}
          </h1>
        )}
        {/* `title` demoted to a secondary line — ONLY when `headline` has
            taken the primary spot above, exactly the board card's own
            rule. Skipped while editing the title itself: the edit control
            already shows the real value being changed, so repeating it
            here would be the same fact rendered twice mid-edit. */}
        {!editingTitle && distinctHeadline && <p className={styles.sourceTitle}>{item.title}</p>}

        {/* The headline — the one-line BLUF (MILESTONES.md #107) — gets
            its own inline edit row rather than sharing the title's, since
            the two are independent fields with independent saves. */}
        <div className={styles.meta} data-field="headline">
          <InlineEditField
            label="Headline"
            value={item.headline}
            kind="text"
            editing={editingHeadline}
            draft={draft}
            onDraftChange={edit.onDraftChange}
            onStartEdit={edit.onStartEdit ? () => edit.onStartEdit?.("headline") : undefined}
            onSave={edit.onSaveEdit}
            onCancel={edit.onCancelEdit}
            saving={edit.saving}
            error={editingHeadline ? edit.editError : null}
          />
        </div>

        {/* The trust marker (#131) — a verified state and an unverifiable
            one must not render identically, #123's rule applied to a
            single header rather than a whole column. */}
        {unverified && (
          <div className={styles.trustRow} data-region="trust">
            <TrustBadge
              verified={verification !== null}
              checkedAt={verification?.checkedAt}
              checkedByType={verification?.checkedByType}
              checkedById={verification?.checkedById}
            />
          </div>
        )}
        <div className={styles.meta}>
          {/* Area and repo are links back to `/board`, pre-filtered to
              this value (M10 T10) — "what else is in this area" becomes
              one click. See `boardLinkFor`'s header for the contract this
              targets. */}
          <ChipLink
            href={boardLinkFor("area", item.area)}
            label={`Filter the board by area: ${item.area}`}
          >
            <span>{item.area}</span>
          </ChipLink>
          {item.repo !== null && (
            <ChipLink
              href={boardLinkFor("repo", item.repo)}
              label={`Filter the board by repo: ${item.repo}`}
            >
              <span>{item.repo}</span>
            </ChipLink>
          )}
          {item.branch !== null && <span className={styles.sha}>{item.branch}</span>}
          {/* The LATEST verdict, as its tier rather than as an
              underscore-stripped string — the difference between "merge it"
              and "merge it, and something else must still happen" is the
              substance of what a reviewer said, and it was being flattened
              in exactly the place a reader glances at first. */}
          {verdict !== null && (
            <span data-latest-verdict={verdict}>
              <VerdictBadge verdict={verdict} />
            </span>
          )}
        </div>
        {/* The one-line reason an item gives for being in Waiting. Kept
            here as well as in the status block's blocked treatment: this
            covers `paused`, which is not a block and has no
            `blockedOnType`. */}
        {reason !== null && <p className={styles.reason}>{reason}</p>}
        {/* The "confirm state" action — offered only on an unverified item,
            and only when the caller wired a handler (the read-only rule
            `onLoadAgentView` already follows). `tipCommitSha` tells the
            action whether it can be offered at all: `record_artifact`
            refuses a `historical_verification` naming no commit, so a
            `null` here means the button says why rather than failing on
            the server after the click. */}
        {unverified && onVerifyState && (
          <VerifyStateAction
            tipCommitSha={tipCommitSha}
            status={verifyStateStatus}
            onConfirm={onVerifyState}
          />
        )}
      </header>

      {/* ABOVE the tabs, deliberately — and this is the point of the whole
          block. Inside a tab it would answer "why is this stuck" only for
          the reader who already guessed which tab to open; the question is
          asked of every item, on arrival, before anything else. */}
      <StatusBlock item={item} column={column} status={status} now={now} edit={edit} />

      {/* ABOVE the tabs for the same reason the status block is, and one of
          its own. An archived item is still served at this URL by design —
          that is how a stale link lands somewhere real rather than at a hole
          — so a reader can be standing on an archived row with nothing else
          on the page saying so. The notice has to be where they are already
          looking, not inside a tab they have no reason to open.

          Rendered only when the caller wired handlers, the read-only rule
          `onVerifyState` and `onLoadAgentView` already follow. */}
      {/* ── Closing this item: two acts, presented as two acts ───────────

          Cancel comes FIRST, and the order is an argument rather than a
          layout choice. It is the commoner and the safer of the two — the
          distinction the whole pair exists for is "I had this task, I wanted
          to do it, I decided not to; that's cancel, not archive" — and until
          this block existed only archive had a control, so the destructive
          act was the one a person found. Putting the likelier-correct act
          first is what stops archive being chosen for being the only thing on
          screen.

          They are separated by a rule rather than stacked flush, because four
          buttons in one undivided group is precisely the "two buttons that
          look alike" failure both components are written to avoid. Neither is
          offered on an archived row: the archived notice stands alone there,
          and cancelling a hidden row is not an act with a meaning. */}
      {cancel && item.archivedAt === null && (
        <div className={styles.closingActions} data-region="closing-actions">
          <CancelAction
            alreadyClosed={isAlreadyClosed(item.state)}
            state={item.state}
            cancelState={cancel.state}
            onBegin={cancel.onBegin}
            onDismiss={cancel.onDismiss}
            onDecisionChange={cancel.onDecisionChange}
            onCancelItem={cancel.onCancelItem}
          />
        </div>
      )}

      {archive && (
        <div
          className={
            // The divider is only meaningful when something sits above it.
            cancel && item.archivedAt === null ? styles.closingActionsDivider : undefined
          }
        >
          <ArchiveAction
            archived={item.archivedAt !== null}
            archivedReason={item.archivedReason}
            supersededById={item.supersededById}
            state={archive.state}
            onBeginArchive={archive.onBeginArchive}
            onCancel={archive.onCancel}
            onReasonChange={archive.onReasonChange}
            onArchive={archive.onArchive}
            onRestore={archive.onRestore}
            onAcknowledge={archive.onAcknowledge}
          />
        </div>
      )}

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

      {/* Plan and Reviews are both artifact-derived, filtered to the kinds
          that answer each tab's own question — but they are NOT the same
          rendering. A plan is a document with a history, so it is ranked:
          a bottom line, the live snapshot, the superseded ones collapsed. A
          review is an assessment, so it leads with its verdict tier and its
          graded findings. Rendering both as one generic artifact list was
          what buried the live plan under three dead ones and flattened
          every verdict into "this passed". */}
      {panel("plan", activeTab === "plan", <PlanPanel artifacts={planArtifacts} />)}
      {panel("reviews", activeTab === "reviews", <ReviewsPanel artifacts={reviewArtifacts} />)}

      {panel("subtasks", activeTab === "subtasks", <SubtaskTree subtasks={subtasks} />)}

      {/* Activity — the event ledger. The list states outright when it has
          been truncated, rather than letting a capped list read as the
          whole history. */}
      {panel(
        "activity",
        activeTab === "activity",
        <HistoryList
          /* The detail payload's window plus every older page fetched
             since, in one newest-first list. Concatenated here rather than
             in the container so `detail.history` stays exactly what the
             server sent for the snapshot. */
          history={olderHistory.length === 0 ? history : [...history, ...olderHistory]}
          /* The static "this is only the newest N" notice is shown only
             while there is genuinely no way to reach the rest. Once the
             reader can fetch older pages, the pager's own "Load older"
             affordance says it better — and leaving both up would tell a
             reader the entries are unreachable while offering a button
             that reaches them. */
          truncated={historyTruncated && !hasOlderHistory && olderHistory.length === 0}
          onLoadOlder={onLoadOlderHistory}
          loadingOlder={loadingOlderHistory}
          olderError={olderHistoryError}
          hasOlder={hasOlderHistory}
          typeFilter={historyTypeFilter}
          onTypeFilterChange={onHistoryTypeFilterChange}
          page={historyPage}
          onPageChange={onHistoryPageChange}
        />,
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

      {/* Agent view — `orientation` for this item, which is what the fleet
          reads when it picks the work up. Its own load state, because it is
          a second and far more expensive read than the detail; see
          `AgentPanel` for why it is not fetched on arrival. */}
      {panel(
        "agent",
        activeTab === "agent",
        <AgentPanel state={agentState} onLoad={onLoadAgentView} />,
      )}
    </article>
  );
}
