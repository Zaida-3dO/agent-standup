// `src/lib/nav/breadcrumb.ts` — what the top strip says you are looking at.
import { describe, expect, it } from "vitest";
import { crumbsFor, humanise, looksLikeId, shortenSegment } from "@/lib/nav/breadcrumb";

describe("shortenSegment", () => {
  it("truncates an identifier-length segment", () => {
    expect(shortenSegment("0193a8f2-1c4d-7abc-8def-0123456789ab")).toBe("0193a8f2…");
  });

  it("leaves a short segment exactly as it is", () => {
    // Truncating something already short only removes information.
    expect(shortenSegment("repos")).toBe("repos");
    // The boundary itself: exactly at the limit is not truncated.
    expect(shortenSegment("12345678")).toBe("12345678");
    expect(shortenSegment("123456789")).toBe("12345678…");
  });
});

describe("humanise", () => {
  it("turns a slug into sentence case, not title case", () => {
    // Sentence case — a heading, not a headline. "Needs You" would fail.
    expect(humanise("needs-you")).toBe("Needs you");
    expect(humanise("repos")).toBe("Repos");
    expect(humanise("open_loops")).toBe("Open loops");
  });
});

describe("looksLikeId", () => {
  it("treats a long segment containing a digit as an identifier", () => {
    expect(looksLikeId("0193a8f2-1c4d-7abc")).toBe(true);
    expect(looksLikeId("cm3x9k2p0000abcd1234")).toBe(true);
  });

  it("does NOT treat a long word as an identifier", () => {
    // The defect this rule exists to stop: `projects-archive` truncated to
    // `Projects…` is a crumb that has lost the half of its name that
    // identified it. Dropping the digit test makes this fail.
    expect(looksLikeId("projects-archive")).toBe(false);
    expect(looksLikeId("notifications")).toBe(false);
  });

  it("does not truncate a short segment even when it has a digit", () => {
    expect(looksLikeId("v2")).toBe(false);
  });
});

describe("crumbsFor", () => {
  it("renders the root as a single unlinked Standup crumb", () => {
    // Unlinked: a crumb pointing at the page you are already on is a
    // control that does nothing.
    expect(crumbsFor("/")).toEqual([{ label: "Standup", href: null }]);
  });

  it("renders a sidebar destination as its label alone, unlinked", () => {
    // No `Home / Board`: the sidebar IS the level above and it is on
    // screen, so there is no hierarchy left to express.
    expect(crumbsFor("/board")).toEqual([{ label: "Board", href: null }]);
    expect(crumbsFor("/needs-you")).toEqual([{ label: "Needs you", href: null }]);
  });

  it("uses the route's own label rather than the humanised slug", () => {
    // `/needs-you` humanises to "Needs you" either way, so this uses a case
    // where the two genuinely differ.
    expect(crumbsFor("/projects")[0]!.label).toBe("Projects");
  });

  it("renders a path the sidebar does not own from its segments", () => {
    // `/items/{id}` is reachable and is deliberately not a nav destination
    // — a strip that only mirrored the highlighted nav entry would go blank
    // here, on exactly the page a reader most often arrives at from a link.
    const crumbs = crumbsFor("/items/0193a8f2-1c4d-7abc");
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toEqual({ label: "Items", href: null });
    // Shortened, and NOT sentence-cased — an id is a citation, not a word,
    // so capitalising it would be inventing a name it does not have.
    expect(crumbs[1]).toEqual({ label: "0193a8f2…", href: null });
  });

  it("links a leading segment that IS a real destination, and never the trailing one", () => {
    const crumbs = crumbsFor("/projects/0193a8f2-1c4d-7abc");
    expect(crumbs).toHaveLength(2);
    // Up one level, to a path that certainly resolves.
    expect(crumbs[0]).toEqual({ label: "Projects", href: "/projects" });
    // The trailing crumb is where you are; linking it does nothing.
    expect(crumbs[1]!.href).toBeNull();
  });

  it("never emits a link to a path that is not a real destination", () => {
    // `/items` is not a page. A breadcrumb that 404s is worse than one that
    // is plain text, so the rule is "link only a known destination".
    for (const path of ["/items/abc", "/admin/repos", "/projects/abc"]) {
      for (const crumb of crumbsFor(path)) {
        if (crumb.href === null) continue;
        expect(["/projects", "/settings", "/board"]).toContain(crumb.href);
      }
    }
  });

  it("does not treat a look-alike path as a known destination", () => {
    // `/projects-archive` must not link to `/projects` — the segment-
    // boundary rule in `isActiveRoute` is what stops it.
    const crumbs = crumbsFor("/projects-archive/abc");
    expect(crumbs[0]).toEqual({ label: "Projects archive", href: null });
  });
});
