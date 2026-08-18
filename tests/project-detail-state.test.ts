// M10 T12 — the project page's load lifecycle and its two repair calls.
// MILESTONES.md #75.
//
// **What would make this file hollow.** Asserting that `fetchProjectDetail`
// returns the body it was given proves the happy path and nothing else. The
// assertions that carry weight are about the degradations:
//
//   - a response that omits `historicalVerificationAvailable` must default
//     to the CAUTIOUS reading (`false`), because guessing the permissive
//     way makes the page promise a route the state machine refuses,
//   - `progress` must never be defaulted to `0` — zero is a claim about
//     work that may not exist,
//   - a refused repair must surface the service's own message, which is the
//     only text that says what to do next,
//   - and `reparentItem` must send `null` for the top level, never the
//     empty string the operation's schema rejects.
//
// Each test names the single-character change that would break it.
import { describe, expect, it } from "vitest";
import {
  emptyCounts,
  fetchProjectDetail,
  projectDetailErrorMessageFrom,
  reparentItem,
  retypeToTask,
} from "@/lib/project-detail/state";

/** A `fetch` returning one canned response, and recording what it was called with. */
function stubFetch(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throwOnJson?: boolean;
}): { impl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => {
        if (response.throwOnJson === true) throw new Error("not JSON");
        return response.body;
      },
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const minimalProject = {
  id: "p-1",
  title: "A project",
  headline: null,
  area: "web",
  repo: null,
  priority: "P2",
  kind: "project",
};

describe("fetchProjectDetail", () => {
  it("fills in every missing collection rather than handing back undefined", async () => {
    const { impl } = stubFetch({ body: { detail: { project: minimalProject } } });
    const detail = await fetchProjectDetail("p-1", impl);
    // A component mapping over `detail.children` on a partial response would
    // crash on `undefined.map` — dropping any `?? []` fails here.
    expect(detail.children).toEqual([]);
    expect(detail.blockedChildren).toEqual([]);
    expect(detail.activity).toEqual([]);
    expect(detail.assignments).toEqual([]);
    expect(detail.derived.counts).toEqual(emptyCounts());
  });

  it("defaults the verification window to SHUT when the server does not say", async () => {
    const { impl } = stubFetch({
      body: { detail: { project: minimalProject, childless: true, repair: { childless: true } } },
    });
    const detail = await fetchProjectDetail("p-1", impl);
    // Changing the `?? false` to `?? true` makes the page offer a repair as
    // though it led to a closeable item on a deployment where it does not.
    // The cost of erring this way is a warning nobody needed; the cost of
    // erring the other way is a promise the state machine refuses.
    expect(detail.repair.historicalVerificationAvailable).toBe(false);
  });

  it("passes the window through when the server says it is open", async () => {
    const { impl } = stubFetch({
      body: {
        detail: {
          project: minimalProject,
          repair: { childless: true, historicalVerificationAvailable: true },
        },
      },
    });
    const detail = await fetchProjectDetail("p-1", impl);
    // Hardcoding `false` — the over-cautious shortcut — fails here, so the
    // flag is genuinely plumbed rather than merely defaulted.
    expect(detail.repair.historicalVerificationAvailable).toBe(true);
  });

  it("leaves progress null rather than defaulting it to zero", async () => {
    const { impl } = stubFetch({
      body: { detail: { project: minimalProject, total: 0, childless: true } },
    });
    const detail = await fetchProjectDetail("p-1", impl);
    // `?? null` → `?? 0` would let a childless project render a 0% bar.
    expect(detail.progress).toBeNull();
  });

  it("falls back to the arithmetic for childless rather than asserting the project is fine", async () => {
    const { impl } = stubFetch({ body: { detail: { project: minimalProject, total: 0 } } });
    const detail = await fetchProjectDetail("p-1", impl);
    // `?? total === 0` → `?? false` would hide the structural fault on any
    // response missing the flag.
    expect(detail.childless).toBe(true);
  });

  it("names the project in a 404 rather than reporting a bare status", async () => {
    const { impl } = stubFetch({ ok: false, status: 404 });
    await expect(fetchProjectDetail("p-1", impl)).rejects.toThrow("No such project: p-1.");
  });

  it("throws a message fit to display for any other failure", async () => {
    const { impl } = stubFetch({ ok: false, status: 500 });
    await expect(fetchProjectDetail("p-1", impl)).rejects.toThrow("returned 500");
  });

  it("refuses a response carrying no project rather than rendering a blank page", async () => {
    const { impl } = stubFetch({ body: { detail: {} } });
    await expect(fetchProjectDetail("p-1", impl)).rejects.toThrow("carried no project");
  });

  it("encodes the id, so an id with a slash cannot reach a different path", async () => {
    const { impl, calls } = stubFetch({ body: { detail: { project: minimalProject } } });
    await fetchProjectDetail("a/b", impl);
    // Dropping `encodeURIComponent` sends `GET /api/projects/a/b`.
    expect(calls[0]!.url).toBe("/api/ui/projects/a%2Fb");
  });
});

describe("retypeToTask", () => {
  it("posts the target project and reports what changed AND what did not", async () => {
    const { impl, calls } = stubFetch({ body: { item: { id: "p-1" } } });
    const outcome = await retypeToTask("p-1", "inbox", impl);
    expect(calls[0]!.url).toBe("/api/ui/items/p-1/retype");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ projectId: "inbox" });
    expect(outcome.status).toBe("done");
    // The message must not imply the item is now resolvable — the
    // operations keep whatever state is on the row.
    expect(outcome.message).toContain("can be transitioned");
    expect(outcome.message).toContain("state was kept");
  });

  it("returns a refusal with the service's own message rather than throwing", async () => {
    const { impl } = stubFetch({
      ok: false,
      status: 422,
      body: {
        error: {
          message: "This project still has 2 children. Move them with reparent_item first.",
        },
      },
    });
    const outcome = await retypeToTask("p-1", "inbox", impl);
    expect(outcome.status).toBe("refused");
    // Verbatim. A generic "the repair failed" here would throw away the only
    // text that says what to do next.
    expect(outcome.message).toContain("Move them with reparent_item first");
  });

  it("falls back to the status when a refusal body is not JSON", async () => {
    const { impl } = stubFetch({ ok: false, status: 500, throwOnJson: true });
    const outcome = await retypeToTask("p-1", "inbox", impl);
    // A refusal whose body cannot be parsed is still a refusal — letting the
    // parse error escape would blank the page the user is working on.
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("500");
  });

  it("falls back to the status when the error body has an empty message", async () => {
    const { impl } = stubFetch({ ok: false, status: 422, body: { error: { message: "   " } } });
    const outcome = await retypeToTask("p-1", "inbox", impl);
    // Dropping the `.trim()` check renders a blank refusal that says nothing.
    expect(outcome.message).toContain("422");
  });
});

describe("reparentItem", () => {
  it("sends null for the top level, not an empty string", async () => {
    const { impl, calls } = stubFetch({ body: { item: { id: "p-1" } } });
    const outcome = await reparentItem("p-1", null, impl);
    // The operation's schema is `.min(1).nullable()`, so `""` is refused
    // outright — sending it would turn a valid choice into invalid input.
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ parentId: null });
    expect(outcome.message).toContain("top level");
  });

  it("sends the parent id when one is given, and says the kind was re-derived", async () => {
    const { impl, calls } = stubFetch({ body: { item: { id: "p-1" } } });
    const outcome = await reparentItem("p-1", "parent-9", impl);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ parentId: "parent-9" });
    expect(outcome.status).toBe("done");
    // The two outcomes must not read identically — moving to the top level
    // and moving under a parent have different consequences for kind.
    expect(outcome.message).not.toContain("top level");
  });

  it("surfaces a cycle refusal verbatim", async () => {
    const { impl } = stubFetch({
      ok: false,
      status: 422,
      body: {
        error: {
          message: "An item cannot be moved under itself or under one of its own descendants.",
        },
      },
    });
    const outcome = await reparentItem("p-1", "p-1", impl);
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("under one of its own descendants");
  });
});

describe("projectDetailErrorMessageFrom", () => {
  it("uses an Error's message and falls back for anything else", () => {
    expect(projectDetailErrorMessageFrom(new Error("boom"))).toBe("boom");
    // A thrown string must not render as "[object Object]" or as itself
    // unvetted.
    expect(projectDetailErrorMessageFrom("boom")).toBe("Could not load this project.");
  });
});

describe("emptyCounts", () => {
  it("carries every state at zero, so a missing key never renders as a gap", () => {
    const counts = emptyCounts();
    expect(Object.keys(counts)).toHaveLength(12);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    // Deleting one entry makes the distribution strip skip a band silently.
    expect(counts.blocked).toBe(0);
    expect(counts.cancelled).toBe(0);
  });
});
