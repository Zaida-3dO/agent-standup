// Normalising and de-duplicating a caller's links — the pure half of
// `item-links.ts`, tested without a database.
//
// The de-duplication assertions here are the application-level half of
// acceptance criterion 1. The database half — the `(itemId, key, url)`
// primary key — is asserted in `tests/item-links.test.ts` against real
// Postgres. Both exist deliberately: this one is what lets a caller be
// *told* what was stored, and the constraint is what makes the guarantee
// true regardless of who writes.
import { describe, expect, it } from "vitest";
import { MAX_LINKS_PER_ITEM, normalizeLinks } from "@/lib/service/items/item-links";
import { LINK_KEY_MAX_CHARS } from "@/lib/service/items/link-url";

describe("normalizeLinks — the key", () => {
  // Would pass wrongly if `.toLowerCase()` were dropped: the two rows would
  // then differ, survive de-duplication, and render as two identical-looking
  // chips on the card.
  it("lowercases, so one label is one link", () => {
    expect(normalizeLinks([{ key: "Slack", url: "https://example.test/a" }])).toEqual([
      { key: "slack", url: "https://example.test/a" },
    ]);
    expect(
      normalizeLinks([
        { key: "Slack", url: "https://example.test/a" },
        { key: "slack", url: "https://example.test/a" },
        { key: "SLACK", url: "https://example.test/a" },
      ]),
    ).toEqual([{ key: "slack", url: "https://example.test/a" }]);
  });

  // Would pass wrongly if the `\s+` collapse were dropped. A tab or a double
  // space inside a label is invisible on a rendered chip, which is exactly
  // the kind of difference that produces two rows a reader cannot tell apart.
  it("trims and collapses interior whitespace", () => {
    expect(normalizeLinks([{ key: "  design   doc ", url: "https://example.test/d" }])).toEqual([
      { key: "design doc", url: "https://example.test/d" },
    ]);
    expect(
      normalizeLinks([
        { key: "design  doc", url: "https://example.test/d" },
        { key: "design doc", url: "https://example.test/d" },
      ]),
    ).toHaveLength(1);
  });

  it("refuses a key that is empty or only whitespace", () => {
    expect(() => normalizeLinks([{ key: "", url: "https://example.test/a" }])).toThrow();
    expect(() => normalizeLinks([{ key: "   ", url: "https://example.test/a" }])).toThrow();
  });

  // Both sides of the boundary, so an off-by-one is visible rather than
  // absorbed.
  it("refuses a key over the bound and accepts one exactly at it", () => {
    const atLimit = "k".repeat(LINK_KEY_MAX_CHARS);
    expect(normalizeLinks([{ key: atLimit, url: "https://example.test/a" }])).toHaveLength(1);
    expect(() => normalizeLinks([{ key: `${atLimit}k`, url: "https://example.test/a" }])).toThrow();
  });
});

describe("normalizeLinks — the url", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeLinks([{ key: "pr", url: "  https://example.test/p  " }])).toEqual([
      { key: "pr", url: "https://example.test/p" },
    ]);
  });

  // **The asymmetry with `key` is the assertion.** Would pass wrongly if
  // someone "tidied" the url with `.toLowerCase()` for symmetry: case is
  // significant after the host in most schemes, so lowercasing a URL stores
  // a pointer to something other than what the caller named.
  it("does NOT lowercase — case is significant in a path", () => {
    const url = "https://example.test/Docs/ReadMe?Ref=AbC#Frag";
    expect(normalizeLinks([{ key: "doc", url }])[0]!.url).toBe(url);
  });

  it("does not decode percent escapes — %2F is not /", () => {
    const url = "https://example.test/a%2Fb";
    expect(normalizeLinks([{ key: "doc", url }])[0]!.url).toBe(url);
  });

  // The security boundary reaching this layer. The full spelling-evasion
  // matrix is `tests/link-url.test.ts`; this asserts the refusal is actually
  // wired in here, which is a separate claim from the validator being right.
  it("refuses an executable scheme", () => {
    expect(() => normalizeLinks([{ key: "x", url: "javascript:alert(1)" }])).toThrow();
    expect(() => normalizeLinks([{ key: "x", url: "data:text/html,<script>" }])).toThrow();
    expect(() => normalizeLinks([{ key: "x", url: "vbscript:msgbox(1)" }])).toThrow();
  });

  it("accepts a coda:// resource URI", () => {
    expect(normalizeLinks([{ key: "doc", url: "coda://docs/d1/rows/r1" }])).toEqual([
      { key: "doc", url: "coda://docs/d1/rows/r1" },
    ]);
  });
});

describe("normalizeLinks — de-duplication", () => {
  // Acceptance criterion 1, application half. Would pass wrongly if the
  // `seen` set were removed: the duplicate would survive here, and the
  // database would absorb it silently via ON CONFLICT — so the caller would
  // be TOLD two links were stored when one was.
  it("collapses an exact duplicate sent twice in one call", () => {
    expect(
      normalizeLinks([
        { key: "slack", url: "https://example.test/t/1" },
        { key: "slack", url: "https://example.test/t/1" },
      ]),
    ).toEqual([{ key: "slack", url: "https://example.test/t/1" }]);
  });

  // The other half of what the composite identity means, and the reason the
  // key is part of it: these are NOT duplicates and collapsing them would
  // silently discard a real link.
  it("keeps one key against two urls — an item may carry three docs", () => {
    const links = normalizeLinks([
      { key: "doc", url: "https://example.test/1" },
      { key: "doc", url: "https://example.test/2" },
      { key: "doc", url: "https://example.test/3" },
    ]);
    expect(links).toHaveLength(3);
  });

  it("keeps one url under two keys — one page can be two things", () => {
    const links = normalizeLinks([
      { key: "ticket", url: "https://example.test/x" },
      { key: "escalation", url: "https://example.test/x" },
    ]);
    expect(links).toHaveLength(2);
  });

  // Would pass wrongly if de-duplication compared raw input rather than the
  // normalised pair — these two entries are the same link spelled twice.
  it("de-duplicates on the NORMALISED pair, not the raw input", () => {
    expect(
      normalizeLinks([
        { key: "Slack", url: " https://example.test/t/1 " },
        { key: "slack  ", url: "https://example.test/t/1" },
      ]),
    ).toEqual([{ key: "slack", url: "https://example.test/t/1" }]);
  });

  it("preserves the caller's order, first occurrence winning", () => {
    const links = normalizeLinks([
      { key: "pr", url: "https://example.test/p" },
      { key: "ticket", url: "https://example.test/t" },
      { key: "pr", url: "https://example.test/p" },
      { key: "slack", url: "https://example.test/s" },
    ]);
    expect(links.map((l) => l.key)).toEqual(["pr", "ticket", "slack"]);
  });

  // Two links whose key and url concatenate to the same text but split at a
  // different point. A printable delimiter could be forged: with `:` as the
  // separator these two would build `ab:coda://c` and `a:coda://bc`, and
  // pick any separator a key may legitimately contain and some such pair
  // collides — silently dropping a real link. Would pass wrongly if the NUL
  // separator became a character a key or url can hold.
  it("cannot confuse two distinct links whose parts concatenate alike", () => {
    expect(
      normalizeLinks([
        { key: "ab", url: "coda://c" },
        { key: "a", url: "coda://bc" },
      ]),
    ).toHaveLength(2);
  });
});

describe("normalizeLinks — the count bound", () => {
  const link = (n: number) => ({ key: `k${n}`, url: `https://example.test/${n}` });

  it("accepts exactly the maximum and refuses one more", () => {
    const atLimit = Array.from({ length: MAX_LINKS_PER_ITEM }, (_, i) => link(i));
    expect(normalizeLinks(atLimit)).toHaveLength(MAX_LINKS_PER_ITEM);
    expect(() => normalizeLinks([...atLimit, link(MAX_LINKS_PER_ITEM)])).toThrow();
  });
});
