// The interventions section's load and write lifecycle — the pure half of
// the client container, split out for the reason `src/lib/settings-page/
// state.ts` is: the harness runs `environment: "node"` with no DOM, so the
// fetch shaping and the loading/error/loaded branching are only directly
// testable as plain functions.
//
// Every call here goes to the HTTP adapter, which is itself a thin shell
// over one `service.call`. Nothing in this module imports the service layer
// or the database client.
import { writeForChoice, type LevelChoice } from "@/lib/interventions/configurable";
import type { InterventionSettingsResponse } from "./model";
import { uiApiPath } from "@/lib/ui-proxy/path";

export type InterventionsLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; response: InterventionSettingsResponse };

/**
 * The catalogue from `GET /api/interventions/settings`. Throws a message fit
 * to show directly — never a raw `Response` or a JSON-parse error, matching
 * `fetchSettings`.
 *
 * A missing collection is filled in rather than trusted, for the same reason
 * `fetchSettings` merges over its defaults: a component mapping over
 * `response.interventions` on an answer that omitted it would crash the
 * page, and an empty section is a far better failure than a blank screen.
 */
export async function fetchInterventionSettings(
  fetchImpl: typeof fetch = fetch,
): Promise<InterventionSettingsResponse> {
  const response = await fetchImpl(uiApiPath("/api/interventions/settings"));
  if (!response.ok) {
    throw new Error(
      `Could not load interventions (GET /api/interventions/settings returned ${response.status}).`,
    );
  }
  const body = (await response.json()) as Partial<InterventionSettingsResponse>;
  return { interventions: body.interventions ?? [] };
}

/** Turns a caught value into the message the error state shows. */
export function interventionsErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load interventions.";
}

export type WriteOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Reads the service's error envelope out of a failed response.
 *
 * The message the service wrote is far more useful than a status code — a
 * blocking level refused on a `post` entry names the phase and lists the
 * levels that are available — and that sentence is the one worth showing
 * beside the control. Falls back to the status only when the body is not the
 * envelope shape.
 */
async function messageFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Body was not JSON; fall through to the status-based message.
  }
  return `The change failed (${response.status}).`;
}

/**
 * Applies one entry's chosen level.
 *
 * **`inherit` sends DELETE, and that is the whole contract of this
 * function.** `src/lib/interventions/settings.ts`'s rule 1 is that an entry
 * which has never been overridden tracks the product, so returning one to
 * that state removes its row. The mapping is made by `writeForChoice` rather
 * than by an `if` here, so the one place that decides it is shared with
 * every other surface — a second spelling would be the drift that makes a
 * reset silently pin a value.
 */
export async function writeInterventionLevel(
  args: { readonly id: string; readonly choice: LevelChoice },
  fetchImpl: typeof fetch = fetch,
): Promise<WriteOutcome> {
  const write = writeForChoice(args.choice);
  const url = uiApiPath(`/api/interventions/${encodeURIComponent(args.id)}/level`);
  const response =
    write.action === "clear"
      ? await fetchImpl(url, { method: "DELETE" })
      : await fetchImpl(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level: write.level }),
        });

  if (!response.ok) return { ok: false, message: await messageFromResponse(response) };
  return { ok: true };
}
