// What each kind of item needs in order to be minted, stated as data — T18
// quick create.
//
// The row this serves opens with the complaint that there is **no way to
// create an item from the UI at all**: `POST /api/items`, `/projects`,
// `/tasks` and `/subtasks` all exist and none had a form. This module is the
// half of the fix that does not touch the DOM.
//
// ── Why the three named operations, never `create_item` ──────────────────
//
// `create_item` is deprecated, and its own header says why: it inferred the
// kind from *whether a parent was passed*, so a caller that wanted a task
// and forgot the pointer received a project — an item whose kind it did not
// choose. `create_project`, `create_task` and `create_subtask` each name
// their intent, and each refuses rather than guesses. A new create surface
// picking the general operation would re-import the exact defect the split
// was made to remove, so this module maps a chosen kind onto the operation
// that names it and never resolves a kind from the shape of the input.
//
// ── Why the required fields are written down here ────────────────────────
//
// Three of them are required in a way the JSON schema does not advertise,
// and each has been discovered in this repository by being refused:
//
//   * **`originType`** parses as `.optional()` but is enforced in the
//     handler by `assertOriginResolved`, because a session that registered a
//     person supplies it and Zod validates before the transaction can read
//     that. So the schema cannot state it and a browser — which registers no
//     session — must always send it. `"auto"` is the safe value.
//   * **`body`** is `z.string()` with no `.optional()`. An omitted body is
//     an `invalid_input` refusal, not a null column. A three-field dialog
//     that collects no body must therefore send `""` deliberately.
//   * **`projectId`** on a task is required with one named escape hatch, the
//     literal `"inbox"`.
//
// Discovering these by being refused is a cost this repository has paid
// enough times to have written it down; a person filling in a form should
// not pay it again.
import { INBOX_PROJECT_ID } from "./inbox";

/** The kinds a person can mint from the UI. */
export type CreateKind = "project" | "task" | "subtask";

/**
 * One kind's minting contract: the operation that names it, the collection
 * it posts to, and the parent field it requires.
 *
 * `parentField` is `null` for a project and a field *name* for the other
 * two, rather than a boolean "needs a parent". The name is what the request
 * body is keyed on, and the two kinds spell it differently on purpose —
 * `projectId` for a task, `taskId` for a subtask — so a boolean would leave
 * the caller to re-derive a fact this table already holds.
 */
export interface CreateKindSpec {
  readonly kind: CreateKind;
  /** The service operation. Named for the record, and asserted against the registry in tests. */
  readonly operation: "create_project" | "create_task" | "create_subtask";
  /**
   * The API collection segment this kind is created by posting to — the
   * name alone (`projects`), never a full `/api/...` path.
   *
   * **Why the segment and not the path.** A front-end module naming an
   * `/api/` literal must wrap it in `uiApiPath` on the same expression, and
   * `tests/ui-proxy-paths.test.ts` enforces that by matching the wrapper and
   * its argument together. This module declares data and fetches nothing, so
   * there is no call here for the wrapper to sit on — `src/lib/admin/kinds.ts`
   * is in the same position and is handled with a named exemption. An
   * exemption is the worse option of the two here: the allowlist is pinned to
   * exactly five modules by a test, and every entry added to it is one more
   * place the credential rule is enforced by argument rather than by
   * construction. Holding the segment instead means the literal only ever
   * exists inside `createPath`'s `uiApiPath(...)` call, which the guard
   * already checks — so this stays honest with no exemption at all.
   */
  readonly collection: string;
  /** The body key naming this kind's parent, or `null` when it is a root. */
  readonly parentField: "projectId" | "taskId" | null;
  /** What to call the parent in a label, or `null` when there is none. */
  readonly parentLabel: string | null;
  /**
   * The value used when a parent is required and the person named none.
   *
   * Only a task has one — `"inbox"`, the sentinel `create_task` documents.
   * A subtask has no equivalent: "the inbox subtask" is not a thing that
   * exists, so a subtask without a task named is refused here rather than
   * filed somewhere arbitrary.
   */
  readonly parentFallback: string | null;
}

/** Every kind's contract, keyed by kind. */
export const CREATE_KINDS: Readonly<Record<CreateKind, CreateKindSpec>> = {
  project: {
    kind: "project",
    operation: "create_project",
    collection: "projects",
    parentField: null,
    parentLabel: null,
    parentFallback: null,
  },
  task: {
    kind: "task",
    operation: "create_task",
    collection: "tasks",
    parentField: "projectId",
    parentLabel: "Project",
    parentFallback: INBOX_PROJECT_ID,
  },
  subtask: {
    kind: "subtask",
    operation: "create_subtask",
    collection: "subtasks",
    parentField: "taskId",
    parentLabel: "Task",
    parentFallback: null,
  },
};

/** The kinds in the order the dialog offers them — broadest container first. */
export const CREATE_KIND_ORDER: readonly CreateKind[] = ["task", "project", "subtask"];

/** The priorities `commonCreateShape` accepts, in the order they are offered. */
export const CREATE_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export type CreatePriority = (typeof CREATE_PRIORITIES)[number];

/**
 * The priority applied when nobody chooses one.
 *
 * Matches `commonCreateShape.priority`'s own `.default("P2")`. Stated here
 * rather than left to the server so the dialog can *show* what will happen
 * — a default the person can see is a default they can disagree with.
 */
export const DEFAULT_PRIORITY: CreatePriority = "P2";
