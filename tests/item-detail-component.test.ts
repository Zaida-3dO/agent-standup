// The item-detail components — MILESTONES.md #72. Hook-free and
// prop-driven (see each component's header), so they're called directly as
// functions and their returned element trees inspected — same technique as
// `tests/board-view-component.test.ts`.
import { describe, expect, it } from "vitest";
import { ItemDetailView } from "@/components/item-detail/ItemDetailView";
import { SubtaskTree } from "@/components/item-detail/SubtaskTree";
import { ArtifactList } from "@/components/item-detail/ArtifactList";
import { HistoryList } from "@/components/item-detail/HistoryList";
import { SummaryPanel } from "@/components/item-detail/SummaryPanel";
import type {
  DetailArtifact,
  DetailHistoryEntry,
  DetailSubtask,
  DetailSummary,
  ItemDetail,
} from "@/lib/item-detail/types";
import { findAllByType, walk } from "./helpers/react-element";
import type { ReactNode } from "react";

/** Every string of text anywhere in the tree, flattened — handles arrays of children. */
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

/** Every element in the tree carrying the given prop, whatever its type. */
function elementsWithProp(root: ReactNode, prop: string) {
  return [...walk(root)].filter((el) => (el.props as Record<string, unknown>)[prop] !== undefined);
}

function detailItem(overrides: Partial<ItemDetail["item"]> = {}): ItemDetail["item"] {
  return {
    id: "item-1",
    parentId: null,
    title: "An item",
    body: "",
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: "web",
    branch: null,
    blockedReason: null,
    pauseReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
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

  it("renders all four sections once loaded", () => {
    const element = ItemDetailView({ loadState: { status: "loaded", detail: detail() } });
    expect(findAllByType(element, SubtaskTree).length).toBe(1);
    expect(findAllByType(element, ArtifactList).length).toBe(1);
    expect(findAllByType(element, HistoryList).length).toBe(1);
    expect(findAllByType(element, SummaryPanel).length).toBe(1);
  });

  it("shows the server's column, not one it recomputed", () => {
    // The #37 convention: the client reads what the server derived. A
    // project's column comes from a subtree walk the client cannot
    // reproduce, so this must be the value that arrived.
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail({ column: "waiting" }) },
    });
    const columns = elementsWithProp(element, "data-column");
    expect(columns.map((el) => (el.props as Record<string, unknown>)["data-column"])).toContain(
      "waiting",
    );
    expect(textOf(element)).toContain("Waiting");
  });

  it("shows a task's own state", () => {
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail({ item: detailItem({ state: "in_review" }) }) },
    });
    expect(textOf(element)).toContain("in review");
  });

  it("does NOT show a project's own state — it is a creation leftover", () => {
    // DECISIONS.md §13c. A project created `on_deck` and long since
    // finished still carries `on_deck` in its row; printing it on the
    // screen most likely to be read as authoritative is the bug.
    const element = ItemDetailView({
      loadState: {
        status: "loaded",
        detail: detail({
          item: detailItem({ kind: "project", state: "on_deck" }),
          column: "completed",
        }),
      },
    });
    const text = textOf(element);
    expect(text).not.toContain("on deck");
    expect(text).toContain("Completed");
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
            artifact({ id: "b", reviewRound: 2, verdict: "changes_requested" }),
          ],
        }),
      },
    });
    const flagged = elementsWithProp(element, "data-latest-verdict");
    expect(flagged).toHaveLength(1);
    expect((flagged[0]!.props as Record<string, unknown>)["data-latest-verdict"]).toBe(
      "changes_requested",
    );
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

describe("ArtifactList", () => {
  it("says so plainly when there are none", () => {
    expect(textOf(ArtifactList({ artifacts: [] }))).toContain("No artifacts yet");
  });

  it("groups artifacts under an ascending round heading", () => {
    const element = ArtifactList({
      artifacts: [
        artifact({ id: "b", reviewRound: 2, verdict: "lgtm" }),
        artifact({ id: "a", reviewRound: 1, verdict: "changes_requested" }),
      ],
    });
    const rounds = elementsWithProp(element, "data-round");
    expect(rounds.map((el) => (el.props as Record<string, unknown>)["data-round"])).toEqual([1, 2]);
  });

  it("shows a shortened commit sha rather than the whole thing", () => {
    const element = ArtifactList({
      artifacts: [artifact({ commitSha: "0123456789abcdef0123456789abcdef01234567" })],
    });
    const text = textOf(element);
    expect(text).toContain("0123456789");
    expect(text).not.toContain("0123456789abcdef0123456789abcdef01234567");
  });

  it("treats an unrecognised verdict as not-yet-cleared, never as a pass", () => {
    // The safe direction for a value this component has never seen: a
    // future verdict must not render as though the work were approved.
    const passing = ArtifactList({ artifacts: [artifact({ verdict: "lgtm_with_nits" })] });
    const unknown = ArtifactList({ artifacts: [artifact({ verdict: "some_future_verdict" })] });
    const classOf = (root: ReactNode) =>
      elementsWithProp(root, "data-verdict").map(
        (el) => (el.props as { className?: string }).className ?? "",
      )[0] ?? "";
    expect(classOf(passing)).not.toBe(classOf(unknown));
    expect(classOf(passing)).toContain("verdictPass");
    expect(classOf(unknown)).toContain("verdictBlocked");
  });

  it("shows no verdict chip for an artifact that has none", () => {
    const element = ArtifactList({ artifacts: [artifact({ kind: "screenshot", verdict: null })] });
    expect(elementsWithProp(element, "data-verdict")).toHaveLength(0);
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
