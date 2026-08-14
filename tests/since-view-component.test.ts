// The "since your last visit" components — MILESTONES.md #38. Hook-free
// and prop-driven (see each component's header), so they're called directly
// as functions and their returned element trees inspected — same technique
// as `tests/board-view-component.test.ts`.
import { describe, expect, it } from "vitest";
import { SinceLastVisitView } from "@/components/since/SinceLastVisitView";
import { EventRow } from "@/components/since/EventRow";
import { emptyFeed } from "@/lib/since/view";
import type { SinceEvent, SinceFeed } from "@/lib/since/types";
import { findAllByType, walk } from "./helpers/react-element";
import type { ReactNode } from "react";

function event(overrides: Partial<SinceEvent> = {}): SinceEvent {
  return {
    id: "1",
    itemId: "item-a",
    itemTitle: "Item A",
    ts: "2026-08-14T10:00:00.000Z",
    actorType: "agent",
    actorId: "builder-one",
    type: "note",
    payload: {},
    body: null,
    seen: false,
    seenByAnyone: false,
    ...overrides,
  };
}

function feed(overrides: Partial<SinceFeed> = {}): SinceFeed {
  return { ...emptyFeed(), ...overrides };
}

/** Every string of text anywhere in the tree, flattened. */
function textOf(root: ReactNode): string {
  const parts: string[] = [];
  for (const el of walk(root)) {
    const children = (el.props as { children?: unknown }).children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

describe("SinceLastVisitView — the load branches", () => {
  it("shows the error message and nothing else when the load failed", () => {
    const tree = SinceLastVisitView({
      loadState: { status: "error", message: "the API said no" },
      personId: "user-a",
    });
    expect(textOf(tree)).toContain("the API said no");
    // No list, and no mark-all button, on an error.
    expect(findAllByType(tree, "button")).toHaveLength(0);
  });

  it("shows a loading message while the fetch is in flight", () => {
    const tree = SinceLastVisitView({ loadState: { status: "loading" }, personId: "user-a" });
    expect(textOf(tree)).toContain("Loading what's new");
  });

  it("says nothing has happened yet on a first visit with no events", () => {
    const tree = SinceLastVisitView({
      loadState: { status: "loaded", feed: feed({ firstVisit: true }) },
      personId: "user-a",
    });
    expect(textOf(tree)).toContain("Nothing has happened yet.");
  });

  it("says you are caught up when there is read state but nothing new", () => {
    const tree = SinceLastVisitView({
      loadState: { status: "loaded", feed: feed({ firstVisit: false }) },
      personId: "user-a",
    });
    expect(textOf(tree)).toContain("You're all caught up.");
  });
});

describe("SinceLastVisitView — the loaded list", () => {
  it("renders one row per event", () => {
    const tree = SinceLastVisitView({
      loadState: {
        status: "loaded",
        feed: feed({ events: [event({ id: "1" }), event({ id: "2" })], unseenCount: 2 }),
      },
      personId: "user-a",
    });
    expect(findAllByType(tree, EventRow)).toHaveLength(2);
  });

  it("groups events under the item they happened to", () => {
    const tree = SinceLastVisitView({
      loadState: {
        status: "loaded",
        feed: feed({
          events: [
            event({ id: "1", itemId: "a", itemTitle: "Item A" }),
            event({ id: "2", itemId: "a", itemTitle: "Item A" }),
            event({ id: "3", itemId: "b", itemTitle: "Item B" }),
          ],
        }),
      },
      personId: "user-a",
    });
    // Two headings, three rows — the grouping is the whole point.
    expect(findAllByType(tree, "h3")).toHaveLength(2);
    expect(findAllByType(tree, EventRow)).toHaveLength(3);
  });

  it("gives an unscoped event an honest heading rather than hiding it", () => {
    const tree = SinceLastVisitView({
      loadState: {
        status: "loaded",
        feed: feed({
          events: [event({ id: "1", itemId: null, itemTitle: null, type: "setting_change" })],
        }),
      },
      personId: "user-a",
    });
    expect(textOf(tree)).toContain("System");
    expect(findAllByType(tree, EventRow)).toHaveLength(1);
  });

  it("shows the unseen count when there is one", () => {
    const tree = SinceLastVisitView({
      loadState: { status: "loaded", feed: feed({ events: [event()], unseenCount: 4 }) },
      personId: "user-a",
    });
    expect(textOf(tree)).toContain("4");
  });

  it("shows no count badge at zero", () => {
    // A badge reading 0 occupies the spot the eye checks and answers a
    // question nobody asked — the same reasoning `NeedsYouBadge` gives.
    const tree = SinceLastVisitView({
      loadState: {
        status: "loaded",
        feed: feed({ events: [event({ seen: true })], unseenCount: 0 }),
      },
      personId: "user-a",
    });
    const counts = [...walk(tree)].filter(
      (el) =>
        typeof (el.props as { "aria-label"?: string })["aria-label"] === "string" &&
        (el.props as { "aria-label": string })["aria-label"].includes("unseen"),
    );
    expect(counts).toHaveLength(0);
  });
});

describe("SinceLastVisitView — the seen actions", () => {
  it("offers mark-all when there is something unseen and a profile to mark it for", () => {
    const tree = SinceLastVisitView({
      loadState: { status: "loaded", feed: feed({ events: [event()], unseenCount: 1 }) },
      personId: "user-a",
      onMarkAllSeen: () => {},
    });
    expect(textOf(tree)).toContain("Mark all as seen");
  });

  it("offers no mark-all when nothing is unseen", () => {
    const tree = SinceLastVisitView({
      loadState: {
        status: "loaded",
        feed: feed({ events: [event({ seen: true })], unseenCount: 0 }),
      },
      personId: "user-a",
      onMarkAllSeen: () => {},
    });
    expect(textOf(tree)).not.toContain("Mark all as seen");
  });

  it("offers no seen actions at all with no profile chosen", () => {
    // `POST /events/{id}/seen` requires a personId — there is nobody to
    // attribute the read to. The feed is still perfectly readable.
    const tree = SinceLastVisitView({
      loadState: { status: "loaded", feed: feed({ events: [event()], unseenCount: 1 }) },
      personId: null,
      onMarkSeen: () => {},
      onMarkAllSeen: () => {},
    });
    expect(textOf(tree)).not.toContain("Mark all as seen");
    // And the rows are rendered but carry no handler.
    const rows = findAllByType(tree, EventRow);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.props as { onMarkSeen?: unknown }).onMarkSeen).toBeUndefined();
  });

  it("sends only the unseen ids to mark-all", () => {
    let sent: readonly string[] | undefined;
    const tree = SinceLastVisitView({
      loadState: {
        status: "loaded",
        feed: feed({
          events: [event({ id: "1", seen: true }), event({ id: "2" }), event({ id: "3" })],
          unseenCount: 2,
        }),
      },
      personId: "user-a",
      onMarkAllSeen: (ids) => {
        sent = ids;
      },
    });
    const button = findAllByType(tree, "button")[0]!;
    (button.props as { onClick: () => void }).onClick();
    expect(sent).toEqual(["2", "3"]);
  });
});

describe("EventRow", () => {
  it("reads as a sentence: who, what, when", () => {
    const tree = EventRow({
      event: event({ actorId: "builder-one", type: "merge" }),
    });
    const text = textOf(tree);
    expect(text).toContain("builder-one");
    expect(text).toContain("merged it");
  });

  it("marks an unseen row as unseen in the DOM, so it is testable and stylable", () => {
    const seen = EventRow({ event: event({ seen: true }) });
    const unseen = EventRow({ event: event({ seen: false }) });
    expect((seen.props as { "data-seen": boolean })["data-seen"]).toBe(true);
    expect((unseen.props as { "data-seen": boolean })["data-seen"]).toBe(false);
  });

  it("offers the mark-seen button only on an unseen row", () => {
    // A button whose only possible effect is nothing should not be there.
    const unseen = EventRow({ event: event({ seen: false }), onMarkSeen: () => {} });
    const seen = EventRow({ event: event({ seen: true }), onMarkSeen: () => {} });
    expect(findAllByType(unseen, "button")).toHaveLength(1);
    expect(findAllByType(seen, "button")).toHaveLength(0);
  });

  it("offers no button when there is no handler, even on an unseen row", () => {
    expect(findAllByType(EventRow({ event: event({ seen: false }) }), "button")).toHaveLength(0);
  });

  it("passes the event's own id to the handler", () => {
    let got: string | undefined;
    const tree = EventRow({ event: event({ id: "77" }), onMarkSeen: (id) => (got = id) });
    const button = findAllByType(tree, "button")[0]!;
    (button.props as { onClick: () => void }).onClick();
    expect(got).toBe("77");
  });

  it("says when someone else has seen it, but only if you have not", () => {
    const otherSaw = EventRow({ event: event({ seen: false, seenByAnyone: true }) });
    expect(textOf(otherSaw)).toContain("seen by someone else");
    // Beside your own seen row it would be noise.
    const youSaw = EventRow({ event: event({ seen: true, seenByAnyone: true }) });
    expect(textOf(youSaw)).not.toContain("seen by someone else");
  });

  it("shows an event body when there is one", () => {
    expect(textOf(EventRow({ event: event({ body: "the note text" }) }))).toContain(
      "the note text",
    );
  });

  it("falls back to the raw timestamp rather than rendering Invalid Date", () => {
    const tree = EventRow({ event: event({ ts: "not-a-date" }) });
    expect(textOf(tree)).toContain("not-a-date");
    expect(textOf(tree)).not.toContain("Invalid Date");
  });
});
