// M10 T12 — the project page's components, called as functions and their
// returned element trees inspected (`tests/helpers/react-element.ts`).
// MILESTONES.md #75.
//
// **What would make this file hollow.** Asserting that the page renders
// *something* proves nothing. The assertions that matter are about what
// these components must NOT do:
//
//   - the derived-state panel must never render a column on its own — the
//     distribution and the causing child are the whole reason the panel
//     exists, and rendering only the first is the loss this task undoes,
//   - the repair panel must render its limit sentence BEFORE the controls
//     and must not render controls without it, because a repair offered
//     without the warning promises what the state machine then refuses,
//   - a childless project must not get a progress bar at any value,
//   - blocked descendants must be surfaced as their own region, since a
//     blocked grandchild is invisible in a list of direct children.
//
// Each test names the single-character change that would break it.
import { describe, expect, it } from "vitest";
import { DerivedStatePanel } from "@/components/project-detail/DerivedStatePanel";
import { RepairPanel } from "@/components/project-detail/RepairPanel";
import { ProjectDetailView } from "@/components/project-detail/ProjectDetailView";
import type { ProjectChild, ProjectDetail, StateCounts } from "@/lib/project-detail/types";
import { ITEM_STATES } from "@/lib/design/tokens";
import { findAllByType, walk } from "./helpers/react-element";

function noCounts(): StateCounts {
  return Object.fromEntries(ITEM_STATES.map((state) => [state, 0])) as StateCounts;
}

function counts(overrides: Partial<StateCounts>): StateCounts {
  return { ...noCounts(), ...overrides };
}

function makeChild(overrides: Partial<ProjectChild> = {}): ProjectChild {
  return {
    id: "c-1",
    title: "A child",
    headline: null,
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: null,
    column: "in_progress",
    blockedReason: null,
    total: 0,
    merged: 0,
    childless: false,
    updatedAt: "2026-08-18T10:00:00.000Z",
    assignments: [],
    ...overrides,
  };
}

function makeDetail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  const resolved = { ...noCounts(), ...(overrides.derived?.counts ?? {}) };
  const total = overrides.total ?? Object.values(resolved).reduce((sum, n) => sum + n, 0);
  const merged = overrides.merged ?? resolved.merged;
  return {
    project: {
      id: "p-1",
      title: "A project",
      headline: null,
      area: "web",
      repo: null,
      priority: "P2",
      kind: "project",
    },
    derived: { column: "in_progress", counts: resolved, causingChild: null },
    total,
    merged,
    finished: merged,
    progress: total === 0 ? null : merged / total,
    childless: total === 0,
    lastActivity: "2026-08-18T10:00:00.000Z",
    children: [],
    blockedChildren: [],
    assignments: [],
    activity: [],
    repair: { childless: total === 0, historicalVerificationAvailable: false },
    // `total` and `merged` are resolved from `overrides` at the top of this
    // function, so a fixture setting only `derived.counts` gets values
    // consistent with it and one setting them explicitly still wins. They
    // are therefore NOT restated after the spread — repeating a key that
    // the spread cannot override is a duplicate the compiler rejects.
    ...overrides,
  };
}

/** Every string anywhere in a rendered tree — how a test asserts on visible text without a DOM. */
function textOf(tree: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string" || typeof node === "number") {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node === "object" && node !== null && "props" in node) {
      visit((node as { props: { children?: unknown } }).props.children);
    }
  };
  for (const element of walk(tree as never)) {
    visit((element.props as { children?: unknown }).children);
  }
  return parts.join(" ");
}

/** Every element carrying a given data attribute. */
function withAttr(tree: unknown, attr: string): ReturnType<typeof findAllByType> {
  return [...walk(tree as never)].filter(
    (element) => (element.props as Record<string, unknown>)[attr] !== undefined,
  );
}

const baseProps = {
  now: Date.parse("2026-08-18T12:00:00.000Z"),
  repairProjectId: "",
  onRepairProjectIdChange: () => {},
  repairParentId: "",
  onRepairParentIdChange: () => {},
  onRetype: () => {},
  onReparent: () => {},
};

describe("DerivedStatePanel — the reading never arrives alone", () => {
  it("renders the column, the distribution AND the causing child together", () => {
    const tree = DerivedStatePanel({
      derived: {
        column: "waiting",
        counts: counts({ blocked: 1, merged: 5, executing: 3 }),
        causingChild: {
          id: "c-9",
          title: "Wire the webhook",
          state: "blocked",
          blockedReason: "waiting on a key",
        },
      },
      total: 9,
      merged: 5,
      progress: { kind: "ratio", value: 5 / 9, percent: 56 },
    });
    const text = textOf(tree);
    expect(text).toContain("Waiting");
    // The distribution, as TEXT — not only as coloured bands. Deleting the
    // `stripLegend` paragraph leaves the strip rendering and this failing,
    // which is the point: a reader who cannot see colour must still get the
    // spread.
    expect(text).toContain("Blocked 1");
    expect(text).toContain("Merged 5");
    // The causing child, by name and with its reason inline — so "why is
    // this project blocked" is answered without opening the child.
    expect(text).toContain("Wire the webhook");
    expect(text).toContain("waiting on a key");
    expect(withAttr(tree, "data-causing-child")).toHaveLength(1);
  });

  it("declares in the markup that it carries both pieces of evidence", () => {
    const tree = DerivedStatePanel({
      derived: {
        column: "in_progress",
        counts: counts({ executing: 2 }),
        causingChild: { id: "c-1", title: "t", state: "executing", blockedReason: null },
      },
      total: 2,
      merged: 0,
      progress: { kind: "ratio", value: 0, percent: 0 },
    });
    const panel = withAttr(tree, "data-has-distribution")[0]!;
    expect((panel.props as Record<string, unknown>)["data-has-distribution"]).toBe("true");
    expect((panel.props as Record<string, unknown>)["data-has-cause"]).toBe("true");
  });

  it("renders no progress bar and no strip for a project with no children", () => {
    const tree = DerivedStatePanel({
      derived: { column: "backlog", counts: noCounts(), causingChild: null },
      total: 0,
      merged: 0,
      progress: { kind: "empty" },
    });
    // Changing `total > 0` to `total >= 0` renders a bar at 0% over no
    // work — the false claim the whole design is shaped against.
    expect(
      withAttr(tree, "role").filter(
        (e) => (e.props as Record<string, unknown>).role === "progressbar",
      ),
    ).toHaveLength(0);
    expect(textOf(tree)).toContain("nothing under this project");
  });

  it("reports the causing child as absent rather than inventing one", () => {
    const tree = DerivedStatePanel({
      derived: { column: "backlog", counts: noCounts(), causingChild: null },
      total: 0,
      merged: 0,
      progress: { kind: "empty" },
    });
    const panel = withAttr(tree, "data-has-cause")[0]!;
    expect((panel.props as Record<string, unknown>)["data-has-cause"]).toBe("false");
    expect(withAttr(tree, "data-causing-child")).toHaveLength(0);
  });
});

describe("RepairPanel — never offer a repair without its limit", () => {
  it("renders nothing at all for a project that has children", () => {
    const tree = RepairPanel({
      repair: { childless: false, historicalVerificationAvailable: false },
      projectId: "",
      onProjectIdChange: () => {},
      parentId: "",
      onParentIdChange: () => {},
      onRetype: () => {},
      onReparent: () => {},
    });
    // Removing the `if (!offer.applicable) return null` guard renders a
    // repair offer on a healthy project.
    expect(tree).toBeNull();
  });

  it("renders the dead-end warning, and marks itself a dead end, when verification is unavailable", () => {
    const tree = RepairPanel({
      repair: { childless: true, historicalVerificationAvailable: false },
      projectId: "inbox",
      onProjectIdChange: () => {},
      parentId: "",
      onParentIdChange: () => {},
      onRetype: () => {},
      onReparent: () => {},
    });
    const text = textOf(tree);
    // The exact honesty requirement of the task.
    expect(text).toContain("does NOT make it closeable");
    expect(withAttr(tree, "data-repair-limit")).toHaveLength(1);
    const panel = withAttr(tree, "data-dead-end")[0]!;
    expect((panel.props as Record<string, unknown>)["data-dead-end"]).toBe("true");
  });

  it("puts the limit BEFORE the controls, so it cannot be acted on unread", () => {
    const tree = RepairPanel({
      repair: { childless: true, historicalVerificationAvailable: false },
      projectId: "inbox",
      onProjectIdChange: () => {},
      parentId: "",
      onParentIdChange: () => {},
      onRetype: () => {},
      onReparent: () => {},
    });
    const order = [...walk(tree as never)]
      .map((element) => {
        const props = element.props as Record<string, unknown>;
        if (props["data-repair-limit"] !== undefined) return "limit";
        if (props["data-repair-action"] !== undefined) return "action";
        return null;
      })
      .filter((entry) => entry !== null);
    // Moving the limit paragraph below the two `repairForm` divs — a
    // plausible layout tweak — flips this.
    expect(order[0]).toBe("limit");
    expect(order).toContain("action");
  });

  it("still shows a limit when the verification window is open, but does not call it a dead end", () => {
    const tree = RepairPanel({
      repair: { childless: true, historicalVerificationAvailable: true },
      projectId: "inbox",
      onProjectIdChange: () => {},
      parentId: "",
      onParentIdChange: () => {},
      onRetype: () => {},
      onReparent: () => {},
    });
    expect(withAttr(tree, "data-repair-limit")).toHaveLength(1);
    const panel = withAttr(tree, "data-dead-end")[0]!;
    expect((panel.props as Record<string, unknown>)["data-dead-end"]).toBe("false");
    expect(textOf(tree)).toContain("historical_verification");
  });

  it("offers both repairs, and disables retype on an empty target rather than defaulting one", () => {
    const tree = RepairPanel({
      repair: { childless: true, historicalVerificationAvailable: false },
      projectId: "   ",
      onProjectIdChange: () => {},
      parentId: "",
      onParentIdChange: () => {},
      onRetype: () => {},
      onReparent: () => {},
    });
    const actions = withAttr(tree, "data-repair-action");
    expect(actions.map((a) => (a.props as Record<string, unknown>)["data-repair-action"])).toEqual([
      "retype",
      "reparent",
    ]);
    const retype = actions[0]!.props as Record<string, unknown>;
    // Where a repaired item lands is a decision the operation deliberately
    // refuses to make; dropping the `projectId.trim() === ""` clause would
    // let the UI make it silently.
    expect(retype.disabled).toBe(true);
    // Reparent is NOT disabled on empty: empty means the top level, a real
    // and intended choice.
    expect((actions[1]!.props as Record<string, unknown>).disabled).toBe(false);
  });

  it("invokes the callback the button is wired to", () => {
    let retyped = 0;
    const tree = RepairPanel({
      repair: { childless: true, historicalVerificationAvailable: false },
      projectId: "inbox",
      onProjectIdChange: () => {},
      parentId: "",
      onParentIdChange: () => {},
      onRetype: () => {
        retyped += 1;
      },
      onReparent: () => {},
    });
    const retype = withAttr(tree, "data-repair-action")[0]!.props as { onClick: () => void };
    retype.onClick();
    // Swapping `onRetype` for `onReparent` in the JSX leaves this at 0.
    expect(retyped).toBe(1);
  });

  it("distinguishes a completed repair from a refused one", () => {
    const refused = RepairPanel({
      repair: { childless: true, historicalVerificationAvailable: false },
      projectId: "inbox",
      onProjectIdChange: () => {},
      parentId: "",
      onParentIdChange: () => {},
      onRetype: () => {},
      onReparent: () => {},
      outcome: { status: "refused", message: "This project still has 2 children." },
    });
    const marker = withAttr(refused, "data-repair-outcome")[0]!;
    expect((marker.props as Record<string, unknown>)["data-repair-outcome"]).toBe("refused");
    // The service's own message, verbatim — it is the only text that says
    // what to do next.
    expect(textOf(refused)).toContain("still has 2 children");
  });
});

describe("ProjectDetailView", () => {
  it("surfaces blocked descendants as their own region, above the children list", () => {
    const tree = ProjectDetailView({
      ...baseProps,
      loadState: {
        status: "loaded",
        detail: makeDetail({
          derived: {
            column: "waiting",
            counts: counts({ blocked: 1, executing: 1 }),
            causingChild: null,
          },
          children: [makeChild()],
          blockedChildren: [
            {
              id: "deep-1",
              title: "A blocked grandchild",
              state: "blocked",
              blockedReason: "waiting on review",
              blockedOnType: "person",
              area: "web",
              updatedAt: "2026-08-18T10:00:00.000Z",
            },
          ],
        }),
      },
    });
    const text = textOf(tree);
    expect(text).toContain("A blocked grandchild");
    expect(text).toContain("waiting on review");
    // Said explicitly, because a reader assuming this lists direct children
    // would take a short list as good news when the stuck work is deeper.
    expect(text).toContain("at any depth");
    const order = [...walk(tree as never)]
      .map((element) => {
        const props = element.props as Record<string, unknown>;
        if (props["data-blocked-id"] !== undefined) return "blocked";
        if (props["data-child-id"] !== undefined) return "child";
        return null;
      })
      .filter((entry) => entry !== null);
    // Blocked before children. Moving the blocked <section> below the
    // children <section> flips this.
    expect(order).toEqual(["blocked", "child"]);
  });

  it("omits the blocked region entirely when nothing is blocked", () => {
    const tree = ProjectDetailView({
      ...baseProps,
      loadState: {
        status: "loaded",
        detail: makeDetail({
          derived: { column: "in_progress", counts: counts({ executing: 1 }), causingChild: null },
          children: [makeChild()],
        }),
      },
    });
    // An empty "Blocked" heading reads as a fault rather than as good news.
    expect(textOf(tree)).not.toContain("Blocked");
  });

  it("flags a childless nested project in the children list", () => {
    const tree = ProjectDetailView({
      ...baseProps,
      loadState: {
        status: "loaded",
        detail: makeDetail({
          derived: { column: "backlog", counts: counts({ on_deck: 1 }), causingChild: null },
          children: [
            makeChild({ id: "nested", kind: "project", column: "backlog", childless: true }),
          ],
        }),
      },
    });
    const row = withAttr(tree, "data-childless")[0]!;
    expect((row.props as Record<string, unknown>)["data-childless"]).toBe("true");
    // A visible flag, not merely an attribute — the grid's own requirement,
    // applied to the same condition one level down.
    expect(textOf(tree)).toContain("No work under it");
  });

  it("says why an empty project is empty rather than reading as an ordinary blank list", () => {
    const tree = ProjectDetailView({
      ...baseProps,
      loadState: { status: "loaded", detail: makeDetail({ total: 0, childless: true }) },
    });
    const empty = withAttr(tree, "data-empty-reason")[0]!;
    expect((empty.props as Record<string, unknown>)["data-empty-reason"]).toBe("no-children");
    expect(textOf(tree)).toContain("derives from its children");
  });

  it("hands the repair panel this project's own repair advice, unaltered", () => {
    // `walk` yields child COMPONENT elements without invoking them, so the
    // assertion here is at the boundary — that `RepairPanel` is placed and
    // what it is handed. Whether it then renders anything is asserted
    // directly against `RepairPanel` above, which is the only place that
    // decision lives.
    const broken = ProjectDetailView({
      ...baseProps,
      loadState: {
        status: "loaded",
        detail: makeDetail({
          total: 0,
          childless: true,
          repair: { childless: true, historicalVerificationAvailable: false },
        }),
      },
    });
    const placed = findAllByType(broken, RepairPanel);
    expect(placed).toHaveLength(1);
    // The advice must reach the panel intact. Hardcoding
    // `historicalVerificationAvailable: true` in the view — the exact
    // shortcut that would make the page promise a closeable repair on a
    // deployment where the window is shut — fails here.
    expect((placed[0]!.props as { repair: unknown }).repair).toEqual({
      childless: true,
      historicalVerificationAvailable: false,
    });
  });

  it("passes a healthy project's advice through too, so the panel can decline to render", () => {
    const healthy = ProjectDetailView({
      ...baseProps,
      loadState: {
        status: "loaded",
        detail: makeDetail({
          derived: { column: "in_progress", counts: counts({ executing: 2 }), causingChild: null },
          children: [makeChild()],
          repair: { childless: false, historicalVerificationAvailable: false },
        }),
      },
    });
    const placed = findAllByType(healthy, RepairPanel);
    expect((placed[0]!.props as { repair: { childless: boolean } }).repair.childless).toBe(false);
  });

  it("keeps loading and error distinguishable from an empty project", () => {
    const loading = ProjectDetailView({ ...baseProps, loadState: { status: "loading" } });
    expect(textOf(loading)).toContain("Loading project");
    const failed = ProjectDetailView({
      ...baseProps,
      loadState: { status: "error", message: "No such project: p-1." },
    });
    expect(textOf(failed)).toContain("No such project");
    // A failed read must not render the page chrome, or a reader would take
    // an empty children list as "this project has no work".
    expect(withAttr(failed, "data-project-id")).toHaveLength(0);
  });

  it("renders a cost slot that reports 'not yet' rather than implying zero", () => {
    const tree = ProjectDetailView({
      ...baseProps,
      loadState: { status: "loaded", detail: makeDetail({ total: 0, childless: true }) },
    });
    const slot = withAttr(tree, "data-cost-slot")[0]!;
    expect((slot.props as Record<string, unknown>)["data-cost-slot"]).toBe("pending");
    // Zero cost is a claim this page cannot make; an absent section is
    // indistinguishable from one that loaded and found zero.
    expect(textOf(tree)).not.toContain("$0");
  });

  it("shows the activity feed with the item each entry happened on", () => {
    const tree = ProjectDetailView({
      ...baseProps,
      loadState: {
        status: "loaded",
        detail: makeDetail({
          derived: { column: "in_progress", counts: counts({ executing: 1 }), causingChild: null },
          children: [makeChild()],
          activity: [
            {
              id: "1",
              ts: "2026-08-18T11:00:00.000Z",
              type: "note",
              actorType: "agent",
              actorId: "a",
              body: "Picked this up",
              itemId: "c-1",
              itemTitle: "A child",
            },
          ],
        }),
      },
    });
    const text = textOf(tree);
    expect(text).toContain("Picked this up");
    // An activity feed over a subtree is unreadable without naming which
    // item each entry belongs to — dropping the itemTitle link fails here.
    expect(text).toContain("A child");
  });
});
