// `fetchAreaNames` — the vocabulary read behind the create form's area
// suggestion list (row 6b2fb637).
//
// Pure fetch shaping against a stub `fetch`, so this runs in the repo's
// DOM-free harness (`vitest.config.ts`: `environment: "node"`) exactly like
// the module it tests, which takes its `fetch` as an argument for this
// reason.
//
// **What is actually at stake here is the failure posture.** The area field
// was free text before this row and remains free text after it: the
// suggestion list is an aid, never a gate. So every way this read can fail
// has to degrade to "no suggestions" and never to "cannot create an item" —
// a create path broken by a vocabulary endpoint being down would be a
// straight downgrade on the thing the row was trying to improve.
import { describe, expect, it } from "vitest";
import { fetchAreaNames } from "@/lib/board/filter-options";

/** A stub `fetch` answering once with the given status and body. */
function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

/** A stub `fetch` that rejects, standing in for a network failure. */
function fetchRejecting(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

/** Records the URL requested, so the address itself can be asserted. */
function fetchRecording(urls: string[], body: unknown): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : String(input));
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("fetchAreaNames", () => {
  it("returns the ids of the areas that exist", () => {
    const areas = [
      { id: "web", displayName: "Web" },
      { id: "api", displayName: "API" },
    ];
    return expect(fetchAreaNames(fetchReturning(200, { areas }))).resolves.toEqual(["web", "api"]);
  });

  it("returns ids, not display names", async () => {
    // The stored key is what items carry and what `areaFilterCondition`
    // matches on. Suggesting the display name would offer a person a string
    // that is not the one the filter uses — the two are separate fields and
    // only the id is guaranteed to round-trip.
    const areas = [{ id: "web-site", displayName: "The Web Site" }];

    await expect(fetchAreaNames(fetchReturning(200, { areas }))).resolves.toEqual(["web-site"]);
  });

  it("reads the areas collection through the UI proxy", async () => {
    // A browser call carries no credential, so the front end talks to the
    // forwarding route rather than the API directly.
    const urls: string[] = [];
    await fetchAreaNames(fetchRecording(urls, { areas: [] }));

    expect(urls).toEqual(["/api/ui/areas"]);
  });

  it("issues exactly one request", async () => {
    // Its own function rather than a `fetchFilterOptions` call whose other
    // three results are discarded. This fails if it is ever reimplemented
    // in terms of that one.
    const urls: string[] = [];
    await fetchAreaNames(fetchRecording(urls, { areas: [] }));

    expect(urls).toHaveLength(1);
  });

  describe("a failed read costs a suggestion, never the ability to create", () => {
    it("resolves to an empty list on a non-OK response", async () => {
      await expect(fetchAreaNames(fetchReturning(500, {}))).resolves.toEqual([]);
    });

    it("resolves to an empty list when the request throws", async () => {
      // Not a rejected promise: the caller is an effect in `PaletteHost`
      // with no error branch, because there is nothing useful to say to a
      // person about a suggestion list that did not load.
      await expect(fetchAreaNames(fetchRejecting())).resolves.toEqual([]);
    });

    it("resolves to an empty list when the body is not the expected shape", async () => {
      await expect(fetchAreaNames(fetchReturning(200, { areas: "not an array" }))).resolves.toEqual(
        [],
      );
      await expect(fetchAreaNames(fetchReturning(200, {}))).resolves.toEqual([]);
      await expect(fetchAreaNames(fetchReturning(200, null))).resolves.toEqual([]);
    });

    it("skips rows with no usable id rather than offering a blank suggestion", async () => {
      const areas = [{ id: "web" }, { id: "" }, { displayName: "no id at all" }, { id: 7 }];

      await expect(fetchAreaNames(fetchReturning(200, { areas }))).resolves.toEqual(["web"]);
    });
  });
});
