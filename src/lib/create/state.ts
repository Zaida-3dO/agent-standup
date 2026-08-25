// Quick create's pure half — T18: validation, request shaping, and the live
// title preview.
//
// Split from the component for the reason `src/lib/board/state.ts` and
// `src/lib/admin/state.ts` are: this repo's harness runs
// `environment: "node"` with no DOM, so the branching and the fetch shaping
// are only directly testable as plain functions. The component is wiring
// over these.
//
// Nothing here imports the service layer or the database client. Every call
// goes through `uiApiPath`, because a browser holds no credential and the
// API refuses a direct `/api/` call — see `src/lib/ui-proxy/path.ts`.
import { uiApiPath } from "@/lib/ui-proxy/path";
import { findTitleFindings, type TitleFinding } from "@/lib/item-title";
import { CREATE_KINDS, DEFAULT_PRIORITY, type CreateKind, type CreatePriority } from "./kinds";

/**
 * What the person has typed. Three fields, per the row: title, area,
 * priority — plus the kind being minted and the parent it needs.
 *
 * `parent` is one string covering both spellings (`projectId` and `taskId`)
 * because the dialog shows one parent input at a time; which body key it
 * becomes is `CREATE_KINDS`' decision, made at submit, not the form's.
 */
export interface QuickCreateDraft {
  readonly kind: CreateKind;
  readonly title: string;
  readonly area: string;
  readonly priority: CreatePriority;
  readonly parent: string;
}

/** An empty draft — what the dialog opens on. */
export function emptyDraft(kind: CreateKind = "task"): QuickCreateDraft {
  return { kind, title: "", area: "", priority: DEFAULT_PRIORITY, parent: "" };
}

/**
 * A reason this draft cannot be submitted, tied to the field that carries
 * it.
 *
 * Shaped like `TitleFinding` — a field, a rule, a message — so the dialog
 * renders a blocking error and a piece of title advice through the same
 * code path, and so a test can match on `rule` without reading prose.
 *
 * The distinction from a finding is what is done about it: a `BlockingIssue`
 * disables submit, a `TitleFinding` never does. That difference is the whole
 * design of `item-title.ts`, which advises rather than refuses because "reads
 * well to a person" has no predicate that is right about every string.
 */
export interface BlockingIssue {
  readonly field: "title" | "area" | "parent";
  readonly rule: string;
  readonly message: string;
}

/**
 * Every reason `draft` would be refused, checked before it is sent.
 *
 * These mirror refusals the server really makes — a missing `title` is
 * `title is required`, a missing `area` fails the `area`/`areas` XOR — so
 * the dialog can state them beside the field instead of the person
 * discovering them as a 400 after pressing a button.
 *
 * Returns *all* issues rather than the first, matching `findTitleFindings`:
 * a person fixing a form wants the whole picture in one pass.
 */
export function blockingIssues(draft: QuickCreateDraft): BlockingIssue[] {
  const issues: BlockingIssue[] = [];

  if (draft.title.trim() === "") {
    issues.push({
      field: "title",
      rule: "title_required",
      message: "A title is required.",
    });
  }
  // `commonCreateShape` requires exactly one of `area` or `areas`, so an
  // item with neither is refused. The dialog only ever sends `area`, so the
  // XOR reduces to "this one is present".
  if (draft.area.trim() === "") {
    issues.push({
      field: "area",
      rule: "area_required",
      message: "An area is required — it is how the board groups this item.",
    });
  }
  // A subtask is *defined* by having a parent and has no sentinel standing
  // in for one, so an empty parent is a refusal rather than a fallback. A
  // task's empty parent is not an issue at all: it resolves to the inbox.
  const spec = CREATE_KINDS[draft.kind];
  if (spec.parentField !== null && spec.parentFallback === null && draft.parent.trim() === "") {
    issues.push({
      field: "parent",
      rule: "parent_required",
      message: `A ${spec.parentLabel?.toLowerCase() ?? "parent"} is required — a subtask must belong to a task.`,
    });
  }

  return issues;
}

/** True when `draft` can be submitted — no blocking issue on any field. */
export function canSubmit(draft: QuickCreateDraft): boolean {
  return blockingIssues(draft).length === 0;
}

/**
 * What the card will actually read, and what is worth saying about it.
 *
 * The row asks for "a live preview of how it will read on a card", and calls
 * it "the cheapest possible moment to prevent the next 200 agent-shaped
 * titles". Two things make it worth showing rather than just echoing the
 * input:
 *
 *  * **`title` is normalised on the way in.** `commonCreateShape` applies
 *    `.trim()` and then `normalizeEmDash`, so what is stored is not always
 *    what was typed. A preview of the raw input would be a preview of the
 *    wrong string.
 *  * **The findings arrive before submit, not after.** `titleAdviceFor`
 *    already attaches this advice to a *successful* create — by which point
 *    the item exists and the person has moved on. Showing the same findings
 *    while the cursor is still in the field is the only moment the advice is
 *    cheap to act on.
 *
 * `findings` is empty when there is nothing to say — a real answer, not a
 * missing one.
 */
export interface TitlePreview {
  /** The title as the card will render it, or `null` when nothing has been typed. */
  readonly text: string | null;
  /** Everything the convention has to say about it. Empty is the good case. */
  readonly findings: readonly TitleFinding[];
}

/**
 * Normalises an em dash the way `commonCreateShape` does on the way in.
 *
 * Re-implemented rather than imported for the reason `INBOX_PROJECT_ID` is:
 * `@/lib/text-normalize` is reachable, but the preview only needs to agree
 * with it, and `tests/create-contract.test.ts` asserts that agreement
 * directly against the real function over a table of inputs. That makes the
 * duplication checked rather than trusted.
 */
function previewNormalize(title: string): string {
  return title.trim().replace(/—/g, "-");
}

/**
 * The live preview for `title` — what the card shows and what the convention
 * says.
 *
 * Deliberately does NOT report `too_short` on an empty field. An untouched
 * input is not a badly-written title, and a dialog that opens already
 * scolding the person has spent its one chance to be listened to.
 */
export function titlePreview(title: string): TitlePreview {
  const text = previewNormalize(title);
  if (text === "") return { text: null, findings: [] };
  return { text, findings: findTitleFindings(text) };
}

/**
 * The JSON body for `draft`, exactly as the operation's schema wants it.
 *
 * This is where the three undocumented requirements are paid, each on
 * purpose:
 *
 *  * **`originType: "auto"`** — required in practice though `.optional()` in
 *    the schema. `"auto"` and not `"person"`, because `"person"` additionally
 *    requires an `originPersonId` and the browser has no session declaring
 *    one; sending `"person"` without it is a refusal. `"auto"` is honest
 *    about what happened: a person pressed a button in a tool, and no
 *    identity was established.
 *  * **`body: ""`** — `body` is `z.string()` with no `.optional()`, so
 *    omitting it is `invalid_input`. A three-field dialog has no body to
 *    send, so it sends the empty one rather than nothing.
 *  * **the parent key** — `projectId` or `taskId` by kind, with `"inbox"`
 *    standing in for an unnamed project. Never both, and never a `parentId`:
 *    the schemas are `.strict()` and refuse an unrecognised key rather than
 *    ignoring it.
 *
 * `area` and never `areas`: exactly one of the two is required and supplying
 * both is refused rather than resolved by precedence.
 */
export function createRequestBody(draft: QuickCreateDraft): Record<string, unknown> {
  const spec = CREATE_KINDS[draft.kind];
  const body: Record<string, unknown> = {
    title: draft.title.trim(),
    // Required by the schema, and there is no field for it in a three-field
    // dialog. Empty rather than absent.
    body: "",
    area: draft.area.trim(),
    priority: draft.priority,
    // Enforced in the handler, invisible in the schema. See the header.
    originType: "auto",
  };

  if (spec.parentField !== null) {
    const named = draft.parent.trim();
    // `parentFallback` is `null` for a subtask, and `blockingIssues` has
    // already refused an empty one, so the `??` cannot yield null here for
    // a draft that passed validation.
    body[spec.parentField] = named === "" ? spec.parentFallback : named;
  }

  return body;
}

/**
 * The path a kind is created at, as the browser must call it.
 *
 * The `/api/` literal is composed here, inside the `uiApiPath` call, rather
 * than held ready-made in `kinds.ts`. That is what keeps the credential rule
 * enforced by construction: `tests/ui-proxy-paths.test.ts` requires every
 * `/api/` literal in front-end code to sit inside a `uiApiPath(` call, and
 * this is the only place in quick create where one appears.
 */
export function createPath(kind: CreateKind): string {
  return uiApiPath(`/api/${CREATE_KINDS[kind].collection}`);
}

/** The item a successful create returns — the slim write record. */
export interface CreatedItemSummary {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
}

/**
 * Reads the service's own sentence out of a failed response.
 *
 * The service's message is the useful one — it names the field and says what
 * was wrong — and the status is the fallback, not the first choice. Matches
 * `adminState`'s `messageFromResponse` for the same reason.
 */
async function messageFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Body was not JSON; fall through to the status-based message.
  }
  return `Could not create the item (${response.status}).`;
}

/**
 * Mints the item. Throws a message fit to show directly — never a raw
 * `Response` or a JSON-parse error.
 *
 * `fetchImpl` is injected the way every other fetcher here takes it, so a
 * test drives the whole shaping-and-refusal path without a server.
 */
export async function submitCreate(
  draft: QuickCreateDraft,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedItemSummary> {
  const response = await fetchImpl(createPath(draft.kind), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createRequestBody(draft)),
  });

  if (!response.ok) {
    throw new Error(await messageFromResponse(response));
  }

  const payload = (await response.json()) as { item?: CreatedItemSummary };
  const item = payload.item;
  if (item === undefined || typeof item.id !== "string") {
    // The create may well have succeeded, so this does not claim it failed —
    // it says the response could not be read, which is what is actually
    // known.
    throw new Error("The item was created but the response could not be read.");
  }
  return item;
}
