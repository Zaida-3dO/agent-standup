// What item the palette's state verbs act on, and where its state comes
// from.
//
// ── Why the state is fetched rather than read off the page ──────────────
//
// The "change state" verb sends `expectedFrom` (MILESTONES.md #257), and a
// precondition is only worth sending if it is TRUE. `@/lib/undo/actions`
// makes the same point about its own `from`: it must be the server's value
// and not the UI's guess, because a precondition built from a guess turns a
// safety check into a rubber stamp — it would agree with whatever the page
// last rendered and pass even when the item had moved.
//
// So the host reads the item's current state from `GET /api/items/{id}` at
// the moment the palette opens, and if that read fails the state verbs are
// not offered at all. Offering them with an unknown `from` would mean
// either omitting the precondition (last-writer-wins, the clobber) or
// inventing one.
import { uiApiPath } from "@/lib/ui-proxy/path";

/** The path segment items are served under, in both the app and the API. */
const ITEMS_PREFIX = "/items/";

/**
 * The item id a path is showing, or `null` for a path that is not an item
 * page.
 *
 * Matches only a bare `/items/{id}` and its sub-paths, and rejects an empty
 * id, so `/items` and `/items/` yield `null` rather than an empty string
 * that would later be requested as `/api/items/`.
 */
export function itemIdFromPath(pathname: string | undefined): string | null {
  if (pathname === undefined || !pathname.startsWith(ITEMS_PREFIX)) return null;
  const rest = pathname.slice(ITEMS_PREFIX.length);
  const id = rest.split("/")[0] ?? "";
  return id === "" ? null : id;
}

/** What the palette needs to know about the item in view. */
export interface PaletteItem {
  readonly id: string;
  readonly title: string;
  /** The server's value for the item's state — the only honest source of `expectedFrom`. */
  readonly state: string;
}

/**
 * Reads the item in view.
 *
 * Returns `null` on every failure rather than throwing, for the reason
 * `fetchNavCounts` folds its failures into zeroes: this runs to decorate an
 * overlay, and a palette that fails to open because a decoration could not
 * be loaded is worse than a palette that opens without the state verbs.
 * `null` is read downstream as "no item context", which suppresses exactly
 * those verbs and leaves navigation and create working.
 */
export async function fetchPaletteItem(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PaletteItem | null> {
  try {
    const response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(id)}`));
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      item?: { id?: unknown; title?: unknown; state?: unknown };
    };
    const item = payload.item;
    if (item === undefined) return null;
    const { id: itemId, title, state } = item;
    // All three are required. A row with no `state` cannot supply an
    // `expectedFrom`, which is the only reason this fetch exists — so a
    // partial row is no context at all rather than context with a hole.
    if (typeof itemId !== "string" || typeof state !== "string" || state === "") return null;
    return { id: itemId, title: typeof title === "string" ? title : itemId, state };
  } catch {
    return null;
  }
}
