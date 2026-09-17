// The link chip row — acceptance criterion 4.
//
// The claims worth pinning are that the chip shows ONLY the key, that the
// URL is still reachable as the href, and that the anchor carries the
// attributes that make opening an untrusted destination safe. Called as a
// plain function against the element tree — no DOM, per
// `tests/helpers/react-element.ts`.
import { describe, expect, it } from "vitest";
import { LinkChips } from "@/components/chips/LinkChips";
import { findAllByType, walk } from "./helpers/react-element";

const links = [
  { key: "slack", url: "https://chat.example.test/archives/C1/p1" },
  { key: "ticket", url: "https://tracker.example.test/browse/T-1" },
];

function anchors(node: ReturnType<typeof LinkChips>) {
  return findAllByType(node, "a");
}

describe("LinkChips", () => {
  it("renders one anchor per link", () => {
    expect(anchors(LinkChips({ links }))).toHaveLength(2);
  });

  // The headline requirement: `[slack](url)`, never `slack: https://…`.
  // Would pass wrongly if the child became `${key}: ${url}` — the assertion
  // is that the URL appears in NO visible text, not merely that the key does
  // appear.
  it("shows only the key as visible text, never the url", () => {
    for (const anchor of anchors(LinkChips({ links }))) {
      const children = (anchor.props as { children?: unknown }).children;
      expect(typeof children).toBe("string");
      expect(children).not.toContain("http");
      expect(children).not.toContain("example.test");
    }
    expect(anchors(LinkChips({ links })).map((a) => (a.props as { children: string }).children)) //
      .toEqual(["slack", "ticket"]);
  });

  // The other half: hidden from view, but not lost.
  it("carries the full url as the href, so the chip navigates", () => {
    expect(anchors(LinkChips({ links })).map((a) => (a.props as { href: string }).href)).toEqual([
      links[0]!.url,
      links[1]!.url,
    ]);
  });

  // **A security assertion, not a style one.** `target="_blank"` hands the
  // opened page a `window.opener` handle back to the board, which an
  // untrusted destination can use to navigate it away — and these URLs are
  // supplied by whoever recorded them. Would pass wrongly if `rel` were
  // dropped or narrowed to only one of the two tokens.
  it("opens untrusted destinations with noopener and noreferrer", () => {
    for (const anchor of anchors(LinkChips({ links }))) {
      const props = anchor.props as { target?: string; rel?: string };
      expect(props.target).toBe("_blank");
      expect(props.rel).toContain("noopener");
      expect(props.rel).toContain("noreferrer");
    }
  });

  // A row of chips reading "slack", "ticket" gives a screen reader no way to
  // tell where any of them goes.
  it("gives each chip an accessible name naming the key and the destination", () => {
    const [first] = anchors(LinkChips({ links }));
    const label = (first!.props as { "aria-label": string })["aria-label"];
    expect(label).toContain("slack");
    expect(label).toContain(links[0]!.url);
    expect(label).toContain("new tab");
  });

  // Would pass wrongly if the empty case returned an empty container: a flex
  // row with no children still takes its gap and margin, putting unexplained
  // space under every item that carries no links — which is most of them.
  it("renders nothing at all when there are no links", () => {
    expect(LinkChips({ links: [] })).toBeNull();
  });

  // The card is a drag source and an anchor is natively draggable, so
  // without stopping propagation a press on a chip picks the card up and the
  // link never opens. Both handlers matter: `onPointerDown` is what the drag
  // library listens on, `onClick` is what an ancestor navigation would see.
  it("stops propagation on click and pointer-down when asked to", () => {
    let stopped = 0;
    const node = LinkChips({
      links,
      onChipPointerDown: (event) => event.stopPropagation(),
    });
    for (const anchor of anchors(node)) {
      const props = anchor.props as {
        onClick?: (e: { stopPropagation: () => void }) => void;
        onPointerDown?: (e: { stopPropagation: () => void }) => void;
      };
      props.onClick?.({ stopPropagation: () => stopped++ });
      props.onPointerDown?.({ stopPropagation: () => stopped++ });
    }
    expect(stopped).toBe(4);
  });

  // The item header passes no handler, and must still render a working link
  // rather than one whose clicks are swallowed.
  it("leaves the handlers unset when none is supplied", () => {
    for (const anchor of anchors(LinkChips({ links }))) {
      const props = anchor.props as { onClick?: unknown; onPointerDown?: unknown };
      expect(props.onClick).toBeUndefined();
      expect(props.onPointerDown).toBeUndefined();
    }
  });

  // Two links sharing a key, and two sharing a url, are distinct rows in the
  // database. Would pass wrongly if the React key were `link.key` or
  // `link.url` alone — React would treat the pair as one element and drop a
  // chip.
  it("gives same-key and same-url links distinct react keys", () => {
    const sameKey = [
      { key: "doc", url: "https://example.test/1" },
      { key: "doc", url: "https://example.test/2" },
    ];
    const sameUrl = [
      { key: "ticket", url: "https://example.test/x" },
      { key: "escalation", url: "https://example.test/x" },
    ];
    for (const set of [sameKey, sameUrl]) {
      const keys = [...walk(LinkChips({ links: set }))]
        .filter((el) => el.type === "a")
        .map((el) => el.key);
      expect(new Set(keys).size).toBe(2);
    }
  });
});
