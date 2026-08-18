// src/lib/admin/state.ts — the administration surface's load and write
// lifecycle (MILESTONES.md #93, over the API from #92).
//
// The tests that matter most here are about the **override semantics**:
// `null` and `[]` are different instructions (§17.7, §23.2), and the two
// places that could quietly collapse them are `isOverridden` and
// `buildPatchBody`. Both are asserted from each side.
import { describe, expect, it, vi } from "vitest";
import { adminKindBySlug } from "@/lib/admin/kinds";
import {
  adminErrorMessageFrom,
  buildPatchBody,
  createRow,
  fetchRows,
  isArchived,
  isOverridden,
  overrideLabel,
  rowPath,
  setArchived,
  updateRow,
} from "@/lib/admin/state";

const repos = adminKindBySlug("repos")!;
const machines = adminKindBySlug("machines")!;

const sourceGlobs = machines.fields.find((field) => field.name === "sourceGlobs")!;
const displayName = repos.fields.find((field) => field.name === "displayName")!;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("loading a kind's rows", () => {
  it("reads the array out of the collection the kind names", () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ repos: [{ id: "web" }] }));
    return fetchRows(repos, {}, fetchImpl as unknown as typeof fetch).then((rows) => {
      expect(fetchImpl).toHaveBeenCalledWith("/api/ui/repos");
      expect(rows).toEqual([{ id: "web" }]);
    });
  });

  it("asks for archived rows only when told to", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ repos: [] }));
    await fetchRows(repos, {}, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/api/ui/repos");

    fetchImpl.mockClear();
    await fetchRows(repos, { includeArchived: true }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/api/ui/repos?includeArchived=true");
  });

  it("yields an empty list when the body does not carry the collection", async () => {
    // A component mapping over `undefined` would crash the page; an empty
    // list renders as "nothing here yet".
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    expect(await fetchRows(repos, {}, fetchImpl as unknown as typeof fetch)).toEqual([]);
  });

  it("yields an empty list when the collection is not an array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ repos: "nope" }));
    expect(await fetchRows(repos, {}, fetchImpl as unknown as typeof fetch)).toEqual([]);
  });

  it("throws a message naming the kind and the status when the request failed", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(fetchRows(repos, {}, fetchImpl as unknown as typeof fetch)).rejects.toThrow("500");
  });

  it("turns a caught non-Error into a message naming the kind", () => {
    expect(adminErrorMessageFrom("boom", repos)).toContain("repositories");
    expect(adminErrorMessageFrom(new Error("specific"), repos)).toBe("specific");
  });
});

describe("override versus inheriting — §23.2's per-row indicator", () => {
  it("reads null as inheriting", () => {
    expect(isOverridden({ sourceGlobs: null }, sourceGlobs)).toBe(false);
    expect(overrideLabel({ sourceGlobs: null }, sourceGlobs)).toBe("Inheriting");
  });

  it("reads a missing value as inheriting", () => {
    expect(isOverridden({}, sourceGlobs)).toBe(false);
  });

  it("reads a populated list as an override", () => {
    expect(isOverridden({ sourceGlobs: ["a"] }, sourceGlobs)).toBe(true);
    expect(overrideLabel({ sourceGlobs: ["a"] }, sourceGlobs)).toBe("Override");
  });

  it("reads an EMPTY list as an override, not as inheriting", () => {
    // The distinction the nullable column exists for: an empty override
    // says "mint from nowhere", inheriting says "use the global setting".
    // Collapsing them would silently turn the first into the second at the
    // one surface somebody is looking straight at it.
    expect(isOverridden({ sourceGlobs: [] }, sourceGlobs)).toBe(true);
    expect(overrideLabel({ sourceGlobs: [] }, sourceGlobs)).toBe("Override");
  });

  it("reads an empty object as an override too", () => {
    const budgetWindows = adminKindBySlug("accounts")!.fields.find(
      (field) => field.name === "budgetWindows",
    )!;
    expect(isOverridden({ budgetWindows: {} }, budgetWindows)).toBe(true);
  });

  it("is never true for a field that overrides nothing", () => {
    expect(isOverridden({ displayName: "Web" }, displayName)).toBe(false);
  });
});

describe("archived rows", () => {
  it("reads a timestamp as archived and null as not", () => {
    expect(isArchived({ archivedAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect(isArchived({ archivedAt: null })).toBe(false);
    expect(isArchived({})).toBe(false);
  });
});

describe("building the PATCH body", () => {
  it("sends only the fields it was given", () => {
    // Every #92 edit schema treats an omitted field as "no change", so
    // sending the whole row back would re-write untouched values.
    expect(buildPatchBody(repos, { displayName: "Web" })).toEqual({ displayName: "Web" });
  });

  it("keeps an explicit null, which is how §17.7 spells clearing an override", () => {
    expect(buildPatchBody(machines, { sourceGlobs: null })).toEqual({ sourceGlobs: null });
  });

  it("keeps an empty array, which is a different instruction from null", () => {
    expect(buildPatchBody(machines, { sourceGlobs: [] })).toEqual({ sourceGlobs: [] });
  });

  it("drops a read-only field, whatever a caller put in the drafts", () => {
    // The #92 schemas are `.strict()`, so an unexpected property is refused
    // outright and the whole edit fails for a field nobody meant to change.
    expect(buildPatchBody(repos, { id: "renamed", displayName: "Web" })).toEqual({
      displayName: "Web",
    });
  });

  it("drops a field the kind does not declare at all", () => {
    expect(buildPatchBody(repos, { notAField: 1, displayName: "Web" })).toEqual({
      displayName: "Web",
    });
  });

  it("sends an empty body when nothing was touched", () => {
    expect(buildPatchBody(repos, {})).toEqual({});
  });
});

describe("writing", () => {
  it("POSTs a create to the collection", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "web" }));
    const outcome = await createRow(
      repos,
      { id: "web", displayName: "Web", defaultBranch: "main" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ui/repos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      id: "web",
      displayName: "Web",
      defaultBranch: "main",
    });
  });

  it("refuses a create for a kind that has none, without calling fetch", async () => {
    // The API has no create for a machine; sending one would 405 with a
    // message about HTTP rather than about why this kind has no create.
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const outcome = await createRow(machines, { name: "x" }, fetchImpl as unknown as typeof fetch);
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("PATCHes an edit to the row's own path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await updateRow(repos, "web", { displayName: "Web" }, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ui/repos/web");
    expect(init.method).toBe("PATCH");
  });

  it("escapes an id that would otherwise change the path", () => {
    expect(rowPath(repos, "a/b")).toBe("/api/ui/repos/a%2Fb");
  });

  it("archives by PATCHing archived, never by deleting", async () => {
    // §23.1: "Archive, never delete — attribution and history point at
    // these rows."
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await setArchived(repos, "web", true, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ archived: true });
  });

  it("un-archives with archived false", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await setArchived(repos, "web", false, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ archived: false });
  });

  it("refuses to archive a kind that cannot be archived, without calling fetch", async () => {
    // `machines` carries no `archivedAt` column at all (T13: `people` now
    // CAN archive, backed by `update_person`'s `archived` flag, so it no
    // longer proves this refusal path).
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const outcome = await setArchived(
      machines,
      "machine-a",
      true,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("what a failed write reports", () => {
  it("shows the service's own message, which names what it refused", async () => {
    // `update_account` refuses an unregistered vendor by naming it; that
    // sentence is the useful one, not the status code.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "Unknown vendor: nope." } }, { status: 400 }),
    );
    const outcome = await updateRow(
      adminKindBySlug("accounts")!,
      "a",
      { vendor: "nope" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe("Unknown vendor: nope.");
  });

  it("falls back to the status when the body is not the error envelope", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 502 }));
    const outcome = await updateRow(repos, "web", {}, fetchImpl as unknown as typeof fetch);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("502");
  });

  it("falls back to the status when the envelope's message is empty", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "" } }, { status: 409 }));
    const outcome = await updateRow(repos, "web", {}, fetchImpl as unknown as typeof fetch);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("409");
  });
});
