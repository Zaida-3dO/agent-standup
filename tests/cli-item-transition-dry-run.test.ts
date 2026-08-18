// MILESTONES.md #81 — `standup item transition --dry-run` genuinely does not
// mutate state, on both bindings, and both bindings report the same thing.
//
// Row #27's service layer already proves `rehearseTransition` itself never
// writes (`tests/state-machine-transition.test.ts`) and that a guard's own
// write during rehearsal rolls back (`tests/transition-complete-operations.
// test.ts`, `RehearsalRollback`). This row does not re-prove that mechanism
// — it proves the CLI **reaches** it: that `--dry-run` on the command line
// actually becomes `dryRun: true` on the operation input, that the `direct`
// binding's own `RehearsalRollback` handling (`bindings/direct.ts`) neither
// swallows the outcome as an `internal` failure nor lets anything commit,
// and that the `http` binding's `?dry_run=` query wiring (`bindings/http.
// ts`) does the same over a real route call.
//
// **What would make this hollow, stated first.** A test that only asserts
// "the call succeeded" would pass even if `--dry-run` silently mutated state
// — the fake service below tracks a real, observable state map, and every
// dry-run assertion re-reads that map in a *separate* step after the call
// returned, the same posture `transition-complete-operations.test.ts` takes
// against a real database. A mutant that inverted the `dryRun` check, or
// dropped the `isRehearsalRollback` branch in `bindings/direct.ts`, or built
// `dryRun: false` regardless of the flag, changes what lands in that map or
// what exit code comes back — this file is built to feel every one of those.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuardRejectedError, NotFoundError, RehearsalRollback } from "@/lib/service";
import type { TransitionOutcome } from "@/lib/service";
import { createDirectBinding, createHttpBinding, runCommand, EXIT } from "@/lib/cli";
import type { Binding, RunOutcome } from "@/lib/cli";

interface FakeItem {
  readonly id: string;
  state: string;
}

/** The items both bindings read and write. Reset per test. */
const items = new Map<string, FakeItem>();

/**
 * A `transition_item` stand-in that is faithful to the one property this
 * file is about: a real move mutates `items`, a dry run never does, and both
 * report the same outcome shape row #27's real operation does
 * (`state-machine/transition.ts`'s `TransitionOutcome`). `to: "blocked"`
 * with no `blocked_reason` field is the one rejecting case — chosen because
 * it is exactly SCHEMA.md §16's own worked example, not because this stands
 * in for the real guard registry.
 */
const fakeService = {
  async call(name: string, input: unknown): Promise<unknown> {
    if (name !== "transition_item") {
      throw new NotFoundError(`No such operation: ${name}.`, { fields: ["operation"] });
    }
    const { id, to, dryRun, fields } = input as {
      id: string;
      to: string;
      dryRun?: boolean;
      fields?: Record<string, unknown>;
    };
    const item = items.get(id);
    if (!item) throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });

    const from = item.state;
    const rejected = to === "blocked" && !fields?.blocked_reason;
    const outcome = rejected
      ? {
          itemId: id,
          from,
          to,
          allowed: false as const,
          rehearsed: true as const,
          rejection: {
            code: "guard_rejected" as const,
            guard: "state-machine.blocked_required_fields",
            message: "blocked needs a reason.",
            fields: ["blocked_reason"],
          },
        }
      : { itemId: id, from, to, allowed: true as const, rehearsed: true as const };

    if (dryRun) {
      // The real operation always throws here, allowed or not — see
      // `rehearsal-rollback.ts`. Reproduced exactly, because the CLI's own
      // handling of this throw (not the throw itself) is what this file
      // tests. Cast rather than typing `from`/`to` as the real
      // `ItemStateValue` union above: this fixture only ever needs two
      // states, and widening the whole fake to the real vocabulary would
      // buy nothing this file checks.
      throw new RehearsalRollback(outcome as TransitionOutcome);
    }

    if (rejected) {
      throw new GuardRejectedError(
        "state-machine.blocked_required_fields",
        "blocked needs a reason.",
        { fields: ["blocked_reason"] },
      );
    }

    item.state = to;
    return {
      item: { ...item },
      outcome: { itemId: id, from, to, allowed: true, rehearsed: false },
    };
  },
};

vi.mock("@/lib/service/live", () => ({ service: fakeService }));

const { POST: transitionPost } = await import("@/app/api/items/[id]/transition/route");

/** A `fetch` that dispatches straight to the real transition route handler. */
async function routeFetch(url: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const match = /^\/api\/items\/([^/]+)\/transition$/.exec(parsed.pathname);
  if (!match) return new Response("not found", { status: 404 });
  const request = new Request(url, init);
  return transitionPost(request, {
    params: Promise.resolve({ id: decodeURIComponent(match[1]!) }),
  });
}

function directBinding(): Binding {
  return createDirectBinding({ service: fakeService });
}

/** The token these routes are configured to accept. */
const TEST_TOKEN = "both-bindings-token";

function httpBinding(): Binding {
  // The routes below authenticate, so the binding presents the token the
  // environment is stubbed with — otherwise this compares `direct` against a
  // uniform 401 instead of against the HTTP adapter.
  return createHttpBinding({
    baseUrl: "http://server.invalid",
    fetch: routeFetch,
    token: TEST_TOKEN,
  });
}

function comparable(outcome: RunOutcome) {
  return { envelope: outcome.envelope, exitCode: outcome.exitCode };
}

beforeEach(() => {
  // These routes authenticate every call.
  vi.stubEnv("STANDUP_TOKENS", `test-machine:${TEST_TOKEN}`);
  items.clear();
  items.set("item-1", { id: "item-1", state: "on_deck" });
});

describe("--dry-run genuinely does not mutate state (direct binding)", () => {
  it("an ALLOWED dry run reports the outcome and leaves the item exactly as it was", async () => {
    const outcome = await runCommand(
      ["item", "transition", "item-1", "--to", "someday", "--dry-run"],
      directBinding(),
    );

    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(outcome.envelope).toEqual({
      ok: true,
      data: {
        outcome: {
          itemId: "item-1",
          from: "on_deck",
          to: "someday",
          allowed: true,
          rehearsed: true,
        },
      },
    });
    // The load-bearing read: a fresh look at the store, not the envelope.
    expect(items.get("item-1")?.state).toBe("on_deck");
  });

  it("the same call WITHOUT --dry-run actually moves the item", async () => {
    const outcome = await runCommand(
      ["item", "transition", "item-1", "--to", "someday"],
      directBinding(),
    );

    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(items.get("item-1")?.state).toBe("someday");
  });

  it("a REJECTED dry run still reports 200/ok — a preview, not an internal failure — and does not mutate", async () => {
    const outcome = await runCommand(
      ["item", "transition", "item-1", "--to", "blocked", "--dry-run"],
      directBinding(),
    );

    // The one assertion a missing `isRehearsalRollback` branch in
    // `bindings/direct.ts` would break: falling through to the generic
    // handler reports this as `internal` (exit 1), not the accepted preview
    // it actually is.
    expect(outcome.exitCode).toBe(EXIT.OK);
    if (!outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.data).toMatchObject({
      outcome: { allowed: false, rejection: { guard: "state-machine.blocked_required_fields" } },
    });
    expect(items.get("item-1")?.state).toBe("on_deck");
  });

  it("the same call WITHOUT --dry-run is a real rejection (exit 3), and still never mutates", async () => {
    const outcome = await runCommand(
      ["item", "transition", "item-1", "--to", "blocked"],
      directBinding(),
    );

    expect(outcome.exitCode).toBe(EXIT.REJECTED);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.code).toBe("guard_rejected");
    expect(outcome.envelope.error.guard).toBe("state-machine.blocked_required_fields");
    expect(items.get("item-1")?.state).toBe("on_deck");
  });

  it("--fields threads through to the guard the same way on a dry run", async () => {
    // Proves `fields` reaches the operation from `--fields`, not just `to`
    // and `dryRun` — with a real reason supplied, "blocked" is allowed.
    const outcome = await runCommand(
      [
        "item",
        "transition",
        "item-1",
        "--to",
        "blocked",
        "--dry-run",
        "--fields",
        '{"blocked_reason":"waiting on design"}',
      ],
      directBinding(),
    );

    expect(outcome.exitCode).toBe(EXIT.OK);
    if (!outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.data).toMatchObject({ outcome: { allowed: true } });
    expect(items.get("item-1")?.state).toBe("on_deck");
  });
});

describe("--dry-run genuinely does not mutate state (http binding, a real route call)", () => {
  it("an ALLOWED dry run over HTTP reports the outcome and leaves the item exactly as it was", async () => {
    const outcome = await runCommand(
      ["item", "transition", "item-1", "--to", "someday", "--dry-run"],
      httpBinding(),
    );

    expect(outcome.exitCode).toBe(EXIT.OK);
    if (!outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.data).toEqual({
      outcome: { itemId: "item-1", from: "on_deck", to: "someday", allowed: true, rehearsed: true },
    });
    expect(items.get("item-1")?.state).toBe("on_deck");
  });

  it("the same call WITHOUT --dry-run over HTTP actually moves the item", async () => {
    const outcome = await runCommand(
      ["item", "transition", "item-1", "--to", "someday"],
      httpBinding(),
    );
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(items.get("item-1")?.state).toBe("someday");
  });
});

describe("both bindings agree on a dry run — the property row #94 will pin across every adapter", () => {
  it("an ALLOWED dry run", async () => {
    const argv = ["item", "transition", "item-1", "--to", "someday", "--dry-run"];
    const direct = await runCommand(argv, directBinding());
    items.set("item-1", { id: "item-1", state: "on_deck" }); // http gets its own untouched item
    const http = await runCommand(argv, httpBinding());

    expect(comparable(http)).toEqual(comparable(direct));
  });

  it("a REJECTED dry run", async () => {
    const argv = ["item", "transition", "item-1", "--to", "blocked", "--dry-run"];
    const direct = await runCommand(argv, directBinding());
    items.set("item-1", { id: "item-1", state: "on_deck" });
    const http = await runCommand(argv, httpBinding());

    expect(comparable(http)).toEqual(comparable(direct));
    // A rejected dry run is still an *accepted call* reporting a preview —
    // SCHEMA.md §16 "evaluates and reports rather than raising" — never an
    // error envelope. Asserted here, not just left to `comparable`'s
    // equality check, so a mutant that made both bindings agreeably wrong
    // (e.g. both reporting it as an error envelope) would still be caught.
    if (!direct.envelope.ok) throw new Error("expected an accepted preview of a rejection");
    expect(direct.envelope.data).toMatchObject({ outcome: { allowed: false } });
  });
});
