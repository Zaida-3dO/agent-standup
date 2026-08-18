// The projects grid's load lifecycle — the fetch shaping and the
// loading/error/loaded branching, as plain functions.
//
// Split from the client component for the same reason `@/lib/board/state.ts`
// is: the harness runs `environment: "node"` with no DOM, so these branches
// are only directly testable outside a component. `Projects.tsx` is thin
// wiring over what is here.
import type { ProjectRollup, ProjectsPayload } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";

export type ProjectsLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; payload: ProjectsPayload };

/** An empty payload — what a malformed response degrades to rather than a crash. */
export function emptyProjects(): ProjectsPayload {
  return { projects: [], childlessCount: 0 };
}

/**
 * Fetches the grid. Throws a message fit to show directly — never a raw
 * `Response` or a JSON-parse error, matching `fetchBoardColumn`.
 *
 * **`childlessCount` is recomputed when the server omits it**, rather than
 * defaulted to zero. Zero is a claim — "nothing here is broken" — and it is
 * the one claim this screen must not make falsely, since the flag is the
 * entire reason a structurally suspect project is visible at all. Counting
 * the rows we actually have is true whatever the server sent.
 */
export async function fetchProjects(
  options: {
    readonly includeCompleted?: boolean;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<ProjectsPayload> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = new URLSearchParams();
  if (options.includeCompleted === true) query.set("includeCompleted", "true");
  const suffix = query.toString() === "" ? "" : `?${query.toString()}`;

  const response = await fetchImpl(uiApiPath(`/api/projects${suffix}`));
  if (!response.ok) {
    throw new Error(`Could not load projects (GET /api/projects returned ${response.status}).`);
  }
  const body = (await response.json()) as {
    projects?: readonly ProjectRollup[];
    childlessCount?: number;
  };
  const projects = body.projects ?? [];
  return {
    projects,
    childlessCount:
      typeof body.childlessCount === "number"
        ? body.childlessCount
        : projects.filter((project) => project.childless).length,
  };
}

/** Turns a caught value into the message the error state shows. */
export function projectsErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load projects.";
}
