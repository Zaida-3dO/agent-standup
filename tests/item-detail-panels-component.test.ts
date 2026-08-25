// The three new detail panels — Reviews, Plan, Agent view.
//
// Hook-free and prop-driven (see each component's header), so they are
// called directly as functions and the element trees they return inspected —
// same technique as `tests/item-detail-component.test.ts`, and the reason
// `<details>` was chosen over a state-backed toggle for the collapsed
// sections: a component with hooks cannot be called this way at all.
import { describe, expect, it } from "vitest";
import { ReviewsPanel } from "@/components/item-detail/ReviewsPanel";
import { PlanPanel } from "@/components/item-detail/PlanPanel";
import { AgentPanel } from "@/components/item-detail/AgentPanel";
import { VerdictBadge } from "@/components/item-detail/VerdictBadge";
import { FindingsList } from "@/components/item-detail/FindingsList";
import { Markdown } from "@/components/item-detail/Markdown";
import { ItemDetailView } from "@/components/item-detail/ItemDetailView";
import { agentViewFrom, FIELD_MAX_CHARS, RAW_MAX_CHARS } from "@/lib/item-detail/orientation";
import { VERDICTS } from "@/lib/verdicts";
import type { DetailArtifact, ItemDetail } from "@/lib/item-detail/types";
import { findAllByType, walk } from "./helpers/react-element";
import type { ReactNode } from "react";

/** Every string of text in the tree, including a `<Markdown>`'s source prop — see the sibling suite's note. */
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

/** Every element carrying `prop`, whatever its type. */
function withProp(root: ReactNode, prop: string) {
  return [...walk(root)].filter((el) => (el.props as Record<string, unknown>)[prop] !== undefined);
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

describe("the verdict badge", () => {
  it("prints the tier's label, never the id with its underscores removed", () => {
    // The defect this task exists to fix, asserted at the component: the UI
    // showed a raw underscore-stripped string.
    const text = textOf(VerdictBadge({ verdict: "lgtm_with_followups" }));
    expect(text).toContain("LGTM, with follow-ups");
    expect(text).not.toContain("lgtm with followups");
  });

  it("carries the tone as data as well as colour", () => {
    // A reader who cannot separate the two greens gets the tier from the
    // markup — and so does a page search and a screen reader. Dropping
    // `data-tone` fails this.
    const [group] = withProp(VerdictBadge({ verdict: "lgtm_with_nits" }), "data-tone");
    expect((group?.props as Record<string, unknown>)["data-tone"]).toBe("pass_with_work");
  });

  it("shows the tier's meaning when asked, and not otherwise", () => {
    // A tooltip is invisible to a reader not hovering, on a touch screen, or
    // reading the page as a screenshot in a review — and the obligation
    // attached to a verdict is not optional detail.
    expect(textOf(VerdictBadge({ verdict: "lgtm_with_nits", showMeaning: true }))).toContain(
      "re-review",
    );
    expect(textOf(VerdictBadge({ verdict: "lgtm_with_nits" }))).not.toContain("re-review");
  });

  it("renders all six verdicts with distinguishable text", () => {
    // The acceptance criterion at the render layer: every verdict in the
    // vocabulary reaches the screen as its own words.
    const labels = VERDICTS.map((verdict) => textOf(VerdictBadge({ verdict })).trim());
    expect(new Set(labels).size).toBe(VERDICTS.length);
  });
});

describe("the findings list", () => {
  it("renders a group per severity, most severe first", () => {
    const element = FindingsList({
      findings: [
        { text: "cosmetic", severity: "info" },
        { text: "unbounded read", severity: "critical" },
      ],
    });
    const groups = withProp(element, "data-severity").filter(
      (el) => (el.props as Record<string, unknown>).className !== undefined,
    );
    const severities = groups.map((el) => (el.props as Record<string, unknown>)["data-severity"]);
    expect(severities[0]).toBe("critical");
    expect(severities).toContain("info");
  });

  it("leads with the count and the worst severity", () => {
    // So a reader learns whether opening the groups matters without opening
    // them.
    const text = textOf(
      FindingsList({
        findings: [
          { text: "a", severity: "low" },
          { text: "b", severity: "high" },
        ],
      }),
    );
    expect(text).toContain("2");
    expect(text).toContain("High");
  });

  it("renders finding text as markdown, since a reviewer writes paths in it", () => {
    const element = FindingsList({ findings: [{ text: "`src/a.ts` is unbounded" }] });
    expect(findAllByType(element, Markdown)).toHaveLength(1);
  });

  it("says so when a review recorded no structured findings", () => {
    // "No findings" and "findings failed to render" look identical if both
    // show nothing, and the first is common while the second is a bug.
    const text = textOf(FindingsList({ findings: null }));
    expect(text).toContain("No structured findings");
  });

  it("shows a malformed entry, marked, rather than omitting it", () => {
    const element = FindingsList({ findings: [{ severity: "high" }] });
    expect(textOf(element)).toContain("not a well-formed finding");
    expect(withProp(element, "data-malformed").length).toBeGreaterThan(0);
  });
});

describe("the reviews panel", () => {
  it("puts the current round first, and marks it", () => {
    // A stale approval and a current one are otherwise identical rows, and
    // the whole tip-currency rule turns on which is which. Dropping the
    // `.reverse()` puts the oldest round at the top.
    const element = ReviewsPanel({
      artifacts: [
        artifact({ id: "r1", reviewRound: 1, verdict: "changes_required" }),
        artifact({ id: "r2", reviewRound: 2, verdict: "lgtm" }),
      ],
    });
    const rounds = withProp(element, "data-round");
    expect((rounds[0]?.props as Record<string, unknown>)["data-round"]).toBe(2);
    expect((rounds[0]?.props as Record<string, unknown>)["data-latest-round"]).toBe(true);
    expect((rounds[1]?.props as Record<string, unknown>)["data-latest-round"]).toBeUndefined();
  });

  it("renders the stored findings, not the prose", () => {
    // The point of the tab: `Artifact.findings` is structured JSON with a
    // severity each and nothing read it back.
    const element = ReviewsPanel({
      artifacts: [artifact({ findings: [{ text: "unbounded read", severity: "high" }] })],
    });
    const [list] = findAllByType(element, FindingsList);
    expect(list).toBeDefined();
    // The harness does not render, so a nested component is an unrendered
    // reference and its output does not exist yet — the stored value is
    // asserted where it actually is, in the prop it was handed.
    expect((list?.props as { findings?: unknown }).findings).toEqual([
      { text: "unbounded read", severity: "high" },
    ]);
  });

  it("links the follow-up item a lgtm_with_followups merge is conditional on", () => {
    // That verdict merges immediately on the strength of the deferred work
    // being genuinely filed. A reader asked to approve could not see whether
    // it was; linking it makes the promise checkable rather than stated.
    const element = ReviewsPanel({
      artifacts: [artifact({ verdict: "lgtm_with_followups", followUpItemId: "item-9" })],
    });
    const links = withProp(element, "href").filter((el) => el.type === "a");
    expect(links.map((el) => (el.props as Record<string, string>).href)).toContain("/items/item-9");
  });

  it("shows no follow-up line when none is linked", () => {
    expect(textOf(ReviewsPanel({ artifacts: [artifact()] }))).not.toContain("Follow-up filed");
  });

  it("shows the commit sha the review was made at", () => {
    const text = textOf(ReviewsPanel({ artifacts: [artifact({ commitSha: "abcdef1234567890" })] }));
    expect(text).toContain("abcdef1234");
  });

  it("states plainly that no reviews is not the same as having passed", () => {
    const text = textOf(ReviewsPanel({ artifacts: [] }));
    expect(text).toContain("No reviews yet");
    expect(text).toContain("not the same as it having passed");
  });

  it("puts the reviewer's prose behind a disclosure, after the findings", () => {
    // The findings are the graded, comparable part; the body is the
    // narrative around them, and a reader scanning for severity should not
    // pass a page of prose to reach it.
    const element = ReviewsPanel({ artifacts: [artifact({ body: "A long review." })] });
    expect(findAllByType(element, "details")).toHaveLength(1);
  });
});

describe("the plan panel", () => {
  const plan = (overrides: Partial<DetailArtifact> = {}) =>
    artifact({ kind: "plan", verdict: null, ...overrides });

  it("leads with a BLUF drawn from the live plan", () => {
    const element = PlanPanel({
      artifacts: [plan({ id: "p1", body: "Bound every read to a page." })],
    });
    const [bluf] = withProp(element, "data-bluf");
    expect(bluf).toBeDefined();
    expect(textOf(element)).toContain("Bound every read to a page.");
  });

  it("draws the BLUF from the LIVE plan, not a superseded one", () => {
    // The defect in miniature: the superseded plan is first in server order,
    // so a BLUF taken from `artifacts[0]` would summarise the dead plan.
    const element = PlanPanel({
      artifacts: [
        plan({ id: "p1", reviewRound: 1, body: "A superseded approach." }),
        plan({ id: "p2", reviewRound: 2, body: "The current approach." }),
      ],
    });
    const [bluf] = withProp(element, "data-bluf");
    expect(textOf(bluf)).toContain("The current approach.");
    expect(textOf(bluf)).not.toContain("A superseded approach.");
  });

  it("renders the live plan expanded and the superseded ones collapsed", () => {
    // The whole ranking: a superseded snapshot is a `<details>` a reader
    // opens, the live one is the page. Rendering both at the same weight
    // would leave a reader unable to tell which plan is in force.
    const element = PlanPanel({
      artifacts: [
        plan({ id: "p1", reviewRound: 1, body: "Old." }),
        plan({ id: "p2", reviewRound: 2, body: "Current." }),
      ],
    });
    const current = withProp(element, "data-plan").filter(
      (el) => (el.props as Record<string, unknown>)["data-plan"] === "current",
    );
    expect(current).toHaveLength(1);
    const collapsed = withProp(element, "data-superseded");
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.type).toBe("details");
    // And the live one is NOT inside a disclosure.
    expect(findAllByType(current[0], "details")).toHaveLength(0);
  });

  it("gives plan reviews their own section rather than interleaving them", () => {
    const element = PlanPanel({
      artifacts: [
        plan({ id: "p1", body: "The plan." }),
        artifact({ id: "r1", kind: "plan_review", verdict: "changes_required" }),
      ],
    });
    const sections = withProp(element, "data-plan").map(
      (el) => (el.props as Record<string, unknown>)["data-plan"],
    );
    expect(sections).toContain("current");
    expect(sections).toContain("reviews");
  });

  it("renders a plan review's findings, which were as unread here as anywhere", () => {
    const element = PlanPanel({
      artifacts: [
        artifact({
          id: "r1",
          kind: "plan_review",
          verdict: "changes_required",
          findings: [{ text: "the migration is irreversible", severity: "critical" }],
        }),
      ],
    });
    const [list] = findAllByType(element, FindingsList);
    expect((list?.props as { findings?: unknown }).findings).toEqual([
      { text: "the migration is irreversible", severity: "critical" },
    ]);
  });

  it("does not print the BLUF's own paragraph twice", () => {
    // The BLUF is drawn from the plan's opening paragraph, so on a plan that
    // opens with its bottom line — the shape a good plan has — the lead
    // block and the first line of the card below it would be the same
    // sentence a few centimetres apart. A summary that only repeats the text
    // beneath it earns nothing for the space it takes.
    const element = PlanPanel({
      artifacts: [plan({ body: "Rank the tab rather than stacking it.\n\n## Why\n\nBecause." })],
    });
    const rendered = textOf(element);
    const occurrences = rendered.split("Rank the tab rather than stacking it.").length - 1;
    expect(occurrences).toBe(1);
    // And the rest of the body survives — the paragraph is un-repeated, not
    // the card truncated.
    expect(rendered).toContain("Because.");
  });

  it("keeps the body whole when the BLUF did not come from its opening paragraph", () => {
    // A BLUF taken from a list item is saying something the card's own
    // opening does not, so there is nothing being repeated and nothing to
    // drop. Dropping unconditionally would silently eat the first paragraph
    // of every plan.
    const element = PlanPanel({
      artifacts: [plan({ body: "# Steps\n\n- Bound the reads\n- Then the writes" })],
    });
    expect(textOf(element)).toContain("Bound the reads");
    expect(textOf(element)).toContain("Then the writes");
  });

  it("keeps the body whole when the BLUF was truncated", () => {
    // A truncated BLUF summarises a paragraph too long to be one, so the
    // paragraph still carries more than the lead does.
    const long = `${"word ".repeat(400)}end`;
    const element = PlanPanel({ artifacts: [plan({ body: long })] });
    expect(textOf(element)).toContain("end");
  });

  it("gives every collapsed snapshot a visible disclosure affordance", () => {
    // A row that renders identically open and closed reads as inert metadata,
    // and the history behind it is then reachable only by a reader who clicks
    // on spec. Removing the hint or the marker fails this.
    const element = PlanPanel({
      artifacts: [
        plan({ id: "p1", reviewRound: 1, body: "Superseded." }),
        plan({ id: "p2", reviewRound: 2, body: "Current." }),
      ],
    });
    const [details] = withProp(element, "data-superseded");
    const summaryText = textOf(details);
    expect(summaryText).toContain("Show");
    expect(summaryText).toContain("superseded");
  });

  it("omits the BLUF rather than rendering an empty one", () => {
    // An empty lead block reads as a rendering fault; its absence reads as
    // nothing to say.
    const element = PlanPanel({ artifacts: [plan({ body: "## Only a heading" })] });
    expect(withProp(element, "data-bluf")).toHaveLength(0);
  });

  it("says so when no plan has been recorded", () => {
    expect(textOf(PlanPanel({ artifacts: [] }))).toContain("No plan recorded yet");
  });
});

describe("the agent panel", () => {
  it("offers to load rather than fetching on arrival", () => {
    // `orientation` is the most expensive read this page can make, on its
    // least-used panel. Paying for it on every visit to an item would put
    // the page's largest cost where it is least often wanted.
    const element = AgentPanel({ state: { status: "idle" }, onLoad: () => {} });
    expect(findAllByType(element, "button")).toHaveLength(1);
    expect(textOf(element)).toContain("Load agent view");
  });

  it("renders no control when it has no way to load", () => {
    const element = AgentPanel({ state: { status: "idle" } });
    expect(findAllByType(element, "button")).toHaveLength(0);
  });

  it("renders a huge payload without putting it on the page", () => {
    // The acceptance criterion at the render layer: a 165k-char item does
    // not break the page. The rendered tree is asserted to be small — not
    // merely to exist.
    const payload = {
      item: { title: "An item", state: "executing", body: "x".repeat(49_000) },
      whatChanged: Array.from({ length: 400 }, (_, i) => ({
        id: String(i),
        ts: "2026-01-01T00:00:00.000Z",
        type: "note",
        body: "z".repeat(500),
      })),
      openLoops: { notDone: [], children: [], loops: [] },
      crew: [],
    };
    const view = agentViewFrom(payload);
    const element = AgentPanel({ state: { status: "loaded", view } });

    // The raw block is deliberately the one long string the panel carries —
    // it is the escape hatch, it is collapsed, and it is capped on its own.
    // It is asserted separately so that it cannot mask an unbounded field
    // somewhere else in the tree.
    expect(view.raw.text.length).toBe(RAW_MAX_CHARS);

    // Everything else: the harness walks the tree the component RETURNED, so
    // this ranges over every prop and every child — including the values
    // handed to nested components, which is where a long string would
    // actually be hiding. A CSS-only clip would leave the string here and
    // fail this; the bounding is real.
    const rendered = JSON.stringify(
      [...walk(element)].map((el) => el.props),
      (_key, value) => (value === view.raw.text ? "<RAW>" : (value as unknown)),
    );

    // No single field survives at anything like its stored length: the body
    // was 49,000 characters and the longest run of it left anywhere on the
    // page is the field bound. Removing the `boundedText` call around
    // `item.body` in `agentViewFrom` fails this.
    const longestBodyRun = Math.max(
      0,
      ...[...rendered.matchAll(/x{10,}/g)].map((match) => match[0].length),
    );
    expect(longestBodyRun).toBe(FIELD_MAX_CHARS);

    // And the page's total text is bounded. Measured over the DISTINCT
    // strings in the tree rather than over the serialised walk: `walk`
    // yields a nested element once for itself and again inside each
    // ancestor's `children`, so a serialisation of it counts the same string
    // several times and would report a page several times larger than the
    // one a reader gets. The set is what actually lands on screen.
    const distinct = new Set<string>();
    for (const el of walk(element)) {
      for (const value of Object.values(el.props as Record<string, unknown>)) {
        if (typeof value === "string") distinct.add(value);
      }
    }
    const onScreen = [...distinct].reduce((total, value) => total + value.length, 0);
    // Two orders of magnitude below the payload it was built from — and the
    // 400 events contribute 20 rows, not 400.
    expect(onScreen).toBeLessThan(40_000);
    expect(JSON.stringify(payload).length).toBeGreaterThan(165_000);
  });

  it("says how many events it is showing out of how many there are", () => {
    // A capped list that reads as complete is exactly the failure this panel
    // exists to avoid.
    const view = agentViewFrom({
      whatChanged: Array.from({ length: 400 }, (_, i) => ({ id: String(i), type: "note" })),
    });
    expect(textOf(AgentPanel({ state: { status: "loaded", view } }))).toContain("400");
  });

  it("puts the raw payload behind a disclosure rather than on the page", () => {
    const view = agentViewFrom({ item: { title: "t" } });
    const element = AgentPanel({ state: { status: "loaded", view } });
    const [raw] = withProp(element, "data-raw");
    expect(raw).toBeDefined();
    expect(findAllByType(element, "details")).toHaveLength(1);
  });

  it("shows the error and offers a retry", () => {
    const element = AgentPanel({
      state: { status: "error", message: "No such item: x." },
      onLoad: () => {},
    });
    expect(textOf(element)).toContain("No such item: x.");
    expect(findAllByType(element, "button")).toHaveLength(1);
  });

  it("says an item with no checkpoint tells a resuming agent nothing", () => {
    const view = agentViewFrom({ item: { title: "t" }, checkpoint: null });
    expect(textOf(AgentPanel({ state: { status: "loaded", view } }))).toContain("No checkpoint");
  });
});

describe("the detail view, wired to the new panels", () => {
  function detail(artifacts: readonly DetailArtifact[]): ItemDetail {
    return {
      item: {
        id: "item-1",
        parentId: null,
        title: "An item",
        headline: null,
        body: "",
        kind: "task",
        state: "in_review",
        priority: "P2",
        area: "web",
        repo: null,
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
        archivedAt: null,
        archivedReason: null,
        supersededById: null,
      },
      column: "in_progress",
      subtasks: [],
      artifacts,
      history: [],
      historyTruncated: false,
      summary: null,
      assignments: [],
      previousHolders: [],
    };
  }

  it("renders the plan tab through the plan panel", () => {
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail([artifact({ kind: "plan", verdict: null })]) },
      activeTab: "plan",
    });
    expect(findAllByType(element, PlanPanel)).toHaveLength(1);
    expect(findAllByType(element, ReviewsPanel)).toHaveLength(0);
  });

  it("renders the reviews tab through the reviews panel", () => {
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail([artifact()]) },
      activeTab: "reviews",
    });
    expect(findAllByType(element, ReviewsPanel)).toHaveLength(1);
  });

  it("renders the agent tab, idle until asked", () => {
    const element = ItemDetailView({
      loadState: { status: "loaded", detail: detail([]) },
      activeTab: "agent",
    });
    expect(findAllByType(element, AgentPanel)).toHaveLength(1);
  });

  it("shows the header's latest verdict as its tier", () => {
    // The header is the first thing a reader glances at, and it was
    // flattening the tier there too.
    const element = ItemDetailView({
      loadState: {
        status: "loaded",
        detail: detail([artifact({ verdict: "lgtm_with_followups" })]),
      },
      activeTab: "overview",
    });
    // The badge is a nested component reference in this tree, so what is
    // asserted here is that the header routes the verdict THROUGH it rather
    // than printing the raw value itself — the raw string must be absent.
    const [badge] = findAllByType(element, VerdictBadge);
    expect((badge?.props as { verdict?: string }).verdict).toBe("lgtm_with_followups");
    expect(textOf(element)).not.toContain("lgtm with followups");
    // And the badge, rendered, is the tier rather than the id.
    expect(textOf(VerdictBadge({ verdict: "lgtm_with_followups" }))).toContain(
      "LGTM, with follow-ups",
    );
  });
});
