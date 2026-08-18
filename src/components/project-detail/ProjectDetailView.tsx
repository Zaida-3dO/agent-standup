// The presentational half of the project page — MILESTONES.md #75: the
// load/error/loaded branching, the header, the derived-state panel, the
// children, the blocked children, the activity feed, the cost slot and the
// repair panel.
//
// Deliberately prop-driven and hook-free rather than a `useProjectDetail()`
// caller — same reasoning as `BoardView.tsx` and `ProjectsView.tsx`: with
// `environment: "node"` and no DOM, a component that takes plain props can
// be called directly as a function and its returned tree inspected, which
// is what actually proves these branches.
//
// **Blocked children come before the children list, not after it.** Opening
// a project is usually an attempt to find what is stuck, and a blocked
// grandchild is invisible in a list of direct children — so the blocked
// section is its own region, fed by a server-side walk of the whole
// subtree, and it is placed where the reader looks first.
import Link from "next/link";
import type { ProjectDetailLoadState, RepairOutcome } from "@/lib/project-detail/state";
import {
  blockedReasonText,
  humanState,
  liveCrewOn,
  progressOf,
  relativeTime,
  sortChildren,
} from "@/lib/project-detail/view";
import { AreaChip } from "@/components/chips/AreaChip";
import { DerivedStatePanel } from "./DerivedStatePanel";
import { RepairPanel } from "./RepairPanel";
import styles from "./ProjectDetail.module.css";

export interface ProjectDetailViewProps {
  readonly loadState: ProjectDetailLoadState;
  /** The clock, passed in so every region on one render agrees on "now". */
  readonly now: number;
  readonly repairProjectId: string;
  readonly onRepairProjectIdChange: (value: string) => void;
  readonly repairParentId: string;
  readonly onRepairParentIdChange: (value: string) => void;
  readonly onRetype: () => void;
  readonly onReparent: () => void;
  readonly repairBusy?: boolean;
  readonly repairOutcome?: RepairOutcome | null;
}

export function ProjectDetailView({
  loadState,
  now,
  repairProjectId,
  onRepairProjectIdChange,
  repairParentId,
  onRepairParentIdChange,
  onRetype,
  onReparent,
  repairBusy = false,
  repairOutcome = null,
}: ProjectDetailViewProps) {
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
        <p>Loading project…</p>
      </div>
    );
  }

  const detail = loadState.detail;
  const children = sortChildren(detail.children);
  const crew = liveCrewOn(detail);
  const progress = progressOf(detail);

  return (
    <div className={styles.page} data-project-id={detail.project.id}>
      <header className={styles.header}>
        <p className={styles.breadcrumb}>
          <Link href="/projects" className={styles.breadcrumbLink}>
            Projects
          </Link>
        </p>
        <h1 className={styles.heading}>{detail.project.title}</h1>
        {/* Null renders as nothing rather than as an empty line. */}
        {detail.project.headline !== null && detail.project.headline !== "" && (
          <p className={styles.headline}>{detail.project.headline}</p>
        )}
        <div className={styles.headerMeta}>
          <AreaChip area={detail.project.area} />
          {detail.project.repo !== null && (
            <span className={styles.repo} data-repo={detail.project.repo}>
              {detail.project.repo}
            </span>
          )}
          {crew > 0 && (
            <span
              className={styles.crew}
              data-crew-count={crew}
              aria-label={`${crew} live ${crew === 1 ? "agent" : "agents"} on this project`}
            >
              <span className={styles.crewDot} aria-hidden="true" />
              {crew} live {crew === 1 ? "agent" : "agents"}
            </span>
          )}
          <span data-last-activity={detail.lastActivity}>
            {relativeTime(detail.lastActivity, now)}
          </span>
        </div>
      </header>

      <DerivedStatePanel
        derived={detail.derived}
        total={detail.total}
        merged={detail.merged}
        progress={progress}
      />

      <RepairPanel
        repair={detail.repair}
        projectId={repairProjectId}
        onProjectIdChange={onRepairProjectIdChange}
        parentId={repairParentId}
        onParentIdChange={onRepairParentIdChange}
        onRetype={onRetype}
        onReparent={onReparent}
        busy={repairBusy}
        outcome={repairOutcome}
      />

      {/* Blocked first — see the module header. Rendered only when there is
          something in it: an empty "Blocked" heading reads as a fault
          rather than as good news. */}
      {detail.blockedChildren.length > 0 && (
        <section className={styles.section} aria-label="Blocked work">
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Blocked</h2>
            <span
              className={styles.sectionCount}
              data-blocked-count={detail.blockedChildren.length}
            >
              {detail.blockedChildren.length}{" "}
              {detail.blockedChildren.length === 1 ? "item" : "items"}
            </span>
          </div>
          {/* Said explicitly, because a reader who assumes this lists direct
              children would take a short list as good news when the stuck
              work is two levels down. */}
          <p className={styles.sectionNote}>
            Anywhere under this project, at any depth — not only direct children.
          </p>
          <ul className={styles.list}>
            {detail.blockedChildren.map((blocked) => (
              <li key={blocked.id} className={styles.blocked} data-blocked-id={blocked.id}>
                <Link href={`/items/${blocked.id}`} className={styles.blockedTitle}>
                  {blocked.title}
                </Link>
                <span className={styles.blockedReason}>{blockedReasonText(blocked)}</span>
                <span className={styles.blockedMeta}>
                  {blocked.blockedOnType !== null && `waiting on ${blocked.blockedOnType} · `}
                  {relativeTime(blocked.updatedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section} aria-label="Children">
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Children</h2>
          <span className={styles.sectionCount} data-child-count={children.length}>
            {children.length} direct · {detail.total} in the whole subtree
          </span>
        </div>
        {children.length === 0 ? (
          // An empty result and a failed one must not render identically —
          // and this particular empty is the structural fault the repair
          // panel above addresses, so it says so rather than reading as an
          // ordinary "nothing here yet".
          <p className={styles.empty} data-empty-reason="no-children">
            Nothing under this project. Because a project&apos;s state derives from its children,
            there is nothing here to transition and nothing whose completion would resolve it.
          </p>
        ) : (
          <ul className={styles.list}>
            {children.map((child) => (
              <li
                key={child.id}
                className={`${styles.child}${child.childless ? ` ${styles.childSuspect}` : ""}`}
                data-child-id={child.id}
                // The same flag the grid's cards carry, for the same
                // reason and under the same name — a nested project with
                // nothing under it is stuck in exactly the way this page's
                // own subject is.
                data-childless={child.childless ? "true" : "false"}
              >
                <Link href={`/items/${child.id}`} className={styles.childTitle}>
                  {child.title}
                </Link>
                <span className={styles.childMeta}>
                  {/* A nested project has no state of its own, so its
                      derived column is shown instead of the leftover
                      default sitting on its row. */}
                  <span data-child-state={child.kind === "project" ? child.column : child.state}>
                    {child.kind === "project"
                      ? child.column.replace("_", " ")
                      : humanState(child.state)}
                  </span>
                  {child.kind === "project" && child.total > 0 && (
                    <span className={styles.childProgress}>
                      {child.merged}/{child.total} merged
                    </span>
                  )}
                  {child.childless && (
                    <span className={styles.childFlag} data-suspect-reason="no-children">
                      No work under it
                    </span>
                  )}
                  {child.assignments.length > 0 && (
                    <span className={styles.crew}>
                      <span className={styles.crewDot} aria-hidden="true" />
                      {child.assignments.map((a) => a.displayName).join(", ")}
                    </span>
                  )}
                  <span>{relativeTime(child.updatedAt, now)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-label="Recent activity">
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Recent activity</h2>
          <span className={styles.sectionCount}>across the whole subtree</span>
        </div>
        {detail.activity.length === 0 ? (
          <p className={styles.empty}>No activity recorded.</p>
        ) : (
          <ul className={styles.list}>
            {detail.activity.map((entry) => (
              <li key={entry.id} className={styles.activityRow} data-activity-id={entry.id}>
                <span className={styles.activityType}>{entry.type}</span>
                {/* Which item in the tree this happened on — an activity
                    feed over a subtree is unreadable without it. */}
                <Link href={`/items/${entry.itemId}`} className={styles.activityItem}>
                  {entry.itemTitle}
                </Link>
                <span className={styles.activityWhen}>{relativeTime(entry.ts, now)}</span>
                {entry.body !== null && entry.body !== "" && (
                  <span className={styles.activityBody}>{entry.body}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-label="Cost">
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Cost</h2>
        </div>
        {/* The slot a later task fills. Rendered as an explicit "not
            measured here yet" rather than left out: an absent section is
            indistinguishable from a section that loaded and found zero,
            and zero cost is a claim this page cannot make. */}
        <p className={styles.costSlot} data-cost-slot="pending">
          Cost for this project is not reported here yet.
        </p>
      </section>
    </div>
  );
}
