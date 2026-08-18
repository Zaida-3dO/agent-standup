// The administration surface's load and write lifecycle — MILESTONES.md
// #93, over the API from #92.
//
// The pure half of the client container, split out for the reason
// `src/lib/board/state.ts` is: this repo's harness runs `environment: "node"`
// with no DOM, so the fetch shaping and the branching are only directly
// testable as plain functions.
//
// Every call goes to the HTTP adapter, which is itself a thin shell over one
// `service.call` (CLAUDE.md: "Every adapter is a thin shell over a service
// call"). Nothing here imports the service layer or the database client.
import type { AdminField, AdminKind } from "./kinds";
import { uiApiPath } from "@/lib/ui-proxy/path";

/** One row, as the API returns it: a bag of named values whose shape the kind describes. */
export type AdminRow = Readonly<Record<string, unknown>>;

export type AdminLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; rows: readonly AdminRow[] };

/**
 * Reads a kind's collection. Throws a message fit to show directly — never a
 * raw `Response` or a JSON-parse error, matching `fetchBoard` and
 * `fetchPeople`.
 *
 * **A response missing the collection yields an empty list, not a crash.**
 * The array is read by name from the body (`{ repos: [...] }`), and a body
 * that does not carry it renders as "nothing here yet" rather than as a
 * component mapping over `undefined`.
 */
export async function fetchRows(
  kind: AdminKind,
  options: { readonly includeArchived?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<readonly AdminRow[]> {
  const query = options.includeArchived ? "?includeArchived=true" : "";
  const response = await fetchImpl(uiApiPath(`${kind.listPath}${query}`));
  if (!response.ok) {
    throw new Error(`Could not load ${kind.title.toLowerCase()} (${response.status}).`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const rows = body[kind.collection];
  return Array.isArray(rows) ? (rows as AdminRow[]) : [];
}

/** Turns a caught value into the message the error state shows. */
export function adminErrorMessageFrom(err: unknown, kind: AdminKind): string {
  return err instanceof Error ? err.message : `Could not load ${kind.title.toLowerCase()}.`;
}

export type WriteOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Reads the service's error envelope out of a failed response.
 *
 * The service's own sentence is the useful one — `update_account` refuses an
 * unregistered vendor by naming it, and `update_machine` refuses a bad
 * override with the registry validator's message — and that is what belongs
 * beside the field. The status is the fallback, not the first choice.
 */
async function messageFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Body was not JSON; fall through to the status-based message.
  }
  return `The write failed (${response.status}).`;
}

/** The path of one row. */
export function rowPath(kind: AdminKind, id: string): string {
  return uiApiPath(`${kind.listPath}/${encodeURIComponent(id)}`);
}

/** Creates a row — `POST` to the collection. */
export async function createRow(
  kind: AdminKind,
  body: Readonly<Record<string, unknown>>,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteOutcome> {
  if (!kind.canCreate) {
    // Refused here rather than sent: the API has no create for this kind, so
    // the request would 404 or 405 with a message about HTTP rather than
    // about why this kind has no create.
    return { ok: false, message: `A ${kind.singular} cannot be created here.` };
  }
  const response = await fetchImpl(uiApiPath(kind.listPath), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, message: await messageFromResponse(response) };
  return { ok: true };
}

/** Edits a row — `PATCH` to its own path. */
export async function updateRow(
  kind: AdminKind,
  id: string,
  body: Readonly<Record<string, unknown>>,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteOutcome> {
  const response = await fetchImpl(rowPath(kind, id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, message: await messageFromResponse(response) };
  return { ok: true };
}

/**
 * Archives or un-archives a row — SCHEMA.md §23.1: "Archive, never delete —
 * attribution and history point at these rows."
 *
 * There is no delete here and there should not be: the API #92 delivers has
 * no hard-delete, and the schema's reasoning is that the rows are pointed at
 * by history. A button that could remove one would be a button that breaks
 * attribution.
 */
export async function setArchived(
  kind: AdminKind,
  id: string,
  archived: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteOutcome> {
  if (!kind.canArchive) {
    return { ok: false, message: `A ${kind.singular} cannot be archived.` };
  }
  return updateRow(kind, id, { archived }, fetchImpl);
}

/**
 * Whether a row carries its own value for an override field, or inherits the
 * setting — SCHEMA.md §23.2: "Each row shows whether it carries an override
 * or is inheriting the setting."
 *
 * `null` and `undefined` both read as inheriting, and everything else —
 * **including `[]` and `{}`** — reads as an override. That distinction is
 * the whole point of the column being nullable: an empty override says
 * "look nowhere", and inheriting says "use the global value", and they are
 * different instructions. Treating empty as absent would silently turn the
 * first into the second at the surface where somebody is looking straight at
 * it.
 */
export function isOverridden(row: AdminRow, field: AdminField): boolean {
  if (!field.overridesSetting) return false;
  const value = row[field.name];
  return value !== null && value !== undefined;
}

/** The word shown in the override column. */
export function overrideLabel(row: AdminRow, field: AdminField): "Override" | "Inheriting" {
  return isOverridden(row, field) ? "Override" : "Inheriting";
}

/** Whether a row is archived. */
export function isArchived(row: AdminRow): boolean {
  const value = row.archivedAt;
  return value !== null && value !== undefined;
}

/**
 * Builds the `PATCH` body from a form's drafts.
 *
 * **Only fields the person actually touched are sent.** Every #92 edit
 * schema makes each field optional and treats an omitted one as "no change",
 * so sending the whole row back would re-write untouched values — and for
 * an override field, sending an untouched `null` back would read as an
 * explicit "clear the override", which is a change nobody asked for.
 *
 * A field explicitly set to inherit is sent as `null`, which is exactly how
 * §17.7's columns spell that.
 */
export function buildPatchBody(
  kind: AdminKind,
  drafts: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const writable = new Set(kind.fields.filter((field) => !field.readOnly).map((f) => f.name));
  for (const [name, value] of Object.entries(drafts)) {
    // A read-only field is never sent, whatever a caller put in the drafts:
    // the #92 schemas are `.strict()`, so an unexpected property is refused
    // outright and the whole edit fails for a field nobody meant to change.
    if (!writable.has(name)) continue;
    body[name] = value;
  }
  return body;
}
