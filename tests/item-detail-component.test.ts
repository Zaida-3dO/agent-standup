// The item-detail components — MILESTONES.md #72. Hook-free and
// prop-driven (see each component's header), so they're called directly as
// functions and their returned element trees inspected — same technique as
// `tests/board-view-component.test.ts`.
import { describe, expect, it } from "vitest";
import { ItemDetailView } from "@/components/item-detail/ItemDetailView";
import { SubtaskTree } from "@/components/item-detail/SubtaskTree";
import { HistoryList } from "@/components/item-detail/HistoryList";
import { SummaryPanel } from "@/components/item-detail/SummaryPanel";
import { Markdown } from "@/components/item-detail/Markdown";
import { TabStrip } from "@/components/item-detail/TabStrip";
import { StatusBlock } from "@/components/item-detail/StatusBlock";
import { ChipLink } from "@/components/item-detail/ChipLink";
import { InlineEditField } from "@/components/item-detail/InlineEditField";
import { TrustBadge } from "@/components/chips/TrustBadge";
import { VerifyStateAction } from "@/components/item-detail/VerifyStateAction";
import { TABS } from "@/lib/item-detail/tabs";
import type {
  DetailArtifact,
  DetailHistoryEntry,
  DetailSubtask,
  DetailSummary,
  ItemDetail,
} from "@/lib/item-detail/types";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";
import type { ReactNode } from "react";

/**
 * Every string of text anywhere in the tree, flattened — handles arrays of
 * children, and reads a `<Markdown>`'s source.
 *
 * The `Markdown` case is load-bearing rather than a convenience. This
 * harness does not render: it walks the element tree a component RETURNED,
 * so a nested component appears as an unrendered reference and its output
 * does not exist yet. A body handed to `<Markdown source={…} />` therefore
 * sits in a prop, not in children, and a `textOf` that only read children
 * would report every rendered body as absent — turning "the text is on the
 * screen" into an assertion that quietly stopped checking anything the
 * moment the body became markdown.
 */
function textOf(root: ReactNode): string {
  const parts: string[] = [];
  for (const el of walk(root)) {
    if (el.type === Markdown) {
      const source = (el.props as { source?: unknown }).source;
      if (typeof source === "string") parts.push(source);
    }
    const children = (el.props as { children?: unknown }).children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

/** Every element in the tree carrying the given prop, whatever its type. */
function elementsWithProp(root: ReactNode, prop: string) {
  return [...walk(root)].filter((el) => (el.props as Record<string, unknown>)[prop] !== undefined);
}

function detailItem(overrides: Partial<ItemDetail["item"]> = {}): ItemDetail["item"] {
  return {
    id: "item-1",
    parentId: null,
    title: "An item",
    headline: null,
    body: "",
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: "web",
    branch: null,
    blockedReason: null,
    blockedOnType: null,
    blockedOnPersonId: null,
    unblockAt: null,
    pauseReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    originType: "person",
    ...overrides,
  };
}

function detail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    item: detailItem(),
    column: "in_progress",
    subtasks: [],
    artifacts: [],
    history: [],
    historyTruncated: false,
    summary: null,
    assignments: [],
    previousHolders: [],
    ...overrides,
  };
}

function subtask(overrides: Partial<DetailSubtask> = {}): DetailSubtask {
  return {
    id: "sub-1",
    parentId: "item-1",
    title: "A subtask",
    kind: "task",
    state: "executing",
    priority: "P2",
    depth: 1,
    column: "in_progress",
    ...overrides,
  };
}

function artifact(overrides: Partial<DetailArtifact> = {}): DetailArtifact {
  return {
    id: "art-1",
    kind: "code_review",
    verdict: "lgtm",
    reviewRound: 1,
    commitSha: null,
    ref: null,
    body: null,
    findings: null,
    followUpItemId: null,
    createdByType: "agent",
    createdById: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function historyEntry(overrides: Partial<DetailHistoryEntry> = {}): DetailHistoryEntry {
  return {
    id: "1",
    ts: "2026-03-04T05:06:07.000Z",
    type: "state_change",
    actorType: "agent",
    actorId: null,
    sessionId: null,
    body: null,
    payload: null,
    headline: null,
    ...overrides,
  };
}

function summary(overrides: Partial<DetailSummary> = {}): DetailSummary {
  return {
    shipped: ["a thing"],
    notDone: [],
    userFacing: true,
    whatToTest: null,
    howVerified: null,
    watchFor: [],
    finalState: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ItemDetailView", () => {
  it("shows the error message and no sections when the load failed", () => {
    const element = ItemDetailView({
      loadState: { status: "error", message: "No such item: missing." },
    });
    expect(textOf(element)).toContain("No such item: missing.");
    expect(findAllByType(element, SubtaskTree).length).toBe(0);
  });

  it("shows a loading state before the detail arrives", () => {
    const element = ItemDetailView({ loadState: { status: "loading" } });
    expect(textOf(element)).toContain("Loading this item");
    expect(findAllByType(element, SubtaskTree).length).toBe(0);
  });

  it("renders ONLY the active tab's section, not all of them at once", () => {
    // The point of the tabs: one section occupies the page at a time. If
    // every section rendered and the inactive ones were merely hidden, the
    // page would still pay for the whole history and the whole subtree on
    // every visit — which is the cost the tabs exist to remove.
    const loadState = { status: "loaded", detail: detail() } as const;

    const subtasks = ItemDetailView({ loadState, activeTab: "subtasks" });
    expect(findAllByType(subtasks, SubtaskTree).length).toBe(1);
    expect(findAllByType(subtasks, HistoryList).length).toBe(0);

    const activity = ItemDetailView({ loadState, activeTab: "activity" });
    expect(findAllByType(activity, HistoryList).length).toBe(1);
    expect(findAllByType(activity, SubtaskTree).length).toBe(0);
  });

  it("shows Overview when no tab is asked for", () => {
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail({ item: detailItem({ body: "the brief" }) }) },
    });
    expect(textOf(element)).toContain("the brief");
    expect(findAllByType(element, SubtaskTree).length).toBe(0);
  });

  it("renders every tab without throwing, so no tab is a dead end", () => {
    // A tab that renders nothing is indistinguishable from a broken one,
    // and these are filled by separate pieces of work — this is what keeps
    // the page whole while that happens.
    const loadState = { status: "loaded", detail: detail() } as const;
    for (const tab of TABS) {
      const element = ItemDetailView({ loadState, activeTab: tab });
      expect(findAllByType(element, TabStrip).length).toBe(1);
      const panels = elementsWithProp(element, "data-panel");
      expect(panels.map((el) => (el.props as Record<string, unknown>)["data-panel"])).toEqual([
        tab,
      ]);
      expect(textOf(element).trim()).not.toBe("");
    }
  });

  it("renders the item body as markdown rather than as text", () => {
    // Row #120's complaint: a brief's `##` and pipe tables were reaching
    // the screen as literal characters.
    const body = ["## Heading", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail({ item: detailItem({ body }) }) },
    });
    const rendered = findAllByType(element, Markdown);
    expect(rendered).toHaveLength(1);
    expect((rendered[0]!.props as Record<string, unknown>).source).toBe(body);
  });

  it("hands the status block the server's column, not one it recomputed", () => {
    // The #37 convention: the client reads what the server derived. A
    // project's column comes from a subtree walk the client cannot
    // reproduce, so this must be the value that arrived.
    //
    // Asserted on the prop the view passes down rather than on flattened
    // text, because `StatusBlock` is an unrendered component reference in
    // this harness — `walk` stops at it, and the column's human title is
    // produced inside a render this test deliberately does not perform.
    // `tests/item-detail-status-block.test.ts` calls the block itself and
    // asserts the title actually reaches the screen.
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail({ column: "waiting" }) },
    });
    const block = findOneByType(element, StatusBlock);
    expect((block.props as Record<string, unknown>).column).toBe("waiting");
  });

  it("hands the status block the item, so a task's own state can be shown", () => {
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail({ item: detailItem({ state: "in_review" }) }) },
    });
    const block = findOneByType(element, StatusBlock);
    expect((block.props as { item: { state: string } }).item.state).toBe("in_review");
  });

  it("does NOT print a project's own state in the header — it is a creation leftover", () => {
    // DECISIONS.md §13c. A project created `on_deck` and long since
    // finished still carries `on_deck` in its row; printing it on the
    // screen most likely to be read as authoritative is the bug. The
    // block's own suppression is asserted where the block is rendered.
    const element = ItemDetailView({
      loadState: {
        status: "loaded",
        detail: detail({
          item: detailItem({ kind: "project", state: "on_deck" }),
          column: "completed",
        }),
      },
    });
    expect(textOf(element)).not.toContain("on deck");
  });

  it("shows the blocked reason for a blocked item", () => {
    const element = ItemDetailView({
      loadState: {
        status: "loaded",
        detail: detail({
          item: detailItem({ state: "blocked", blockedReason: "needs a decision" }),
        }),
      },
    });
    expect(textOf(element)).toContain("needs a decision");
  });

  it("surfaces the latest verdict in the header", () => {
    const element = ItemDetailView({
      loadState: {
        status: "loaded",
        detail: detail({
          artifacts: [
            artifact({ id: "a", reviewRound: 1, verdict: "lgtm" }),
            artifact({ id: "b", reviewRound: 2, verdict: "changes_required" }),
          ],
        }),
      },
    });
    const flagged = elementsWithProp(element, "data-latest-verdict");
    expect(flagged).toHaveLength(1);
    expect((flagged[0]!.props as Record<string, unknown>)["data-latest-verdict"]).toBe(
      "changes_required",
    );
  });

  describe("chip links back to a filtered board (M10 T10)", () => {
    it("links the header's area and repo chips", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({ item: detailItem({ area: "billing", repo: "api" }) }),
        },
      });
      const hrefs = findAllByType(element, ChipLink)
        .map((el) => (el.props as { href?: string }).href)
        .filter((h): h is string => typeof h === "string");
      expect(hrefs).toContain("/board?area=billing");
      expect(hrefs).toContain("/board?repo=api");
    });

    it("does not link a repo the item has none of", () => {
      const element = ItemDetailView({
        loadState: { status: "loaded", detail: detail({ item: detailItem({ repo: null }) }) },
      });
      const hrefs = findAllByType(element, ChipLink)
        .map((el) => (el.props as { href?: string }).href)
        .filter((h): h is string => typeof h === "string");
      expect(hrefs.some((h) => h.startsWith("/board?repo="))).toBe(false);
    });
  });

  describe("inline edit on title and headline (M10 T10)", () => {
    it("shows the title as plain text, with an Edit control, when not editing", () => {
      const element = ItemDetailView({
        loadState: { status: "loaded", detail: detail({ item: detailItem({ title: "A title" }) }) },
        edit: { onStartEdit: () => {} },
      });
      expect(textOf(element)).toContain("A title");
      const buttons = [...walk(element)].filter((el) => el.type === "button");
      const labels = buttons.map((b) => (b.props as { "aria-label"?: string })["aria-label"]);
      expect(labels).toContain("Edit title");
    });

    it("hands InlineEditField the title's own draft while title is the editing field", () => {
      const element = ItemDetailView({
        loadState: { status: "loaded", detail: detail() },
        edit: { editingField: "title", draft: "New title" },
      });
      const fields = findAllByType(element, InlineEditField);
      const titleField = fields.find((f) => (f.props as { label?: string }).label === "Title");
      expect(titleField).toBeDefined();
      expect((titleField!.props as { editing?: boolean }).editing).toBe(true);
      expect((titleField!.props as { draft?: string }).draft).toBe("New title");
    });

    it("passes live title advice through to InlineEditField while editing the title", () => {
      // MILESTONES.md #131's convention advises, never refuses — this is
      // the plumbing that gets the advisory text in front of the reader
      // while they are still typing, not only after a failed save.
      const element = ItemDetailView({
        loadState: { status: "loaded", detail: detail() },
        edit: { editingField: "title", draft: "fix #102", titleAdvice: "A note on the title" },
      });
      const fields = findAllByType(element, InlineEditField);
      const titleField = fields.find((f) => (f.props as { label?: string }).label === "Title");
      expect((titleField!.props as { advice?: string }).advice).toBe("A note on the title");
    });

    it("offers headline edit even when the item has none yet", () => {
      const element = ItemDetailView({
        loadState: { status: "loaded", detail: detail({ item: detailItem({ headline: null }) }) },
        edit: { onStartEdit: () => {} },
      });
      const fields = findAllByType(element, InlineEditField);
      const headlineField = fields.find(
        (f) => (f.props as { label?: string }).label === "Headline",
      );
      expect(headlineField).toBeDefined();
      expect((headlineField!.props as { value?: string | null }).value).toBeNull();
    });

    it("does not editorialise which field is mid-edit onto both title and headline at once", () => {
      const element = ItemDetailView({
        loadState: { status: "loaded", detail: detail() },
        edit: { editingField: "title", draft: "x" },
      });
      const fields = findAllByType(element, InlineEditField);
      const editingFields = fields.filter((f) => (f.props as { editing?: boolean }).editing);
      expect(editingFields).toHaveLength(1);
    });
  });

  describe("the Activity tab's filter and page state (M10 T10)", () => {
    it("passes the type filter and page through to HistoryList", () => {
      const element = ItemDetailView({
        loadState: { status: "loaded", detail: detail() },
        activeTab: "activity",
        historyTypeFilter: "escalation",
        historyPage: 2,
      });
      const lists = findAllByType(element, HistoryList);
      expect(lists).toHaveLength(1);
      expect((lists[0]!.props as { typeFilter?: string | null }).typeFilter).toBe("escalation");
      expect((lists[0]!.props as { page?: number }).page).toBe(2);
    });
  });

  it("hands StatusBlock the edit props, so priority/area edit reaches the block that renders them", () => {
    const onStartEdit = () => {};
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail() },
      edit: { onStartEdit },
    });
    const block = findOneByType(element, StatusBlock);
    expect((block.props as { edit?: { onStartEdit?: unknown } }).edit?.onStartEdit).toBe(
      onStartEdit,
    );
  });

  // MILESTONES.md #131 — the header leads with headline, never rewriting title.
  describe("titles a person can read", () => {
    it("shows the headline in the header when one is written", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({
            item: detailItem({
              title: "agent-standup #102 - route the four raw event writes",
              headline: "Route event writes through appendEvent",
            }),
          }),
        },
      });
      expect(textOf(element)).toContain("Route event writes through appendEvent");
    });

    // Fails if the demoted source title is dropped entirely instead of shown, smaller.
    it("still shows the source title, demoted, once a headline stands in for it", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({
            item: detailItem({
              title: "agent-standup #102 - route the four raw event writes",
              headline: "Route event writes through appendEvent",
            }),
          }),
        },
      });
      expect(textOf(element)).toContain("agent-standup #102 - route the four raw event writes");
    });

    it("falls back to the title when there is no headline", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({ item: detailItem({ title: "Ship the board", headline: null }) }),
        },
      });
      const text = textOf(element);
      expect(text).toContain("Ship the board");
      // Not doubled: with no headline, `title` is the primary line and is
      // never ALSO rendered as the demoted secondary line.
      expect(text.match(/Ship the board/g)).toHaveLength(1);
    });
  });

  // MILESTONES.md #131 — the trust marker and the confirm-state action.
  describe("trust marker", () => {
    it("shows no trust badge for a verified (person-originated) item", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({ item: detailItem({ originType: "person" }) }),
        },
      });
      expect(findAllByType(element, TrustBadge)).toHaveLength(0);
    });

    it("shows the trust badge for an imported (source-originated) item", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({ item: detailItem({ originType: "source" }) }),
        },
      });
      const badge = findOneByType(element, TrustBadge);
      expect((badge.props as { verified: boolean }).verified).toBe(false);
    });

    it("reports verified once a historical_verification artifact is on file", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({
            item: detailItem({ originType: "source" }),
            artifacts: [
              artifact({
                kind: "historical_verification",
                commitSha: "abc123",
                body: "Checked.",
                createdByType: "agent",
              }),
            ],
          }),
        },
      });
      const badge = findOneByType(element, TrustBadge);
      expect((badge.props as { verified: boolean }).verified).toBe(true);
    });

    it("hides the confirm-state action entirely when no handler is wired", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({ item: detailItem({ originType: "source" }) }),
        },
      });
      expect(findAllByType(element, VerifyStateAction)).toHaveLength(0);
    });

    it("offers the confirm-state action once a handler is wired, disabled with a reason with no commit", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({ item: detailItem({ originType: "source" }) }),
        },
        onVerifyState: () => {},
      });
      const action = findOneByType(element, VerifyStateAction);
      expect((action.props as { tipCommitSha: string | null }).tipCommitSha).toBeNull();
    });

    it("passes the tip commit through once the item has one", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({
            item: detailItem({ originType: "source" }),
            artifacts: [artifact({ kind: "commit", commitSha: "abc123" })],
          }),
        },
        onVerifyState: () => {},
      });
      const action = findOneByType(element, VerifyStateAction);
      expect((action.props as { tipCommitSha: string | null }).tipCommitSha).toBe("abc123");
    });

    it("never offers the confirm-state action on a verified item", () => {
      const element = ItemDetailView({
        loadState: {
          status: "loaded",
          detail: detail({ item: detailItem({ originType: "person" }) }),
        },
        onVerifyState: () => {},
      });
      expect(findAllByType(element, VerifyStateAction)).toHaveLength(0);
    });
  });
});

describe("SubtaskTree", () => {
  it("says so plainly when there are no subtasks", () => {
    expect(textOf(SubtaskTree({ subtasks: [] }))).toContain("No subtasks");
  });

  it("renders one node per subtask, in the order given", () => {
    const element = SubtaskTree({
      subtasks: [subtask({ id: "a", title: "First" }), subtask({ id: "b", title: "Second" })],
    });
    const nodes = elementsWithProp(element, "data-depth");
    expect(nodes).toHaveLength(2);
    const text = textOf(element);
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
  });

  it("indents by the server's depth rather than by nesting elements", () => {
    const element = SubtaskTree({
      subtasks: [subtask({ id: "a", depth: 1 }), subtask({ id: "b", depth: 3 })],
    });
    const nodes = elementsWithProp(element, "data-depth");
    const padding = nodes.map(
      (el) => ((el.props as { style?: { paddingLeft?: string } }).style ?? {}).paddingLeft,
    );
    expect(padding).toEqual(["0.5rem", "3rem"]);
  });

  it("shows a subtask's state but shows a nested project's kind instead", () => {
    const element = SubtaskTree({
      subtasks: [
        subtask({ id: "a", state: "plan_review" }),
        subtask({ id: "p", kind: "project", state: "on_deck", column: null }),
      ],
    });
    const text = textOf(element);
    expect(text).toContain("plan review");
    expect(text).not.toContain("on deck");
    expect(text).toContain("project");
  });

  it("counts progress excluding projects", () => {
    const element = SubtaskTree({
      subtasks: [
        subtask({ id: "a", state: "merged" }),
        subtask({ id: "b", state: "executing" }),
        subtask({ id: "p", kind: "project", state: "on_deck", column: null }),
      ],
    });
    // Asserted on the attribute rather than the rendered text: `textOf`
    // joins adjacent JSX text fragments with a space, so "1 of 2 done"
    // arrives as "1  of  2  done" and a text assertion would be testing
    // the helper's whitespace rather than the count.
    const flagged = elementsWithProp(element, "data-progress");
    expect((flagged[0]!.props as Record<string, unknown>)["data-progress"]).toBe("1/2");
  });

  it("shows no progress line when there is nothing countable", () => {
    const element = SubtaskTree({
      subtasks: [subtask({ id: "p", kind: "project", state: "on_deck", column: null })],
    });
    expect(textOf(element)).not.toContain("done");
  });
});

describe("HistoryList", () => {
  it("says so plainly when nothing is recorded", () => {
    expect(textOf(HistoryList({ history: [], truncated: false }))).toContain("Nothing recorded");
  });

  it("renders one row per entry with a stable, locale-free timestamp", () => {
    // A locale format renders differently on the server and the client,
    // which React reports as a hydration mismatch.
    const element = HistoryList({ history: [historyEntry()], truncated: false });
    expect(textOf(element)).toContain("2026-03-04 05:06:07");
  });

  it("says outright that older entries are hidden when the ledger was capped", () => {
    // A list that silently stops at its cap reads as the whole history —
    // the one thing a history view must not imply falsely.
    const element = HistoryList({ history: [historyEntry()], truncated: true });
    expect(textOf(element)).toContain("Older entries are not shown");
  });

  it("does not claim truncation when the whole ledger was returned", () => {
    const element = HistoryList({ history: [historyEntry()], truncated: false });
    expect(textOf(element)).not.toContain("Older entries are not shown");
  });

  it("groups entries by day, day headings newest first", () => {
    const element = HistoryList({
      history: [
        historyEntry({ id: "3", ts: "2026-03-05T01:00:00.000Z" }),
        historyEntry({ id: "2", ts: "2026-03-04T23:00:00.000Z" }),
        historyEntry({ id: "1", ts: "2026-03-04T01:00:00.000Z" }),
      ],
      truncated: false,
    });
    const days = elementsWithProp(element, "data-day").map(
      (el) => (el.props as Record<string, unknown>)["data-day"],
    );
    expect(days).toEqual(["2026-03-05", "2026-03-04"]);
  });

  it("shows a filter chip for every type present, and only those types", () => {
    const element = HistoryList({
      history: [historyEntry({ type: "note" }), historyEntry({ id: "2", type: "escalation" })],
      truncated: false,
    });
    const chips = elementsWithProp(element, "data-event-type").map(
      (el) => (el.props as Record<string, unknown>)["data-event-type"],
    );
    expect(chips.sort()).toEqual(["escalation", "note"]);
  });

  it("narrows the rows shown to the active type filter", () => {
    const history = [
      historyEntry({ id: "1", type: "note" }),
      historyEntry({ id: "2", type: "escalation" }),
    ];
    const element = HistoryList({ history, truncated: false, typeFilter: "escalation" });
    expect(elementsWithProp(element, "data-holder-id")).toHaveLength(0);
    const rows = [...walk(element)].filter(
      (el) => (el.props as Record<string, unknown>)["data-type"] !== undefined,
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.props as Record<string, unknown>)["data-type"]).toBe("escalation");
  });

  it("says plainly when the active filter matches nothing", () => {
    const element = HistoryList({
      history: [historyEntry({ type: "note" })],
      truncated: false,
      typeFilter: "escalation",
    });
    expect(textOf(element)).toContain("No events of this type");
  });

  it("shows a pager even at exactly one page", () => {
    // `textOf` joins each child with a space, so "Page {n} of {count}"
    // arrives as separate tokens ("Page", 1, "of", 1) rather than one
    // string — asserted as the tokens actually present, not the sentence
    // they compose visually.
    const text = textOf(HistoryList({ history: [historyEntry()], truncated: false }));
    expect(text).toContain("Page");
    expect(text).toContain("of");
    // Both the page number and the count render as "1" at a single page.
    expect((text.match(/\b1\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("pages a long list HISTORY_PAGE_SIZE at a time", () => {
    const history = Array.from({ length: 30 }, (_, i) =>
      historyEntry({ id: String(i), ts: `2026-03-0${1 + Math.floor(i / 10)}T00:00:00.000Z` }),
    );
    const pageZero = HistoryList({ history, truncated: false, page: 0 });
    const pagerZero = elementsWithProp(pageZero, "data-page-count");
    expect((pagerZero[0]!.props as Record<string, unknown>)["data-page-count"]).toBe(2);
    expect((pagerZero[0]!.props as Record<string, unknown>)["data-page"]).toBe(0);

    const pageOne = HistoryList({ history, truncated: false, page: 1 });
    const pagerOne = elementsWithProp(pageOne, "data-page-count");
    expect((pagerOne[0]!.props as Record<string, unknown>)["data-page"]).toBe(1);

    // Exactly HISTORY_PAGE_SIZE rows shown on the first page, the
    // remainder on the second — the "not unbounded" acceptance criterion.
    const shownZero = elementsWithProp(pageZero, "data-shown-count");
    expect((shownZero[0]!.props as Record<string, unknown>)["data-shown-count"]).toBe(25);
    const shownOne = elementsWithProp(pageOne, "data-shown-count");
    expect((shownOne[0]!.props as Record<string, unknown>)["data-shown-count"]).toBe(5);
  });

  it("renders the pager's Previous/Next as calling onPageChange with the adjacent page", () => {
    const history = Array.from({ length: 30 }, (_, i) => historyEntry({ id: String(i) }));
    const calls: number[] = [];
    const element = HistoryList({
      history,
      truncated: false,
      page: 0,
      onPageChange: (page) => calls.push(page),
    });
    const buttons = [...walk(element)].filter((el) => el.type === "button");
    const next = buttons.find((b) => textOf(b) === "Next")!;
    (next.props as { onClick?: () => void }).onClick?.();
    expect(calls).toEqual([1]);
  });
});

describe("SummaryPanel", () => {
  it("renders nothing at all when the item has no summary", () => {
    expect(SummaryPanel({ summary: null })).toBeNull();
  });

  it("lists the shipped entries", () => {
    const element = SummaryPanel({ summary: summary({ shipped: ["the first", "the second"] }) });
    const text = textOf(element);
    expect(text).toContain("the first");
    expect(text).toContain("the second");
  });

  it("omits a group that is empty rather than heading an empty list", () => {
    const element = SummaryPanel({ summary: summary({ notDone: [] }) });
    expect(textOf(element)).not.toContain("Not done");
  });

  it("shows how_verified, which is what stands in for a screen nobody can see", () => {
    const element = SummaryPanel({
      summary: summary({ userFacing: false, howVerified: "unit tests over the guard" }),
    });
    const text = textOf(element);
    expect(text).toContain("Not user-facing");
    expect(text).toContain("unit tests over the guard");
  });

  it("renders a not_done entry by its text field", () => {
    const element = SummaryPanel({
      summary: summary({ notDone: [{ text: "the follow-up", reason: "out of scope" }] }),
    });
    expect(textOf(element)).toContain("the follow-up");
  });
});
