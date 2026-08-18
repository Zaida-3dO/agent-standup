// Fetching and saving `budget.windows` — MILESTONES.md #87.
//
// Shaped like `settings-page/state.ts`, deliberately: same load-state
// union, same injected `fetchImpl` last parameter, same `WriteOutcome`, and
// the same decision to lift the service's own sentence out of the error
// envelope rather than inventing one. A reader who has met one of these
// pages has met both.
//
// The windows are a *setting*, so there is no bespoke endpoint here and
// none is wanted — this page writes through `PUT /api/settings/budget.windows`
// like any other typed setting, and the schema in `settings/budget-windows.ts`
// stays the single arbiter of what is legal.
import { budgetWindowsSchema, type BudgetWindows } from "../settings/budget-windows";

/** The key this page edits. Named once, so a typo is a compile error at every use. */
export const BUDGET_WINDOWS_KEY = "budget.windows";

export type BudgetLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; windows: BudgetWindows };

export type WriteOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Reads the service's error envelope out of a failed response.
 *
 * The sentence the service wrote is the useful one — `put_setting` refuses
 * an invalid window by naming what is wrong with it, and that is what
 * belongs beside the editor. The status is the fallback for a body that is
 * not the envelope shape.
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
 * Loads the windows.
 *
 * A stored value that does not parse is surfaced as an error rather than
 * dropped: the editor exists to fix a bad configuration, and a page that
 * silently showed an empty set would hide the thing the reader came to
 * repair.
 */
export async function fetchWindows(fetchImpl: typeof fetch = fetch): Promise<BudgetWindows> {
  const response = await fetchImpl(`/api/settings/${encodeURIComponent(BUDGET_WINDOWS_KEY)}`);
  if (!response.ok) throw new Error(await messageFromResponse(response));

  const body = (await response.json()) as { value?: unknown };
  // An unset setting resolves to its default, which is an empty map — a
  // fresh installation has no windows and that is a valid state, not a
  // failure to load.
  if (body.value === undefined || body.value === null) return {};

  const parsed = budgetWindowsSchema.safeParse(body.value);
  if (!parsed.success) {
    throw new Error(
      "The stored budget windows do not match the expected shape. Fix the value from the settings page.",
    );
  }
  return parsed.data;
}

/** Turns a thrown load failure into the sentence the page shows. */
export function budgetErrorMessageFrom(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "Could not load the budget windows.";
}

/**
 * Writes the whole map.
 *
 * Whole rather than per-window, because the setting *is* the map: a partial
 * write would need the server to merge, and a merge has no way to express
 * a deletion. Sending what the editor holds keeps "what you see is what is
 * stored" true, which is the property that makes the chart trustworthy.
 *
 * Validated here before the request goes out, so an incoherent set is
 * refused with the model's own message rather than after a round trip —
 * but the server validates it again, because a client-side check is a
 * convenience and never the gate.
 */
export async function writeWindows(
  windows: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteOutcome> {
  const parsed = budgetWindowsSchema.safeParse(windows);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") ?? "";
    const detail = first?.message ?? "The windows are not valid.";
    return { ok: false, message: where === "" ? detail : `${where}: ${detail}` };
  }

  const response = await fetchImpl(`/api/settings/${encodeURIComponent(BUDGET_WINDOWS_KEY)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: parsed.data }),
  });
  if (!response.ok) return { ok: false, message: await messageFromResponse(response) };
  return { ok: true };
}
