// Asking the server to move an item — MILESTONES.md #73.
//
// Driven with a stub `fetch`, so every refusal the real state machine can
// produce is exercised without a server: a project (403), a guard rejection
// (422), a vanished item (404), and the request never arriving at all.
import { describe, expect, it } from "vitest";
import { requestMove } from "@/lib/board/move";
import { TARGET_STATE } from "@/lib/board/drag";

interface StubCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

/** A `fetch` that answers with the given status and body, recording what it was called with. */
function stubFetch(status: number, body: unknown): typeof fetch & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch & { calls: StubCall[] };
  impl.calls = calls;
  return impl;
}

/** A `fetch` that never reaches the server. */
const failingFetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

const anItem = {
  id: "a",
  title: "An item",
  kind: "task" as const,
  state: "executing",
  priority: "P2" as const,
  area: "web",
  repo: null,
  blockedOnPersonId: null,
  blockedOnType: null,
  blockedReason: null,
  pauseReason: null,
};

describe("requestMove", () => {
  it("POSTs the target state for the column to the transition endpoint", () => {
    const impl = stubFetch(200, { item: anItem });
    return requestMove("a", "in_progress", undefined, impl).then(() => {
      expect(impl.calls).toHaveLength(1);
      expect(impl.calls[0]!.url).toBe("/api/ui/items/a/transition");
      expect(impl.calls[0]!.method).toBe("POST");
      // `full: true` is part of the contract, not incidental: the card this
      // settles on is a `BoardItem`, which draws `kind`, `priority`, `area`,
      // `repo` and the blocked/paused fields — none of which are in the
      // slim write response the writes now default to (#107). Dropping the
      // flag would blank all of them until the next board read.
      // No `expectedFrom` when the caller named none — and `undefined` is
      // *omitted* by `JSON.stringify` rather than sent as `null`, which is
      // the behaviour the server's "no precondition" path expects.
      expect(impl.calls[0]!.body).toEqual({ to: TARGET_STATE.in_progress, full: true });
    });
  });

  it("sends expectedFrom when given one, so the server can refuse a lost race", async () => {
    // `applyTransition` raises `StaleTransitionError` only when the caller
    // supplied an `expectedFrom` — without it a stale move is applied and
    // answered 200, silently overwriting whoever moved the item first.
    const impl = stubFetch(200, { item: anItem });
    await requestMove("a", "in_progress", "on_deck", impl);
    expect(impl.calls[0]!.body).toEqual({
      to: TARGET_STATE.in_progress,
      full: true,
      expectedFrom: "on_deck",
    });
  });

  it("omits expectedFrom entirely rather than sending null when there is none", async () => {
    // The distinction is not cosmetic: an absent key is the "no precondition"
    // the validator already understands, while an explicit `null` is a value
    // it would have to reject — so serialising the missing case as `null`
    // would turn a legitimate move into a 400.
    const impl = stubFetch(200, { item: anItem });
    await requestMove("a", "in_progress", undefined, impl);
    expect(Object.keys(impl.calls[0]!.body as Record<string, unknown>)).not.toContain(
      "expectedFrom",
    );
  });

  it("returns the 409's conflict details, which only an expectedFrom can provoke", async () => {
    // The 409 arm was unreachable in production for as long as the board sent
    // no precondition. This proves the parsing half; the wiring files prove a
    // real drag actually asks for it.
    const impl = stubFetch(409, {
      error: {
        message: "a is in in_review, not on_deck.",
        code: "conflict",
        fields: ["expectedFrom"],
        details: { itemId: "a", expectedFrom: "on_deck", currentState: "in_review" },
      },
    });
    const result = await requestMove("a", "in_progress", "on_deck", impl);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.conflict).toEqual({ currentState: "in_review", expectedFrom: "on_deck" });
  });

  it("refuses a column with no reachable state WITHOUT calling the server", async () => {
    // Waiting needs fields a drag has not got. A drop should never get this
    // far, so refusing here keeps a wiring mistake from reaching the server
    // as a malformed request.
    const impl = stubFetch(200, { item: anItem });
    const result = await requestMove("a", "waiting", undefined, impl);
    expect(result.ok).toBe(false);
    expect(impl.calls).toHaveLength(0);
  });

  it("percent-encodes the id so a slash cannot address a different route", async () => {
    const impl = stubFetch(200, { item: anItem });
    await requestMove("a/b", "backlog", undefined, impl);
    expect(impl.calls[0]!.url).toBe("/api/ui/items/a%2Fb/transition");
  });

  it("returns the SERVER's item on success, not the one that was asked for", async () => {
    const result = await requestMove(
      "a",
      "in_progress",
      undefined,
      stubFetch(200, { item: { ...anItem, state: "blocked" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entry.item.state).toBe("blocked");
    expect(result.entry.column).toBe("in_progress");
  });

  it("reports a guard rejection using the guard's OWN message", async () => {
    // A guard's rejection names the field it wants, which is worth far more
    // than anything this module could invent.
    const result = await requestMove(
      "a",
      "completed",
      undefined,
      stubFetch(422, { error: { message: "A summary is required." } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("A summary is required.");
  });

  it("reports a project refusal (403) in terms of what to do instead", async () => {
    const result = await requestMove("p", "in_progress", undefined, stubFetch(403, {}));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("children");
  });

  it("reports a vanished item (404)", async () => {
    const result = await requestMove("gone", "completed", undefined, stubFetch(404, {}));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("could not be found");
  });

  it("reports a failure that never reached the server, rather than throwing", async () => {
    // Modelled as an ordinary refusal so the caller handles it on the same
    // path — a thrown error here would leave the card showing a move that
    // was never saved.
    const result = await requestMove("a", "completed", undefined, failingFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("could not be reached");
  });

  it("treats a 200 carrying no item as a refusal rather than a success", async () => {
    // There is nothing truthful to settle the board on, so the card has to
    // go back rather than keep the optimistic guess.
    const result = await requestMove("a", "completed", undefined, stubFetch(200, {}));
    expect(result.ok).toBe(false);
  });

  it("still refuses cleanly when the error body cannot be parsed", async () => {
    const impl = (() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response)) as unknown as typeof fetch;
    const result = await requestMove("a", "completed", undefined, impl);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("500");
  });
});
