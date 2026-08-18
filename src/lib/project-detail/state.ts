// The project page's load lifecycle and its two repair calls, as plain
// functions.
//
// Split from the client component for the same reason `@/lib/board/state.ts`
// and `@/lib/projects/state.ts` are: the harness runs `environment: "node"`
// with no DOM, so the fetch shaping and the loading/error/loaded branching
// are only directly testable outside a component. The container is thin
// wiring over what is here.
import { uiApiPath } from "@/lib/ui-proxy/path";
import type { ProjectDetail } from "./types";

export type ProjectDetailLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; detail: ProjectDetail };

/**
 * One project from `GET /api/projects/{id}`. Throws a message fit to show
 * directly — never a raw `Response` or a JSON-parse error, matching
 * `fetchProjects` and `fetchItemDetail`.
 *
 * **A missing collection is filled in, not trusted.** The server always
 * returns all of them, but a component mapping over `detail.children` on a
 * response missing it would crash on `undefined.map`; defaulting each to
 * empty makes a partial response render as an empty section instead of a
 * blank page.
 *
 * **`repair` defaults to the cautious reading**, not the permissive one: an
 * absent `historicalVerificationAvailable` becomes `false`, so a response
 * that does not say whether the verification window is open is treated as
 * though it is shut. The consequence of guessing wrong in that direction is
 * a warning the user did not strictly need; guessing the other way promises
 * a route to a closed item that the state machine will refuse.
 */
export async function fetchProjectDetail(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectDetail> {
  const response = await fetchImpl(uiApiPath(`/api/projects/${encodeURIComponent(id)}`));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`No such project: ${id}.`);
    }
    throw new Error(
      `Could not load this project (GET /api/projects/${id} returned ${response.status}).`,
    );
  }
  const body = (await response.json()) as { detail?: Partial<ProjectDetail> };
  const detail = body.detail ?? {};
  if (!detail.project) {
    throw new Error("Could not load this project (the response carried no project).");
  }
  const total = detail.total ?? 0;
  return {
    project: detail.project,
    derived: detail.derived ?? { column: "backlog", counts: emptyCounts(), causingChild: null },
    total,
    merged: detail.merged ?? 0,
    finished: detail.finished ?? 0,
    // `?? null`, never `?? 0` — see `progressOf`. Zero is a claim about work
    // that may not exist.
    progress: detail.progress ?? null,
    // Trusts the server's flag, and falls back to the arithmetic rather than
    // to `false`: a response missing the field should not assert that a
    // project with no children is fine.
    childless: detail.childless ?? total === 0,
    lastActivity: detail.lastActivity ?? "",
    children: detail.children ?? [],
    blockedChildren: detail.blockedChildren ?? [],
    assignments: detail.assignments ?? [],
    activity: detail.activity ?? [],
    repair: {
      childless: detail.repair?.childless ?? detail.childless ?? total === 0,
      historicalVerificationAvailable: detail.repair?.historicalVerificationAvailable ?? false,
    },
  };
}

/** A zero for every state — what a malformed distribution degrades to rather than a crash. */
export function emptyCounts(): ProjectDetail["derived"]["counts"] {
  return {
    someday: 0,
    on_deck: 0,
    planning: 0,
    plan_review: 0,
    executing: 0,
    in_review: 0,
    paused: 0,
    blocked: 0,
    merged: 0,
    research_done: 0,
    wont_do: 0,
    cancelled: 0,
  };
}

/** Turns a caught value into the message the error state shows. */
export function projectDetailErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load this project.";
}

/** What a repair attempt did — the shape the page renders after the call returns. */
export type RepairOutcome =
  | { readonly status: "done"; readonly message: string }
  | { readonly status: "refused"; readonly message: string };

/**
 * Reads the error out of a refused repair.
 *
 * The service's refusals are the most useful thing on the screen when a
 * repair fails — `hierarchy.no_retype_with_children` says exactly which
 * children have to move first, and `items.max_depth` says exactly how deep
 * the move would land. So the server's own message is surfaced verbatim
 * rather than replaced with a generic one; a rewritten message would throw
 * away the only text that says what to do next.
 */
async function refusalFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body.error?.message;
    if (typeof message === "string" && message.trim() !== "") return message;
  } catch {
    // Fall through — a refusal whose body is not JSON is still a refusal,
    // and reporting the status is more useful than reporting a parse error
    // the user can do nothing about.
  }
  return `The repair was refused (${response.status}).`;
}

/**
 * `retype_to_task` — turn this childless project into a task under
 * `projectId`.
 *
 * Resolves to a `RepairOutcome` rather than throwing on a refusal, because
 * a refusal here is an expected outcome with something to say, not an
 * exception: the guards refuse for reasons the user can act on. A transport
 * failure still throws, since that is not an answer from the service at all.
 */
export async function retypeToTask(
  id: string,
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepairOutcome> {
  const response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(id)}/retype`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) {
    return { status: "refused", message: await refusalFrom(response) };
  }
  return {
    status: "done",
    // States what changed and — just as importantly — what did not. The
    // item now has a state of its own; nothing has been done about whether
    // it can be closed.
    message:
      "Retyped to a task. It now has a state of its own and can be transitioned. Its recorded state was kept as it was.",
  };
}

/**
 * `reparent_item` — move this item under a different parent, or to the top
 * level with `parentId: null`.
 *
 * `parentId` is `string | null` and never optional, matching the operation:
 * `null` means "make this a top-level project", and an absent value is
 * invalid input rather than a synonym for it.
 */
export async function reparentItem(
  id: string,
  parentId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<RepairOutcome> {
  const response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(id)}/reparent`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentId }),
  });
  if (!response.ok) {
    return { status: "refused", message: await refusalFrom(response) };
  }
  return {
    status: "done",
    message:
      parentId === null
        ? "Moved to the top level. It is a project again, so its state derives from its children."
        : "Moved under the new parent. Its kind and depth were re-derived from where it now sits.",
  };
}
