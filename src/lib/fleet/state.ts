// The fleet page's network calls — `GET /api/fleet`, `POST /api/sweep` and
// `POST /api/claims/takeover`, split from the view/component for the same
// reason `board/move.ts` is: this repo's harness runs `environment: "node"`
// with no DOM, so the fetch shaping and error handling are only directly
// testable as plain functions taking a `fetch` stub.
import type { FleetAssignment, FleetResponse } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";

/** The error envelope every API route answers with (`src/app/api/_shared/respond.ts`). */
interface ErrorBody {
  readonly error?: { readonly message?: unknown };
}

function serverMessageFrom(body: unknown): string | null {
  const message = (body as ErrorBody | null)?.error?.message;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}

/**
 * Loads every live assignment. Throws a message fit to show directly —
 * never a raw `Response` or a JSON-parse error — matching `fetchBoard` and
 * `fetchFeed`.
 */
export async function fetchFleet(fetchImpl: typeof fetch = fetch): Promise<FleetAssignment[]> {
  const response = await fetchImpl(uiApiPath("/api/fleet"));
  if (!response.ok) {
    throw new Error(`Could not load the fleet (GET /api/fleet returned ${response.status}).`);
  }
  const body = (await response.json()) as Partial<FleetResponse> | null;
  return [...(body?.assignments ?? [])];
}

export function fleetErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the fleet.";
}

/**
 * The `liveness.dead_after_seconds` setting — what "overdue for sweep"
 * (`isOverdueForSweep`) is measured against, so the fleet page's own flag
 * agrees with the threshold the real sweep will use rather than a
 * hardcoded guess that can drift from an operator's override.
 *
 * Falls back to the registry's own default (1800s — `settings/registry.ts`)
 * on any failure. A page that cannot learn the real threshold should still
 * render with a reasonable one rather than not render the flag at all —
 * this is a display refinement, not a correctness-critical value (nothing
 * here writes based on it).
 */
export async function fetchDeadAfterSeconds(fetchImpl: typeof fetch = fetch): Promise<number> {
  const FALLBACK = 1800;
  try {
    const response = await fetchImpl(uiApiPath("/api/settings"));
    if (!response.ok) return FALLBACK;
    const body = (await response.json()) as {
      settings?: readonly { key: string; value: unknown }[];
    };
    const setting = body.settings?.find((s) => s.key === "liveness.dead_after_seconds");
    return typeof setting?.value === "number" ? setting.value : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// ── Sweep ────────────────────────────────────────────────────────────────

export interface SweepMove {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly from: "running" | "stalled";
  readonly to: "running" | "stalled" | "dead";
}

export interface SweepEscalated {
  readonly itemId: string;
  readonly resumeAttempts: number;
}

/** What `POST /api/sweep` reports it did — the after-the-click summary the confirm dialog promised. */
export interface SweepResult {
  readonly checkedAt: string;
  readonly moves: readonly SweepMove[];
  /** Assignment ids released. **This is the number that matters** — see the confirm copy in `FleetView`. */
  readonly released: readonly string[];
}

export type SweepOutcome =
  | { readonly ok: true; readonly result: SweepResult }
  | { readonly ok: false; readonly message: string };

/**
 * Runs the global liveness sweep. **There is no scope parameter, on
 * purpose** — the operation this calls (`sweep`, SCHEMA.md §17.5) takes no
 * input at all and acts on every live assignment in the installation. The
 * confirmation this is unmistakable BEFORE the click is a UI-layer
 * responsibility (`FleetView`'s confirm dialog); this function only makes
 * the one call and reports what came back.
 */
export async function runSweep(fetchImpl: typeof fetch = fetch): Promise<SweepOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(uiApiPath("/api/sweep"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    return { ok: false, message: "The sweep could not run — the server could not be reached." };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      message: serverMessageFrom(body) ?? `The sweep could not run (returned ${response.status}).`,
    };
  }

  const parsed = body as Partial<SweepResult> | null;
  return {
    ok: true,
    result: {
      checkedAt: parsed?.checkedAt ?? new Date().toISOString(),
      moves: parsed?.moves ?? [],
      released: parsed?.released ?? [],
    },
  };
}

// ── Takeover ─────────────────────────────────────────────────────────────

export interface TakeoverRequest {
  readonly itemId: string;
  readonly fromSessionId: string;
  readonly bySessionId: string;
  readonly holderType: "person" | "agent";
  readonly holderId: string;
  readonly reason: string | null;
  readonly force: boolean;
}

export type TakeoverOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Forces a takeover of one row — the targeted alternative to sweep, for
 * when a reader means one item rather than the whole board.
 *
 * **The reason is sent whether or not the holder turns out to be dead.**
 * `takeoverAssignment` only requires it when the holder may still be
 * alive, but this function does not know that in advance — deciding it
 * client-side would duplicate a rule the server already owns and could
 * drift from it. Sending whatever the caller typed and letting the server
 * decide whether it was required is the same shape `requestMove` already
 * follows for guard refusals.
 */
export async function requestTakeover(
  request: TakeoverRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TakeoverOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(uiApiPath("/api/claims/takeover"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return {
      ok: false,
      message: "That takeover could not be sent — the server could not be reached.",
    };
  }

  if (response.ok) return { ok: true };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {
    ok: false,
    message: serverMessageFrom(body) ?? `That takeover was refused (returned ${response.status}).`,
  };
}
