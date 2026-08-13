// AC5 for row #82's own commands — the two bindings are genuinely behind
// ONE interface, same shape as tests/cli-one-interface.test.ts (row #79),
// applied to `session claim/release/heartbeat/checkpoint/my-work`,
// `item note/orientation` and `crew name`.
//
// **What would make this hollow, stated first.** Exercising `direct` and
// `http` separately and asserting each looks reasonable proves nothing about
// them being the same interface — two independently-plausible
// implementations would both pass. Every case below drives *one command*
// through `runCommand` twice, once per binding, and asserts the outcomes are
// equal to EACH OTHER — never to a literal on one side only — so it cannot
// pass while the two differ. The `http` side is a real round trip through
// this row's own route handlers (`src/app/api/claims/**`,
// `src/app/api/checkpoints`, `src/app/api/items/[id]/notes`,
// `src/app/api/items/[id]/orientation`, `src/app/api/my-work`,
// `src/app/api/crew/name`) — not a stub — with `@/lib/service/live` mocked
// to an in-memory fake so no database is needed to prove the ROUTING is
// correct (the operations' own real behaviour against Postgres is proven
// separately by the DB-backed operation tests #29/#28 already added, plus
// this row's own tests/get-crew-name-operation.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@/lib/service";
import { createDirectBinding, createHttpBinding, runCommand } from "@/lib/cli";
import type { Binding, RunOutcome } from "@/lib/cli";

interface Assignment {
  id: string;
  itemId: string;
  sessionId: string;
  role: string;
  releasedAt: string | null;
  lastActive: string;
}

const items = new Set<string>();
/** Keyed by `${itemId}:${sessionId}`. */
const liveAssignments = new Map<string, Assignment>();
const agentNames = new Map<string, { name: string; held: string | null }>();
let assignmentCounter = 0;
let eventCounter = 0;

function seedItem(id: string): void {
  items.add(id);
}

function seedAssignment(itemId: string, sessionId: string, role = "builder"): Assignment {
  assignmentCounter += 1;
  const assignment: Assignment = {
    id: `assign-${assignmentCounter}`,
    itemId,
    sessionId,
    role,
    releasedAt: null,
    lastActive: new Date(0).toISOString(),
  };
  liveAssignments.set(`${itemId}:${sessionId}`, assignment);
  return assignment;
}

function seedAgentName(name: string): void {
  agentNames.set(name, { name, held: null });
}

function fakeEvent(extra: Record<string, unknown> = {}) {
  eventCounter += 1;
  return { id: BigInt(eventCounter), txId: BigInt(eventCounter), ts: new Date(0), ...extra };
}

/**
 * The one fake service both bindings reach — a stand-in for the transaction
 * and the database (same substitution tests/cli-one-interface.test.ts
 * makes), never for the rules: every rejection below is a real
 * `ConflictError`/`NotFoundError` thrown by this fake and carried through
 * two different transports exactly as the real operations' errors are.
 */
const sharedService = {
  async call(name: string, input: unknown): Promise<unknown> {
    const body = input as Record<string, unknown>;
    switch (name) {
      case "claim": {
        if (!items.has(body.itemId as string)) {
          throw new NotFoundError(`No such item: ${body.itemId}.`, { fields: ["itemId"] });
        }
        return seedAssignment(body.itemId as string, body.sessionId as string, body.role as string);
      }
      case "release": {
        const key = `${body.itemId}:${body.sessionId}`;
        const live = liveAssignments.get(key);
        if (!live) {
          throw new ConflictError(`No live assignment for ${key}.`, {
            fields: ["itemId", "sessionId"],
          });
        }
        live.releasedAt = new Date(0).toISOString();
        liveAssignments.delete(key);
        return live;
      }
      case "heartbeat": {
        const key = `${body.itemId}:${body.sessionId}`;
        const live = liveAssignments.get(key);
        if (!live) {
          throw new ConflictError(`No live assignment for ${key}.`, {
            fields: ["itemId", "sessionId"],
          });
        }
        live.lastActive = new Date(1).toISOString();
        return live;
      }
      case "checkpoint": {
        const key = `${body.itemId}:${body.sessionId}`;
        if (!liveAssignments.has(key)) {
          throw new ConflictError(`No live assignment for ${key}.`, {
            fields: ["itemId", "sessionId"],
          });
        }
        return fakeEvent({ body: body.body ?? null });
      }
      case "note": {
        if (!items.has(body.itemId as string)) {
          throw new NotFoundError(`No such item: ${body.itemId}.`, { fields: ["itemId"] });
        }
        return fakeEvent({ body: body.body ?? null });
      }
      case "orientation": {
        if (!items.has(body.itemId as string)) {
          throw new NotFoundError(`No such item: ${body.itemId}.`, { fields: ["itemId"] });
        }
        return {
          item: { id: body.itemId },
          checkpoint: null,
          whatChanged: [],
          changedSince: "0",
          horizon: "0",
          openLoops: { notDone: [], children: [], loops: [] },
          crew: [],
          // Present only when the caller sent `since` — proves the query
          // string round-trips, not just the path.
          ...(body.since === undefined ? {} : { echoedSince: body.since }),
        };
      }
      case "my_work": {
        return { sessionId: body.sessionId ?? null, items: [] };
      }
      case "get_crew_name": {
        const available = [...agentNames.values()].find((a) => a.held === null);
        if (!available) {
          throw new ConflictError("No crew name is available — every name is retired or held.", {
            fields: [],
          });
        }
        available.held = body.sessionId as string;
        return { name: available.name, roleHint: null, persona: null, retiredAt: null };
      }
      default:
        throw new NotFoundError(`No such operation: ${name}.`, { fields: ["operation"] });
    }
  },
};

vi.mock("@/lib/service/live", () => ({ service: sharedService }));

const { POST: claimPost } = await import("@/app/api/claims/route");
const { POST: releasePost } = await import("@/app/api/claims/release/route");
const { POST: heartbeatPost } = await import("@/app/api/claims/heartbeat/route");
const { POST: checkpointPost } = await import("@/app/api/checkpoints/route");
const { POST: notesPost } = await import("@/app/api/items/[id]/notes/route");
const { GET: orientationGet } = await import("@/app/api/items/[id]/orientation/route");
const { GET: myWorkGet } = await import("@/app/api/my-work/route");
const { POST: crewNamePost } = await import("@/app/api/crew/name/route");

/** Dispatches to this row's own real route handlers, by method and path — same shape as cli-one-interface.test.ts's `routeFetch`. */
async function routeFetch(url: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const request = new Request(url, init);
  const { pathname } = parsed;

  if (pathname === "/api/claims" && init.method === "POST") return claimPost(request);
  if (pathname === "/api/claims/release" && init.method === "POST") return releasePost(request);
  if (pathname === "/api/claims/heartbeat" && init.method === "POST") return heartbeatPost(request);
  if (pathname === "/api/checkpoints" && init.method === "POST") return checkpointPost(request);
  if (pathname === "/api/crew/name" && init.method === "POST") return crewNamePost(request);

  const notesMatch = /^\/api\/items\/([^/]+)\/notes$/.exec(pathname);
  if (notesMatch && init.method === "POST") {
    const id = notesMatch[1] as string;
    return notesPost(request, { params: Promise.resolve({ id: decodeURIComponent(id) }) });
  }

  const orientationMatch = /^\/api\/items\/([^/]+)\/orientation$/.exec(pathname);
  if (orientationMatch && init.method === "GET") {
    const id = orientationMatch[1] as string;
    return orientationGet(request, { params: Promise.resolve({ id: decodeURIComponent(id) }) });
  }

  if (pathname === "/api/my-work" && init.method === "GET") return myWorkGet(request);

  return new Response("not found", { status: 404 });
}

function directBinding(): Binding {
  return createDirectBinding({ service: sharedService });
}

function httpBinding(): Binding {
  return createHttpBinding({ baseUrl: "http://server.invalid", fetch: routeFetch });
}

/** Everything about an outcome both bindings must agree on. */
function comparable(outcome: RunOutcome) {
  return { envelope: outcome.envelope, exitCode: outcome.exitCode };
}

function resetState(): void {
  items.clear();
  liveAssignments.clear();
  agentNames.clear();
  assignmentCounter = 0;
  eventCounter = 0;
}

/**
 * Runs one command against both bindings and returns both outcomes.
 *
 * **`setup` runs fresh, once per binding — not once for both.** Several of
 * these commands mutate the fake store (`claim` mints a new assignment,
 * `release`/`heartbeat` consume the one live assignment, `crew name` empties
 * the pool by one). Sharing one seed between two sequential mutating calls
 * would make the *second* call see the *first* call's aftermath rather than
 * an equivalent starting state — a bug in the test, not a real difference
 * between the bindings, and exactly the kind of thing that would make this
 * file assert two different scenarios agree by accident. Resetting and
 * re-seeding identically before each call is what keeps the comparison
 * honest: both bindings run the exact same scenario, independently.
 */
async function bothBindings(argv: readonly string[], setup: () => void = () => {}) {
  resetState();
  setup();
  const direct = await runCommand(argv, directBinding());
  resetState();
  setup();
  const http = await runCommand(argv, httpBinding());
  return { direct, http };
}

beforeEach(() => {
  resetState();
});

describe("session claim — both bindings", () => {
  it("agree on acceptance, including the operation's own returned shape", async () => {
    const { direct, http } = await bothBindings(
      ["session", "claim", "item-1", "--role", "builder", "--session", "s1"],
      () => seedItem("item-1"),
    );
    expect(comparable(http)).toEqual(comparable(direct));
    if (!direct.envelope.ok) throw new Error("expected acceptance");
    expect(direct.envelope.data).toMatchObject({ itemId: "item-1", sessionId: "s1" });
  });

  it("agree on the not_found rejection for a non-existent item, same code and fields", async () => {
    const { direct, http } = await bothBindings(["session", "claim", "missing", "--session", "s1"]);
    expect(comparable(http)).toEqual(comparable(direct));
    if (direct.envelope.ok) throw new Error("expected a rejection");
    expect(direct.envelope.error.code).toBe("not_found");
    expect(direct.exitCode).toBe(3);
  });
});

describe("session release / session heartbeat — both bindings", () => {
  it.each(["release", "heartbeat"])(
    "session %s agrees on the conflict rejection for a session holding nothing",
    async (verb) => {
      const { direct, http } = await bothBindings(["session", verb, "item-1", "--session", "s1"]);
      expect(comparable(http)).toEqual(comparable(direct));
      if (direct.envelope.ok) throw new Error("expected a rejection");
      expect(direct.envelope.error.code).toBe("conflict");
      expect(direct.exitCode).toBe(3);
    },
  );

  it("session release agrees on acceptance for a live assignment", async () => {
    const { direct, http } = await bothBindings(
      ["session", "release", "item-1", "--session", "s1"],
      () => {
        seedItem("item-1");
        seedAssignment("item-1", "s1");
      },
    );
    expect(comparable(http)).toEqual(comparable(direct));
    expect(direct.envelope.ok).toBe(true);
  });
});

/**
 * `checkpoint`/`note` both return an `AppendedEvent` on `direct` — the raw
 * operation output, `id`/`txId` as `bigint`, plus `body`/`itemId`/etc. Over
 * `http`, the real route (`_shared/respond.ts`'s `serializeAppendedEvent`,
 * #29's territory, unchanged by this row) sends back only `{ id, txId, ts }`
 * — `bigint` cannot cross a JSON boundary at all, and that helper's own
 * signature narrows to exactly those three fields, dropping `body` and
 * everything else. That is a genuine, pre-existing asymmetry between what
 * the two bindings return for these two operations, not a bug introduced
 * here, so this compares the two on the fields `http` actually carries —
 * `id`/`txId` normalised to a string, `ts` normalised to its ISO string —
 * rather than asserting an equality neither binding is capable of meeting.
 */
function normaliseEventShape(outcome: RunOutcome): unknown {
  if (!outcome.envelope.ok) return outcome.envelope;
  const data = outcome.envelope.data as { id: unknown; txId: unknown; ts: unknown };
  const ts = data.ts instanceof Date ? data.ts.toISOString() : data.ts;
  return { ...outcome.envelope, data: { id: String(data.id), txId: String(data.txId), ts } };
}

describe("session checkpoint — both bindings", () => {
  it("agree on the id/txId/ts every caller can rely on over either binding", async () => {
    const { direct, http } = await bothBindings(
      ["session", "checkpoint", "item-1", "--session", "s1", "--body", "checked in"],
      () => {
        seedItem("item-1");
        seedAssignment("item-1", "s1");
      },
    );
    expect(direct.exitCode).toBe(http.exitCode);
    expect(normaliseEventShape(http)).toEqual(normaliseEventShape(direct));
    if (!direct.envelope.ok) throw new Error("expected acceptance");
    expect(typeof (direct.envelope.data as { id: unknown }).id).toBe("bigint");
  });
});

describe("item note — both bindings", () => {
  it("agree on acceptance, needing no claim", async () => {
    const { direct, http } = await bothBindings(
      ["item", "note", "item-1", "--body", "a remark"],
      () => seedItem("item-1"),
    );
    expect(direct.exitCode).toBe(http.exitCode);
    expect(normaliseEventShape(http)).toEqual(normaliseEventShape(direct));
    expect(direct.envelope.ok).toBe(true);
  });

  it("agree on not_found for a missing item", async () => {
    const { direct, http } = await bothBindings(["item", "note", "missing", "--body", "x"]);
    expect(comparable(http)).toEqual(comparable(direct));
    if (direct.envelope.ok) throw new Error("expected a rejection");
    expect(direct.envelope.error.code).toBe("not_found");
  });
});

describe("item orientation — both bindings", () => {
  it("agree on acceptance and round-trip --since through the query string", async () => {
    const { direct, http } = await bothBindings(
      ["item", "orientation", "item-1", "--since", "7"],
      () => seedItem("item-1"),
    );
    expect(comparable(http)).toEqual(comparable(direct));
    if (!direct.envelope.ok) throw new Error("expected acceptance");
    // Only present when `--since` was sent — proves the http binding put it
    // on the query string and the route read it back, not just the path.
    expect((direct.envelope.data as { echoedSince?: string }).echoedSince).toBe("7");
  });
});

describe("session my-work — both bindings", () => {
  it("agree on acceptance with no session at all", async () => {
    const { direct, http } = await bothBindings(["session", "my-work"]);
    expect(comparable(http)).toEqual(comparable(direct));
    expect(direct.envelope).toEqual({ ok: true, data: { sessionId: null, items: [] } });
  });
});

describe("crew name — both bindings", () => {
  it("agree on acceptance, handing out the same seeded name shape", async () => {
    const { direct, http } = await bothBindings(["crew", "name", "--session", "s1"], () =>
      seedAgentName("crew-a"),
    );
    expect(comparable(http)).toEqual(comparable(direct));
    if (!direct.envelope.ok) throw new Error("expected acceptance");
    expect((direct.envelope.data as { name: string }).name).toBe("crew-a");
  });

  it("agree on the conflict rejection when the pool is exhausted", async () => {
    const { direct, http } = await bothBindings(["crew", "name", "--session", "s1"]);
    expect(comparable(http)).toEqual(comparable(direct));
    if (direct.envelope.ok) throw new Error("expected a rejection");
    expect(direct.envelope.error.code).toBe("conflict");
    expect(direct.exitCode).toBe(3);
  });
});
