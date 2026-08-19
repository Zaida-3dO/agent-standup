// Inline edit on the item detail page — M10 T10.
//
// Nothing else in the app can correct a stored field, so a badly-titled
// item stays badly titled without this. This is the pure half of that:
// what a draft looks like mid-edit, what `PATCH /api/items/{id}` is sent, and how
// the response or a failure is turned into what the page shows next. Split
// out for the same reason `@/lib/board/state.ts` is — this repo's harness
// runs `environment: "node"` with no DOM, so the fetch shaping and the
// success/failure branching are only directly testable as plain functions.
// The click handling and the `useState` that holds a draft mid-edit live in
// `ItemDetailContainer.tsx`.
//
// **Reuses `update_item`, not a new operation.** `PATCH /api/items/{id}`
// already accepts `title`, `headline`, `priority` and `area` — exactly the
// four fields this row asks for — so this is a client for an existing
// write, not a new one. See `src/lib/service/operations/update-item.ts`.
import { uiApiPath } from "@/lib/ui-proxy/path";
import type { Priority } from "@/lib/design/tokens";

/** The four fields this tab can edit in place — the subset of `update_item`'s input this page offers. */
export interface ItemEditFields {
  readonly title?: string;
  readonly headline?: string | null;
  readonly priority?: Priority;
  readonly area?: string;
}

export type EditOutcome =
  | { readonly ok: true; readonly item: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/**
 * Reads the service's error envelope out of a failed response.
 *
 * The service's own sentence is the useful one — `update_item` refuses a
 * blank title or an area that does not exist by naming the field — and
 * that is what belongs beside the input a reader is mid-edit on. The
 * status code is the fallback, not the first choice. Matches
 * `messageFromResponse` in `@/lib/admin/state.ts`, independently, because
 * that module lives under `src/lib/admin/` and importing across feature
 * boundaries for one helper would couple two screens that otherwise share
 * nothing.
 */
async function messageFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Body was not JSON; fall through to the status-based message.
  }
  return `The edit failed (${response.status}).`;
}

/**
 * Sends an edit — `PATCH /api/items/{id}` with only the fields the caller
 * named.
 *
 * **Only the changed field is sent, not the whole record.** `update_item`
 * patches only what it is told about (its own header: "an update patches
 * only what it names"), so a title edit sent alone cannot accidentally
 * blank a headline nobody was editing — the two inline controls are
 * independent by construction, not by care taken at each call site.
 */
export async function submitItemEdit(
  itemId: string,
  fields: ItemEditFields,
  fetchImpl: typeof fetch = fetch,
): Promise<EditOutcome> {
  const response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(itemId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!response.ok) {
    return { ok: false, message: await messageFromResponse(response) };
  }
  const body = (await response.json()) as { item?: Record<string, unknown> };
  return { ok: true, item: body.item ?? {} };
}

/**
 * Whether a title draft is worth submitting at all.
 *
 * `update_item`'s own schema refuses a blank title server-side
 * (`z.string().trim().min(1)`), but asking the server to reject an empty
 * box is a network round trip to learn what the draft already shows —
 * this is the client-side mirror of that one rule, so the Save control can
 * simply not be pressed rather than press-and-fail.
 */
export function titleDraftIsValid(draft: string): boolean {
  return draft.trim().length > 0;
}

/** The four fields this tab offers inline edit on — one at a time, per MILESTONES.md #72's "one field, one save". */
export type EditableField = "title" | "headline" | "priority" | "area";

/**
 * Which field, if any, is mid-edit right now — the container's whole edit
 * state for the header, as one value rather than four independent
 * booleans. Four booleans would allow "title and priority both editing at
 * once", a state the UI never shows and would have to actively prevent;
 * one-of-five makes it unrepresentable instead of merely disallowed.
 */
export type EditingField = EditableField | null;

/** What `PATCH` field name a draft of `field` becomes, and how to coerce the free-text draft into it. */
export function fieldForEdit(field: EditableField, draft: string): ItemEditFields {
  if (field === "title") return { title: draft };
  if (field === "headline") return { headline: draft.trim() === "" ? null : draft };
  if (field === "priority") return { priority: draft as ItemEditFields["priority"] };
  return { area: draft };
}

/**
 * The inline-edit wiring `ItemDetailView` and `StatusBlock` share — one bag
 * rather than eight separate props on each, because the four editable
 * fields (title, headline, priority, area) share one shape of interaction
 * (view → edit → save or cancel) and only one of them is ever mid-edit at a
 * time (`EditingField`). All optional: a caller that does not wire editing
 * still renders every field in its plain, read-only view.
 *
 * Lives here rather than on either component, so both can import the type
 * without importing each other — `StatusBlock` is rendered BY
 * `ItemDetailView`, so a type it needed FROM that module would be a cycle.
 */
export interface ItemEditProps {
  /** Which field is mid-edit, or `null` — see `EditingField`'s header for why this is one value, not four booleans. */
  readonly editingField?: EditingField;
  /** The in-progress edit's text, for whichever field `editingField` names. */
  readonly draft?: string;
  readonly onDraftChange?: (draft: string) => void;
  readonly onStartEdit?: (field: EditableField) => void;
  readonly onSaveEdit?: () => void;
  readonly onCancelEdit?: () => void;
  /** True while a save is in flight for the field named by `editingField`. */
  readonly saving?: boolean;
  /** The service's refusal message for the last failed save, if any. */
  readonly editError?: string | null;
  /** Live advice on a title draft (MILESTONES.md #131) — shown only while `editingField` is `"title"`. */
  readonly titleAdvice?: string | null;
}
