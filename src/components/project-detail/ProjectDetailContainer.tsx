"use client";

// The thin container: fetches `GET /api/projects/{id}`, owns the repair
// form's state, and hands everything to `ProjectDetailView` as plain props.
// Kept deliberately empty of branching — see that component's header for
// why the conditionals live there instead, where they are directly
// testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over one `service.call(…)`. Nothing under
// `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useCallback, useEffect, useState } from "react";
import {
  fetchProjectDetail,
  projectDetailErrorMessageFrom,
  reparentItem,
  retypeToTask,
  type ProjectDetailLoadState,
  type RepairOutcome,
} from "@/lib/project-detail/state";
import { ProjectDetailView } from "./ProjectDetailView";

export interface ProjectDetailContainerProps {
  readonly projectId: string;
}

export function ProjectDetailContainer({ projectId }: ProjectDetailContainerProps) {
  const [loadState, setLoadState] = useState<ProjectDetailLoadState>({ status: "loading" });
  /**
   * The clock, sampled once per load rather than read inside each row.
   *
   * Reading `Date.now()` during render would produce a different tree on
   * the server than on the client for the same data — a hydration mismatch
   * — and would make every row on one page disagree about "now" by however
   * long the render took.
   */
  const [now, setNow] = useState(0);
  const [repairProjectId, setRepairProjectId] = useState("");
  const [repairParentId, setRepairParentId] = useState("");
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairOutcome, setRepairOutcome] = useState<RepairOutcome | null>(null);
  /** Bumped after a successful repair, to re-read rather than patch local state — see `runRepair`. */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchProjectDetail(projectId)
      .then((detail) => {
        if (cancelled) return;
        setNow(Date.now());
        setLoadState({ status: "loaded", detail });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: projectDetailErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadToken]);

  const runRepair = useCallback(async (call: () => Promise<RepairOutcome>) => {
    setRepairBusy(true);
    setRepairOutcome(null);
    try {
      const outcome = await call();
      setRepairOutcome(outcome);
      // Re-read on success rather than patching the local copy. A repair
      // changes an item's kind, parent and depth, and the derived reading
      // of everything above it — reconstructing that in the browser would
      // be a second implementation of the rollup that could disagree with
      // the server's. A refusal changes nothing, so nothing is re-read.
      if (outcome.status === "done") setReloadToken((token) => token + 1);
    } catch (err: unknown) {
      // A transport failure is not an answer from the service, so it is
      // reported as a refusal with the message rather than thrown into an
      // error boundary that would blank the page the user is working on.
      setRepairOutcome({ status: "refused", message: projectDetailErrorMessageFrom(err) });
    } finally {
      setRepairBusy(false);
    }
  }, []);

  return (
    <ProjectDetailView
      loadState={loadState}
      now={now}
      repairProjectId={repairProjectId}
      onRepairProjectIdChange={setRepairProjectId}
      repairParentId={repairParentId}
      onRepairParentIdChange={setRepairParentId}
      onRetype={() => void runRepair(() => retypeToTask(projectId, repairProjectId.trim()))}
      onReparent={() =>
        void runRepair(() =>
          // An empty box means the top level, which is `null` and not the
          // empty string — the operation's schema rejects `""`, and
          // "top level" is a real choice a user makes by clearing the field.
          reparentItem(projectId, repairParentId.trim() === "" ? null : repairParentId.trim()),
        )
      }
      repairBusy={repairBusy}
      repairOutcome={repairOutcome}
    />
  );
}
