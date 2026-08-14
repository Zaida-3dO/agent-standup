// The `/settings` load and write lifecycle — the pure half of the client
// container, split out for the reason `src/lib/board/state.ts` is: this
// repo's harness runs `environment: "node"` with no DOM, so the fetch
// shaping and the loading/error/loaded branching are only directly testable
// as plain functions.
//
// Every call here goes to the HTTP adapter, which is itself a thin shell
// over one `service.call` (CLAUDE.md: "Every adapter is a thin shell over a
// service call"). Nothing in this module imports the service layer or the
// database client.
import type { SettingsResponse } from "./model";
import { confirmWrite, type WriteVerb } from "./confirmation";

export type SettingsLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; response: SettingsResponse };

/**
 * The settings answer from `GET /api/settings`. Throws a message fit to show
 * directly — never a raw `Response` or a JSON-parse error, matching
 * `fetchBoard` and `fetchPeople`.
 *
 * **Missing collections are filled in, not trusted**, for the same reason
 * `fetchBoard` merges over `emptyBoard()`: a component mapping over
 * `response.constants` on an answer that omitted it would crash the page,
 * and an empty panel is a far better failure than a blank screen.
 */
export async function fetchSettings(fetchImpl: typeof fetch = fetch): Promise<SettingsResponse> {
  const response = await fetchImpl("/api/settings");
  if (!response.ok) {
    throw new Error(`Could not load settings (GET /api/settings returned ${response.status}).`);
  }
  const body = (await response.json()) as Partial<SettingsResponse>;
  return {
    settings: body.settings ?? [],
    unrecognised: body.unrecognised ?? [],
    constants: body.constants ?? [],
    bootstrap: body.bootstrap ?? [],
    revision: body.revision ?? "0",
  };
}

/** Turns a caught value into the message the error state shows. */
export function settingsErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load settings.";
}

export type WriteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Reads the service's error envelope out of a failed response.
 *
 * The message the service wrote is far more useful than a status code —
 * `put_setting` refuses an out-of-range value by naming the bound
 * (`InvalidInputError`, "Invalid value for …"), and that sentence is the one
 * worth showing beside the field. Falls back to the status only when the
 * body is not the envelope shape.
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

/**
 * Writes one setting — `PUT /api/settings/{key}`, or `DELETE` to reset it.
 *
 * **The confirmation gate runs here, before the request is built**, and a
 * refusal returns without calling `fetch` at all. That ordering is the point:
 * a gate evaluated after the request has gone out is not a gate. It is also
 * why the gate is in this module rather than in the component — a component
 * check can be bypassed by anything that calls the write function directly,
 * and this *is* the write function.
 *
 * The client-side gate does not replace anything server-side; it is the
 * surface's own habit, the same way `--confirm` is the command line's
 * (SCHEMA.md §17.8's "typing the setting's key to confirm" is written about
 * this surface specifically).
 */
export async function writeSetting(
  args: {
    readonly key: string;
    readonly verb: WriteVerb;
    /** The value to store. Ignored when the verb is `reset`. */
    readonly value?: unknown;
    /** Exactly what was typed into the confirmation box, or `null`. */
    readonly typed: string | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<WriteOutcome> {
  const decision = confirmWrite({ key: args.key, verb: args.verb, typed: args.typed });
  if (!decision.allowed) return { ok: false, message: decision.reason };

  const url = `/api/settings/${encodeURIComponent(args.key)}`;
  const response =
    args.verb === "reset"
      ? await fetchImpl(url, { method: "DELETE" })
      : await fetchImpl(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // `value` is sent explicitly even when it is `null`, because
          // `put_setting` distinguishes a present `null` from an absent key
          // and refuses the latter (its `.refine` on `"value" in candidate`).
          body: JSON.stringify({ value: args.value ?? null }),
        });

  if (!response.ok) return { ok: false, message: await messageFromResponse(response) };
  return { ok: true };
}

/**
 * Removes an unrecognised override row — SCHEMA.md §17.3's "listed under
 * 'Unrecognised' on `/settings` with a remove action".
 *
 * Deliberately **not** gated by typed confirmation: an unrecognised key is
 * inert by construction (resolution starts from the registry, so the row
 * cannot affect behaviour), and no registry flag exists to read for it. A
 * confirmation invented for it would be theatre.
 *
 * Its own endpoint, not `DELETE /api/settings/{key}` — that one clears a
 * *declared* key's override and refuses an undeclared one, which is the
 * whole population of this section.
 */
export async function removeUnrecognised(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteOutcome> {
  const response = await fetchImpl(`/api/settings/unrecognised/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  if (!response.ok) return { ok: false, message: await messageFromResponse(response) };
  return { ok: true };
}
