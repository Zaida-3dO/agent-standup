"use client";

// The thin container: fetches `GET /api/projects` and hands the result to
// `ProjectsView` as plain props. Kept deliberately empty of branching —
// see `ProjectsView.tsx`'s header for why the conditionals live there
// instead, where they are directly testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over one `service.call("get_projects", …)`
// (CLAUDE.md: "Every adapter is a thin shell over a service call"). Nothing
// under `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useEffect, useState } from "react";
import {
  fetchProjects,
  projectsErrorMessageFrom,
  type ProjectsLoadState,
} from "@/lib/projects/state";
import { ProjectsView } from "./ProjectsView";

export function Projects() {
  const [loadState, setLoadState] = useState<ProjectsLoadState>({ status: "loading" });
  const [includeCompleted, setIncludeCompleted] = useState(false);
  /**
   * The clock, sampled once per load rather than read inside each card.
   *
   * Reading `Date.now()` during render would produce a different tree on
   * the server than on the client for the same data — a hydration mismatch
   * — and would make every card on one page disagree about "now" by however
   * long the render took.
   */
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Deliberately NOT resetting to `loading` synchronously here. Doing so
    // is a cascading render (the effect runs after a render that already
    // painted), and it would also blank the grid on every toggle — the
    // previous results are still the truth until the new ones arrive, so
    // keeping them until then is both cheaper and less jarring than a
    // flash of "Loading projects…" over a page that already had content.
    fetchProjects({ includeCompleted })
      .then((payload) => {
        if (cancelled) return;
        setNow(Date.now());
        setLoadState({ status: "loaded", payload });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: projectsErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [includeCompleted]);

  return (
    <ProjectsView
      loadState={loadState}
      now={now}
      includeCompleted={includeCompleted}
      onToggleCompleted={() => setIncludeCompleted((current) => !current)}
    />
  );
}
