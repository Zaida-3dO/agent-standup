// The Standup home's components (`/`). They are hook-free and prop-driven, so
// they are called as plain functions on hand-written view-models (the shape
// `buildStandupView` returns, whose rules are tested in `standup-view.test.ts`)
// and the element tree is expanded to plain markup to assert on. Nothing here
// decides anything: these tests prove the page DRAWS what it is given, in the
// order it is given, without adding words the reader should not see.
//
// What a green run means: the structure (one h1, section + h2 per panel, DOM
// order, one link per card), the states (quiet, no Stuck, no spend, each
// section's own error with Try again) and the vocabulary (no "an agent", role
// text, ids or state codes) hold for these fixtures. It does not mean the page
// looks right; the layout is checked against a real browser, and the CSS
// declarations are pinned in `standup-touch-targets.test.ts`.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Link from "next/link";
import { describe, expect, it, vi } from "vitest";
import { DoneSincePanel } from "@/components/standup/DoneSincePanel";
import { NeedsYouPanel } from "@/components/standup/NeedsYouPanel";
import { ProjectCard } from "@/components/standup/ProjectCard";
import { StandupPage, StandupHomeView } from "@/components/standup/StandupHomeView";
import { SectionError, countText } from "@/components/standup/StandupParts";
import { StuckPanel, showsStuck } from "@/components/standup/StuckPanel";
import type { StandupData, StandupLoadState } from "@/lib/standup/state";
import type {
  DoneRowView,
  NeedsYouRowView,
  ProjectBarView,
  ProjectCardView,
  SentencePart,
  StandupView,
  StuckRowView,
} from "@/lib/standup/view";
import { findAllByType } from "./helpers/react-element";

// ── Rendering helpers ───────────────────────────────────────────────────

/**
 * Expands every function component in a tree down to host elements (a
 * `next/link` becomes a plain `<a>`), then renders the result. The panels are
 * hook-free, so calling them as functions is a faithful render, and it keeps
 * Next's runtime out of a DOM-free test.
 */
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  const { type, props } = element;
  if (typeof type === "function" && type !== (Link as unknown)) {
    return expand((type as (p: Record<string, unknown>) => ReactNode)(props));
  }
  const host = type === (Link as unknown) ? "a" : (type as string);
  const { children, ...rest } = props;
  const kids = Array.isArray(children) ? children : children === undefined ? [] : [children];
  return createElement(
    host,
    { ...rest, key: element.key ?? undefined },
    ...kids.map((kid) => expand(kid as ReactNode)),
  );
}

const render = (node: ReactNode): string => renderToStaticMarkup(expand(node) as ReactElement);

/** The visible text of rendered markup: tags dropped, entities decoded, spaces collapsed. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const headings = (markup: string, level: 1 | 2): string[] =>
  [...markup.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, "g"))].map((m) =>
    textOf(m[1]!),
  );

const count = (markup: string, needle: string | RegExp): number =>
  typeof needle === "string"
    ? markup.split(needle).length - 1
    : (markup.match(new RegExp(needle, "g")) ?? []).length;

/** The deepest nesting of anchors in the markup: a card or row with a link inside a link would give 2. */
function maxAnchorDepth(markup: string): number {
  let depth = 0;
  let deepest = 0;
  for (const m of markup.matchAll(/<a[\s>]|<\/a>/g)) {
    depth += m[0] === "</a>" ? -1 : 1;
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

// ── Fixtures: invented content only ─────────────────────────────────────

const FINANCE = { id: "project-finance", title: "Finance app" };
const PHOTOS = { id: "project-photos", title: "Photo frame" };
const DASHBOARD = { id: "project-dashboard", title: "Home dashboard" };

const parts = (...runs: readonly [string, SentencePart["tone"]][]) => {
  const list = runs.map(([text, tone]) => ({ text, tone }));
  return { parts: list, text: list.map((part) => part.text).join("") };
};

const BAR: ProjectBarView = {
  done: 18,
  inProgress: 4,
  stuckOrPaused: 2,
  todo: 7,
  total: 31,
  doneWidth: 58,
  inProgressWidth: 13,
  stuckWidth: 6,
  caption: "18 of 31 done",
  ariaLabel: "18 of 31 done, 4 in progress, 2 stuck or paused",
};

function card(overrides: Partial<ProjectCardView> = {}): ProjectCardView {
  return {
    id: FINANCE.id,
    title: FINANCE.title,
    href: `/projects/${FINANCE.id}`,
    headline: "Tracks spending and net worth from bank statements.",
    needsYouCount: 0,
    stuckCount: 0,
    needsYouBadge: null,
    stuckBadge: null,
    flagged: false,
    liveItems: [],
    moreLiveText: null,
    noOneWorking: false,
    bar: BAR,
    lastActive: "active 6m ago",
    ...overrides,
  };
}

const needsRow = (overrides: Partial<NeedsYouRowView> = {}): NeedsYouRowView => ({
  id: "item-bank-choice",
  title: "Choose which bank the import supports first",
  href: "/items/item-bank-choice",
  project: FINANCE,
  ask: "Both statement formats are ready to start. Bank A or Bank B?",
  verb: "Answer",
  waiting: "waiting 1 day",
  waitingLong: true,
  ...overrides,
});

const stuckRow = (overrides: Partial<StuckRowView> = {}): StuckRowView => ({
  id: "item-photo-hub",
  title: "Open the photo frame on the TVs from the hub",
  href: "/items/item-photo-hub",
  project: PHOTOS,
  why: "Waiting for the photo app's maintainers to accept the change.",
  age: "4 days",
  kind: "blocked",
  ...overrides,
});

const doneRow = (overrides: Partial<DoneRowView> = {}): DoneRowView => ({
  itemId: "item-office-lights",
  title: "Office lights grouped into one tile",
  href: "/items/item-office-lights",
  project: DASHBOARD,
  time: "08:12",
  ...overrides,
});

/** A busy morning: every panel has something to say. */
function busyView(overrides: Partial<StandupView> = {}): StandupView {
  return {
    dateLine: "Wednesday 4 November",
    sentence: parts(
      ["2 things need you.", "hot"],
      [" ", "plain"],
      ["3 agents are working across 2 projects, and ", "plain"],
      ["4 things", "strong"],
      [" were finished since yesterday evening.", "plain"],
    ),
    sinceLabel: "yesterday evening",
    spend: "Spent since 18:00 yesterday: ~$18.40",
    needsYou: {
      status: "loaded",
      total: 2,
      rows: [
        needsRow(),
        needsRow({
          id: "item-shop-domain",
          title: "Move the shop to its own domain",
          href: "/items/item-shop-domain#reviews",
          project: DASHBOARD,
          ask: "The plan is written. Approving it lets the work start.",
          verb: "Review plan",
          waiting: "waiting 5h",
          waitingLong: false,
        }),
      ],
      hasMore: false,
      quiet: false,
    },
    stuck: {
      status: "loaded",
      rows: [
        stuckRow(),
        stuckRow({
          id: "item-statements",
          title: "Read statements straight from email",
          href: "/items/item-statements",
          project: FINANCE,
          why: "Its agent stopped responding.",
          age: "quiet for 3h",
          kind: "stopped",
        }),
      ],
      count: { count: 2, atLeast: false },
      more: 0,
    },
    projects: {
      status: "loaded",
      empty: false,
      activeCount: { count: 3, atLeast: false },
      activeText: "3 active",
      cards: [
        card({
          needsYouBadge: "1 needs you",
          stuckBadge: "1 stuck",
          flagged: true,
          liveItems: [{ id: "item-live-1", title: "Sort card payments into categories" }],
          moreLiveText: "+2 more",
        }),
        card({
          id: PHOTOS.id,
          title: PHOTOS.title,
          href: `/projects/${PHOTOS.id}`,
          headline: "Family photos on the TVs and the hallway screen.",
          noOneWorking: true,
          bar: null,
          lastActive: "active 4 days ago",
        }),
      ],
      alsoActive: [],
      quiet: [{ id: "project-garden", title: "Garden lights", href: "/projects/project-garden" }],
      notStarted: [{ id: "project-band", title: "Band website", href: "/projects/project-band" }],
    },
    done: {
      status: "loaded",
      total: { count: 4, atLeast: false },
      rows: [doneRow(), doneRow({ itemId: null, href: null, title: "A merge with no item" })],
      empty: false,
      footerText: "2 more in the activity log",
    },
    ...overrides,
  };
}

/** A calm day: nothing needs the reader, nothing is stuck. */
function quietView(overrides: Partial<StandupView> = {}): StandupView {
  return busyView({
    sentence: parts(
      ["Nothing needs you.", "clear"],
      [" ", "plain"],
      ["3 agents are working across 2 projects, and ", "plain"],
      ["4 things", "strong"],
      [" were finished since yesterday evening.", "plain"],
    ),
    needsYou: { status: "loaded", total: 0, rows: [], hasMore: false, quiet: true },
    stuck: { status: "loaded", rows: [], count: { count: 0, atLeast: false }, more: 0 },
    ...overrides,
  });
}

const page = (view: StandupView, onRetry: () => void = () => {}): string =>
  render(StandupPage({ view, onRetry }));

// ── The load branches ───────────────────────────────────────────────────

describe("StandupHomeView — load branches", () => {
  const NOW = new Date(2026, 7, 19, 9, 0, 0).getTime(); // Wednesday 19 August, local

  it("shows a skeleton in the page's shape while loading, with no spinner and no retry", () => {
    const html = render(
      StandupHomeView({ loadState: { status: "loading" }, now: NOW, onRetry: () => {} }),
    );
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(textOf(html)).toContain("Loading the standup");
    expect(headings(html, 1)).toEqual(["Standup"]);
    // Three Needs-you row bars, six card outlines, one rail block.
    expect(count(html, /<li/)).toBe(6);
    expect(count(html, "<button")).toBe(0);
  });

  it("shows the whole-page error with a Try again that re-runs the load", () => {
    const onRetry = vi.fn();
    const loadState: StandupLoadState = { status: "error", message: "the API said no" };
    const tree = StandupHomeView({ loadState, now: NOW, onRetry });
    const html = render(tree);
    expect(textOf(html)).toContain("the API said no");
    expect(headings(html, 1)).toEqual(["Standup"]);

    const buttons = findAllByType(tree, "button");
    expect(buttons).toHaveLength(1);
    expect(textOf(render(buttons[0]))).toBe("Try again");
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the whole-page error when every section failed, not five section errors", () => {
    const onRetry = vi.fn();
    const failed = (message: string) => ({ status: "error", message }) as const;
    const data: StandupData = {
      viewerId: "user-a",
      overnight: failed("overnight down"),
      inProgress: failed("board down"),
      waiting: failed("board down"),
      projects: failed("projects down"),
      needsYou: failed("needs-you down"),
    };
    const tree = StandupHomeView({ loadState: { status: "loaded", data }, now: NOW, onRetry });
    const html = render(tree);
    // Killed by dropping the every-section check: the page would draw four
    // section errors and no sentence instead.
    expect(textOf(html)).toContain("needs-you down");
    expect(count(html, 'data-section-error="true"')).toBe(0);
    expect(headings(html, 1)).toEqual(["Standup"]);
    const buttons = findAllByType(tree, "button");
    expect(buttons).toHaveLength(1);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("builds the view from the loaded data, so a quiet board renders the calm page", () => {
    const loaded = <T>(data: T) => ({ status: "loaded", data }) as const;
    const data: StandupData = {
      viewerId: "user-a",
      overnight: loaded({
        since: new Date(2026, 7, 18, 18, 0, 0).toISOString(),
        merged: [],
        cost: null,
        costUnavailable: false,
        eventsTruncated: false,
      }),
      inProgress: loaded({ entries: [], total: 0, capped: false }),
      waiting: loaded({ entries: [], total: 0, capped: false }),
      projects: loaded({ projects: [], childlessCount: 0 }),
      needsYou: loaded({ items: [], total: 0 }),
    };
    const html = render(
      StandupHomeView({ loadState: { status: "loaded", data }, now: NOW, onRetry: () => {} }),
    );
    expect(headings(html, 1)).toEqual(["Standup · Wednesday 19 August"]);
    expect(html).toContain('data-quiet="true"');
    expect(textOf(html)).toContain("Nothing needs you.");
    expect(textOf(html)).not.toContain("Spent since");
  });
});

// ── Structure, order and vocabulary ─────────────────────────────────────

describe("StandupPage — structure", () => {
  it("has one h1, then the panels in reading order: sentence, Needs you, Stuck, Projects, Done", () => {
    const html = page(busyView());
    expect(headings(html, 1)).toEqual(["Standup · Wednesday 4 November"]);
    expect(headings(html, 2)).toEqual([
      "Needs you",
      "Stuck",
      "Projects",
      "Done since yesterday evening",
    ]);

    const at = (needle: string) => {
      const index = html.indexOf(needle);
      expect(index, `${needle} should be on the page`).toBeGreaterThan(-1);
      return index;
    };
    const order = [
      at("2 things need you."),
      at(">Needs you</h2>"),
      at(">Stuck</h2>"),
      at(">Projects</h2>"),
      at(">Done since yesterday evening</h2>"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The page, plus one labelled section per panel; the sentence is text, not a heading.
    expect(count(html, "<section")).toBe(5);
    expect(count(html, /aria-labelledby="standup-/)).toBe(4);
  });

  it("leads with the sentence, tones carried as data and never as the only signal", () => {
    const html = page(busyView());
    expect(html).toContain('data-tone="hot">2 things need you.<');
    expect(html).toContain('data-tone="strong">4 things<');
    expect(textOf(html)).toContain(
      "2 things need you. 3 agents are working across 2 projects, and 4 things were finished since yesterday evening.",
    );
    expect(page(quietView())).toContain('data-tone="clear">Nothing needs you.<');
  });

  it("never nests a link in a link, and gives each project card exactly one", () => {
    expect(maxAnchorDepth(page(busyView()))).toBe(1);
    expect(maxAnchorDepth(page(quietView()))).toBe(1);
    const cardHtml = render(
      ProjectCard({
        card: card({
          needsYouBadge: "1 needs you",
          liveItems: [{ id: "item-live-1", title: "Sort card payments" }],
        }),
      }),
    );
    expect(count(cardHtml, "<a ")).toBe(1);
    expect(cardHtml).toContain(`href="/projects/${FINANCE.id}"`);
  });

  it.each([
    ["a busy morning", busyView],
    ["a quiet day", quietView],
  ])("shows no 'an agent', role text, ids or state codes on %s", (_name, make) => {
    const text = textOf(page(make()));
    expect(text).not.toMatch(/\ban agent\b/i);
    expect(text).not.toMatch(/\b(builder|reviewer|planner|orchestrator)\b/i);
    expect(text).not.toMatch(
      /\b(plan_review|in_review|executing|on_deck|research_done|wont_do|needs_approval|blocked_on_you)\b/,
    );
    // Ids are for hrefs only.
    expect(text).not.toMatch(/\b(item|project)-[a-z0-9-]+/);
    expect(text.length).toBeGreaterThan(100);
  });
});

// ── The states ──────────────────────────────────────────────────────────

describe("StandupPage — states", () => {
  it("steps Needs you aside as one calm line when nothing needs the reader", () => {
    const html = page(quietView());
    expect(html).toContain('data-quiet="true"');
    expect(headings(html, 2)).toEqual([
      "Nothing needs you right now.",
      "Projects",
      "Done since yesterday evening",
    ]);
    expect(textOf(html)).toContain("Everything below is moving on its own.");
    // No row, no verb button, no count badge for an empty panel.
    expect(textOf(html)).not.toMatch(/\b(Answer|Review plan|Take a look|Approve)\b/);
  });

  it("renders no Stuck panel at all when nothing is stuck, and lets Done move up", () => {
    const quiet = page(quietView());
    expect(showsStuck(quietView().stuck)).toBe(false);
    expect(headings(quiet, 2)).not.toContain("Stuck");
    expect(quiet).toContain('data-has-stuck="false"');
    expect(render(StuckPanel({ view: quietView().stuck, onRetry: () => {} }))).toBe("");

    const busy = page(busyView());
    expect(showsStuck(busyView().stuck)).toBe(true);
    expect(busy).toContain('data-has-stuck="true"');
  });

  it("shows spend only when it is known", () => {
    expect(textOf(page(busyView({ spend: "Spent since 18:00 yesterday: ~$18.40" })))).toContain(
      "Spent since 18:00 yesterday: ~$18.40",
    );
    const without = page(busyView({ spend: null }));
    expect(textOf(without)).not.toContain("Spent");
    expect(textOf(without)).not.toContain("$");
  });

  it("draws nothing for a sentence whose every clause was dropped", () => {
    const html = page(busyView({ sentence: { parts: [], text: "" } }));
    expect(count(html, "data-tone=")).toBe(0);
    expect(headings(html, 1)).toHaveLength(1);
  });

  it.each([
    ["needsYou", "Needs you"],
    ["stuck", "Stuck"],
    ["projects", "Projects"],
    ["done", "Done since yesterday evening"],
  ] as const)(
    "gives a failed %s read its own title, one line and a Try again, and leaves the rest",
    (key, title) => {
      const onRetry = vi.fn();
      const view = Object.assign(busyView(), {
        [key]: { status: "error", message: `${key} read failed` },
      });
      const tree = StandupPage({ view, onRetry });
      const html = render(tree);

      expect(count(html, 'data-section-error="true"')).toBe(1);
      expect(count(html, "Try again")).toBe(1);
      expect(textOf(html)).toContain("Couldn't load this just now.");
      expect(headings(html, 2)).toContain(title);
      // The other three panels still render as normal.
      expect(headings(html, 2)).toHaveLength(4);
      expect(count(html, "<button")).toBe(1);
      // The page does not repeat the technical message as visible text.
      expect(textOf(html)).not.toContain(`${key} read failed`);
    },
  );

  it("wires every Try again to the one page re-load", () => {
    const onRetry = vi.fn();
    const failed = { status: "error", message: "down" } as const;
    const tree = StandupPage({
      view: busyView({ needsYou: failed, stuck: failed, projects: failed, done: failed }),
      onRetry,
    });
    const expanded = expand(tree) as ReactElement;
    const buttons = findAllByType(expanded, "button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) (button.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      "nothing finished",
      busyView({
        done: {
          status: "loaded",
          total: { count: 0, atLeast: false },
          rows: [],
          empty: true,
          footerText: "Activity log",
        },
      }),
      "Nothing finished since yesterday evening.",
    ],
    [
      "no projects",
      busyView({
        projects: {
          status: "loaded",
          empty: true,
          activeCount: { count: 0, atLeast: false },
          activeText: "0 active",
          cards: [],
          alsoActive: [],
          quiet: [],
          notStarted: [],
        },
      }),
      "No projects yet. Projects appear here as agents pick up work.",
    ],
  ])("says so plainly when %s", (_name, view, line) => {
    const html = page(view);
    expect(textOf(html)).toContain(line);
    if (line.startsWith("No projects")) {
      expect(html).toContain('href="/projects"');
      expect(count(html, 'role="img"')).toBe(0);
    }
  });

  it("uses the evening the data says, in the Done title and its empty line", () => {
    const html = page(
      quietView({
        sinceLabel: "this evening",
        done: {
          status: "loaded",
          total: { count: 0, atLeast: false },
          rows: [],
          empty: true,
          footerText: "Activity log",
        },
      }),
    );
    expect(headings(html, 2)).toContain("Done since this evening");
    expect(textOf(html)).toContain("Nothing finished since this evening.");
  });
});

// ── Panels ──────────────────────────────────────────────────────────────

describe("NeedsYouPanel", () => {
  it("opens the item from both the title and the verb button, and names the button for its row", () => {
    const html = render(NeedsYouPanel({ view: busyView().needsYou, onRetry: () => {} }));
    const first = needsRow();
    expect(count(html, `href="${first.href}"`)).toBe(2);
    expect(html).toContain(`aria-label="Answer: ${first.title}"`);
    expect(html).toContain('href="/items/item-shop-domain#reviews"');
    expect(textOf(html)).toContain("Finance app");
    // The project is text beside the title, not a third stop.
    expect(count(html, "<a ")).toBe(4);
  });

  it("marks a wait of a day or more, and shows no age rather than a made-up one", () => {
    const html = render(
      NeedsYouPanel({
        view: {
          status: "loaded",
          total: 3,
          rows: [
            needsRow({ id: "a", href: "/items/a", waitingLong: true }),
            needsRow({ id: "b", href: "/items/b", waiting: "waiting 5h", waitingLong: false }),
            needsRow({ id: "c", href: "/items/c", waiting: null, waitingLong: false }),
          ],
          hasMore: false,
          quiet: false,
        },
        onRetry: () => {},
      }),
    );
    expect(count(html, 'data-long="true"')).toBe(1);
    expect(textOf(html)).toContain("waiting 1 day");
    expect(textOf(html)).toContain("waiting 5h");
    expect(count(html, /waiting/)).toBe(2);
  });

  it("links to the full list only when there are more than the rows shown", () => {
    const loaded = (hasMore: boolean) =>
      render(
        NeedsYouPanel({
          view: {
            status: "loaded",
            total: hasMore ? 9 : 1,
            rows: [needsRow()],
            hasMore,
            quiet: false,
          },
          onRetry: () => {},
        }),
      );
    expect(loaded(true)).toContain('href="/needs-you"');
    expect(textOf(loaded(true))).toContain("Open the full list");
    expect(loaded(false)).not.toContain('href="/needs-you"');
  });
});

describe("StuckPanel and DoneSincePanel", () => {
  it("shows a stuck row's title, why, project and age, and floors the count as '2+'", () => {
    const html = render(
      StuckPanel({
        view: {
          status: "loaded",
          rows: [stuckRow(), stuckRow({ id: "x", href: "/items/x", age: null })],
          count: { count: 2, atLeast: true },
          more: 0,
        },
        onRetry: () => {},
      }),
    );
    const text = textOf(html);
    expect(text).toContain("Open the photo frame on the TVs from the hub");
    expect(text).toContain("Waiting for the photo app's maintainers to accept the change.");
    expect(text).toContain("Photo frame");
    expect(text).toContain("4 days");
    expect(text).toContain("2+");
    expect(count(html, "<a ")).toBe(2);
  });

  it("links to the board for the stuck items it does not draw, and only then", () => {
    const panel = (more: number) =>
      render(
        StuckPanel({
          view: {
            status: "loaded",
            rows: [stuckRow()],
            count: { count: 1 + more, atLeast: false },
            more,
          },
          onRetry: () => {},
        }),
      );
    expect(panel(0)).not.toContain('href="/board"');
    const html = panel(3);
    expect(html).toContain('href="/board"');
    expect(textOf(html)).toContain("3 more on the board");
    expect(textOf(html)).toContain("4"); // the count is every stuck item, not the rows drawn
  });

  it("lists done titles with project and time, a row without an item as plain text, and the log link", () => {
    const html = render(
      DoneSincePanel({ view: busyView().done, sinceLabel: "yesterday evening", onRetry: () => {} }),
    );
    expect(textOf(html)).toContain("Office lights grouped into one tile Home dashboard 08:12");
    expect(count(html, `href="/items/item-office-lights"`)).toBe(1);
    expect(textOf(html)).toContain("A merge with no item");
    expect(count(html, "<a ")).toBe(2); // the one linked title, and the footer
    expect(html).toContain('href="/activity"');
    expect(textOf(html)).toContain("2 more in the activity log");
  });

  it("prints counts that may be floors with a plus", () => {
    expect(countText({ count: 9, atLeast: true })).toBe("9+");
    expect(countText({ count: 9, atLeast: false })).toBe("9");
  });
});

describe("ProjectCard", () => {
  type Check = (html: string) => void;
  const CASES: readonly [string, Partial<ProjectCardView>, Check][] = [
    [
      "a flagged card with badges and live work",
      {
        flagged: true,
        needsYouBadge: "1 needs you",
        stuckBadge: "1 stuck",
        liveItems: [
          { id: "item-live-1", title: "Sort card payments into categories" },
          { id: "item-live-2", title: "Chart groups by month" },
        ],
        moreLiveText: "+3 more",
      },
      (html) => {
        expect(html).toContain('data-flagged="true"');
        const text = textOf(html);
        expect(text).toContain("1 needs you");
        expect(text).toContain("1 stuck");
        expect(text).toContain("Sort card payments into categories");
        expect(text).toContain("+3 more");
        expect(text).not.toContain("No one is working");
      },
    ],
    [
      "a card nobody is working on",
      { liveItems: [], noOneWorking: true },
      (html) => {
        expect(textOf(html)).toContain("No one is working on it right now.");
        expect(html).not.toContain("data-flagged");
      },
    ],
    [
      "a card whose live read failed says nothing about who is working",
      { liveItems: null, noOneWorking: false },
      (html) => {
        expect(textOf(html)).not.toContain("No one is working");
        expect(textOf(html)).not.toContain("more");
      },
    ],
    [
      "a card with no countable work has no bar and no 'x of y done'",
      { bar: null },
      (html) => {
        expect(html).not.toContain('role="img"');
        expect(textOf(html)).not.toMatch(/\bdone\b/);
        expect(textOf(html)).toContain("active 6m ago");
      },
    ],
    [
      "a card with a bar describes it in words, and sizes it from the view",
      {},
      (html) => {
        expect(html).toContain('role="img"');
        expect(html).toContain('aria-label="18 of 31 done, 4 in progress, 2 stuck or paused"');
        expect(html).toContain('style="width:58%"');
        expect(html).toContain('style="width:13%"');
        expect(html).toContain('style="width:6%"');
        expect(textOf(html)).toContain("18 of 31 done");
      },
    ],
    [
      "a card without a description or activity time shows neither",
      { headline: null, lastActive: null, bar: null },
      (html) => {
        expect(textOf(html)).toBe("Finance app");
      },
    ],
  ];

  it.each(CASES)("renders %s", (_name, overrides, check) => {
    check(render(ProjectCard({ card: card(overrides) })));
  });

  it("gives the project grid's name lines their labels and links, including 'All projects'", () => {
    const html = page(busyView());
    const text = textOf(html);
    expect(text).toContain("Quiet this week: Garden lights");
    expect(text).toContain("Not started: Band website");
    expect(html).toContain('href="/projects/project-garden"');
    expect(text).toContain("All projects");
    expect(text).toContain("3 active");
  });
});

describe("SectionError", () => {
  it("shows the title, the short line, and a Try again that calls the retry once per press", () => {
    const onRetry = vi.fn();
    const tree = SectionError({ title: "Stuck", message: "GET /api/board returned 500", onRetry });
    const html = render(tree);
    expect(headings(html, 2)).toEqual(["Stuck"]);
    expect(textOf(html)).toBe("Stuck Couldn't load this just now. Try again");
    const [button] = findAllByType(tree, "button");
    (button!.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
