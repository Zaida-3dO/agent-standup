// M10 T11 — the projects grid's fetch shaping. MILESTONES.md #74.
//
// Each test names the single-character change that would break it.
import { describe, expect, it } from "vitest";
import { fetchProjects, projectsErrorMessageFrom } from "@/lib/projects/state";

/** A `fetch` stand-in that records the URL it was called with. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("fetchProjects", () => {
  it("asks for the default slice with no query string", () => {
    // Breaks if: `includeCompleted` is always appended — the URL gains a
    // query string and this fails.
    const { impl, calls } = stubFetch({ projects: [], childlessCount: 0 });
    return fetchProjects({ fetchImpl: impl }).then(() => {
      expect(calls).toEqual(["/api/ui/projects"]);
    });
  });

  it("asks for finished projects when told to", async () => {
    // Breaks if: the parameter name changes — the server would silently
    // return the default slice and the toggle would appear to do nothing.
    const { impl, calls } = stubFetch({ projects: [], childlessCount: 0 });
    await fetchProjects({ includeCompleted: true, fetchImpl: impl });

    expect(calls).toEqual(["/api/ui/projects?includeCompleted=true"]);
  });

  it("throws a message fit to show, not a raw Response, on a non-2xx", async () => {
    // Breaks if: the `response.ok` check is removed — the body is parsed
    // and an empty grid renders as if the read had succeeded.
    const { impl } = stubFetch({}, { ok: false, status: 500 });

    await expect(fetchProjects({ fetchImpl: impl })).rejects.toThrow(
      "Could not load projects (GET /api/projects returned 500).",
    );
  });

  it("recomputes childlessCount when the server omits it", async () => {
    // Zero is a claim — "nothing here is broken" — and it is the one claim
    // this screen must not make falsely.
    //
    // Breaks if: the fallback becomes `?? 0` — the count reads 0 while a
    // childless project sits in the list.
    const { impl } = stubFetch({
      projects: [
        { id: "a", childless: true },
        { id: "b", childless: false },
      ],
    });

    const payload = await fetchProjects({ fetchImpl: impl });

    expect(payload.childlessCount).toBe(1);
  });

  it("prefers the server's count when it sent one", async () => {
    // Breaks if: the client always recomputes — it would disagree with a
    // server that counted over a wider set than it returned.
    const { impl } = stubFetch({ projects: [{ id: "a", childless: true }], childlessCount: 7 });

    expect((await fetchProjects({ fetchImpl: impl })).childlessCount).toBe(7);
  });

  it("degrades a response with no projects key to an empty list", async () => {
    // Breaks if: `body.projects ?? []` loses its fallback — the grid maps
    // over `undefined` and throws.
    const { impl } = stubFetch({});

    expect(await fetchProjects({ fetchImpl: impl })).toEqual({ projects: [], childlessCount: 0 });
  });
});

describe("projectsErrorMessageFrom", () => {
  it("uses an Error's own message", () => {
    // Breaks if: the `instanceof` branch is removed — every failure reads
    // as the generic fallback and the status code is lost.
    expect(projectsErrorMessageFrom(new Error("boom"))).toBe("boom");
  });

  it("falls back for a thrown non-Error", () => {
    // Breaks if: the fallback is removed — the card renders "undefined".
    expect(projectsErrorMessageFrom("a string")).toBe("Could not load projects.");
  });
});
