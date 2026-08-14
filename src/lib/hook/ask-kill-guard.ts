// Asking the ownership check — `POST /api/kill-guard` (MILESTONES.md #45).
//
// A sibling of `./ask-http.ts` and the same kind of thing: an adapter that
// resolves input, makes one call, and shapes the result. It holds no
// judgement, reaches no database, and knows nothing about registries — the
// whole of the decision is `kill_guard` in the service layer.
//
// ── Why this is a second endpoint rather than a field on `/hook` ────────
//
// The two calls need different inputs. `POST /hook` sends the event; the
// ownership check additionally needs the **machine** (a process id means
// nothing without one) and the asking session's **crew root**. Neither is
// in the hook payload, because neither is a property of the event — they
// are properties of the installation and of the session, resolved once at
// the entry point. Widening `/hook`'s schema to carry them would make two
// fields required of every caller of the highest-volume endpoint in the
// system for the benefit of the small minority of calls that are kills.
//
// ── Every failure is the same value ────────────────────────────────────
//
// `undefined`, on `./ask-http.ts`'s reasoning. What the caller does with it
// is narrower here and stated in `./decide.ts`: it denies the *kill*, not
// every command.

import type { HookEvent } from "./payload";
import type { KillGuardVerdict } from "./decide";

/** The subset of `fetch` this adapter uses. Injected so tests need no network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const DEFAULT_TIMEOUT_MS = 5000;

const BASES = ["not-a-kill", "owned", "unowned", "unparseable"] as const;

export interface AskKillGuardOptions {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /** Which machine the command would run on. A process id is meaningless without it. */
  readonly machine: string;
  /** The asking session's crew root, when it is known to differ from the session. */
  readonly rootSessionId?: string;
  readonly timeoutMs?: number;
  readonly timeoutSignal?: (ms: number) => AbortSignal | undefined;
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function isBasis(value: unknown): value is KillGuardVerdict["basis"] {
  return typeof value === "string" && (BASES as readonly string[]).includes(value);
}

/**
 * Builds the `askKillGuard` function `decide` takes.
 *
 * **A response missing or mis-typing `basis` is `undefined`, not a
 * defaulted basis.** `basis` is the field that decides whether the hook
 * treats the answer as "nothing was guarded" or as a verdict, so guessing
 * it is guessing the one thing the response exists to tell us — and the
 * cheap guess (`not-a-kill`) is precisely the one that would let a build
 * talking to an incompatible server allow every kill silently.
 */
export function createKillGuardAsk({
  baseUrl,
  fetch,
  machine,
  rootSessionId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutSignal = defaultTimeoutSignal,
}: AskKillGuardOptions) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/kill-guard`;

  return async function askKillGuard(event: HookEvent): Promise<KillGuardVerdict | undefined> {
    if (event.command === undefined || event.command.length === 0) return undefined;

    const signal = timeoutSignal(timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: event.command,
          machine,
          sessionId: event.sessionId,
          ...(rootSessionId === undefined || rootSessionId === "" ? {} : { rootSessionId }),
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      return undefined;
    }

    if (!response.ok) return undefined;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }

    const decision = property(body, "decision");
    if (decision !== "allow" && decision !== "deny") return undefined;

    const basis = property(body, "basis");
    if (!isBasis(basis)) return undefined;

    const reason = property(body, "reason");
    return {
      decision,
      basis,
      ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
    };
  };
}

function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}
