// Reading and writing the saved views over the settings adapter —
// MILESTONES.md #75. Same shape as `@/lib/budget-page/state.ts`, which is
// the existing precedent for a front-end surface that owns one settings key.
//
// **A failure to load is not a failure of the board.** Views are an
// accelerator, not the data, so a read that fails resolves to an empty list
// and the board renders — one that threw would take the whole screen down
// over a sidebar decoration. A *write* is different and reports its failure,
// because a reader who pressed "save" and was told nothing would believe the
// view exists until they came back and it did not.

import { uiApiPath } from "@/lib/ui-proxy/path";
import { SAVED_VIEWS_KEY, savedViewsSchema, type SavedViews } from "./saved-views";

/** The outcome of a write — a message when it failed, so the surface can say why. */
export type SavedViewsWriteOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

async function messageFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // A non-JSON error body is not itself worth reporting — the status is.
  }
  return `The write failed (${response.status}).`;
}

/**
 * Loads the saved views, resolving anything unusable to an empty list.
 *
 * The three ways it can be empty are deliberately collapsed here: never set,
 * set to something this build cannot parse, or a read that failed. All three
 * mean "no views to pin", and distinguishing them would put an error state
 * in the sidebar for a feature the reader may not use.
 */
export async function fetchSavedViews(fetchImpl: typeof fetch = fetch): Promise<SavedViews> {
  try {
    const response = await fetchImpl(
      uiApiPath(`/api/settings/${encodeURIComponent(SAVED_VIEWS_KEY)}`),
    );
    if (!response.ok) return [];
    const body = (await response.json()) as { value?: unknown };
    if (body.value === undefined || body.value === null) return [];
    const parsed = savedViewsSchema.safeParse(body.value);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Writes the whole list.
 *
 * Whole rather than per-view, because the setting *is* the list — a partial
 * write would need the server to merge, and a merge cannot express a
 * deletion. Sending what the surface holds keeps "what you see is what is
 * stored" true.
 *
 * Validated here before the request goes out so a bad list is refused with
 * the schema's own message rather than after a round trip. The server
 * validates it again; a client-side check is a convenience and never the
 * gate.
 */
export async function writeSavedViews(
  views: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<SavedViewsWriteOutcome> {
  const parsed = savedViewsSchema.safeParse(views);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: first?.message ?? "The views are not valid." };
  }

  const response = await fetchImpl(
    uiApiPath(`/api/settings/${encodeURIComponent(SAVED_VIEWS_KEY)}`),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: parsed.data }),
    },
  );
  if (!response.ok) return { ok: false, message: await messageFromResponse(response) };
  return { ok: true };
}
