// The status block, rendered — the acceptance criteria as assertions.
//
// The block is called directly as a function and the element tree it
// returns is walked: this repo's harness runs `environment: "node"` with no
// DOM (`tests/helpers/react-element.ts`), which is exactly why the block is
// hook-free and prop-driven.
//
// What these tests are for, specifically: the criteria that this screen
// answers "why is this stuck" are all *rendering* claims — three blockers
// look different, four liveness values look different, an unowned item says
// so rather than going blank. None of those is provable from the
// derivations alone, because a block that computed the right answer and
// then rendered every case identically would pass every test in
// `item-detail-status.test.ts`.
import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { StatusBlock } from "@/components/item-detail/StatusBlock";
import { ChipLink } from "@/components/item-detail/ChipLink";
import { InlineEditField } from "@/components/item-detail/InlineEditField";
import { StateChip } from "@/components/chips/StateChip";
import { PriorityChip } from "@/components/chips/PriorityChip";
import { StalenessDot } from "@/components/chips/StalenessDot";
import { statusSummary, type StatusSummary } from "@/lib/item-detail/status";
import type { DetailAssignment, DetailHistoryEntry, DetailItem } from "@/lib/item-detail/types";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";

function item(overrides: Partial<DetailItem> = {}): DetailItem {
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
    ...overrides,
  };
}

function assignment(overrides: Partial<DetailAssignment> = {}): DetailAssignment {
  return {
    id: "asn-1",
    holderId: "agent-1",
    holderType: "agent",
    displayName: "A holder",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: "2026-01-01T00:00:00.000Z",
    machine: "a-machine",
    branch: null,
    worktree: null,
    model: null,
    effort: null,
    sessionId: "sess-1",
    rootSessionId: "sess-1",
    pid: null,
    claimedAt: "2026-01-01T00:00:00.000Z",
    releasedAt: null,
    ...overrides,
  };
}

function event(overrides: Partial<DetailHistoryEntry> = {}): DetailHistoryEntry {
  return {
    id: "1",
    ts: "2026-01-01T00:00:00.000Z",
    type: "checkpoint",
    actorType: "agent",
    actorId: null,
    sessionId: null,
    body: null,
    payload: null,
    headline: null,
    ...overrides,
  };
}

/** Renders the block over a detail built from the parts a test cares about. */
function render(parts: {
  item?: DetailItem;
  column?: "backlog" | "in_progress" | "waiting" | "completed";
  assignments?: readonly DetailAssignment[];
  previousHolders?: readonly DetailAssignment[];
  history?: readonly DetailHistoryEntry[];
  now?: number;
  edit?: import("@/lib/item-detail/edit-state").ItemEditProps;
}) {
  const detail = {
    item: parts.item ?? item(),
    assignments: parts.assignments ?? [],
    previousHolders: parts.previousHolders ?? [],
    history: parts.history ?? [],
  };
  const now = parts.now ?? Date.parse("2026-01-01T00:00:00.000Z");
  return StatusBlock({
    item: detail.item,
    column: parts.column ?? "in_progress",
    status: statusSummary(detail, now),
    now,
    edit: parts.edit,
  });
}

/** Every string and number in the tree, flattened — what a reader would see. */
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

/** The single element carrying `prop`, whatever its type — or throws. */
function oneWithProp(root: ReactNode, prop: string): ReactElement {
  const matches = [...walk(root)].filter(
    (el) => (el.props as Record<string, unknown>)[prop] !== undefined,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one element with ${prop}, found ${matches.length}.`);
  }
  return matches[0]!;
}

function propsOf(el: ReactElement): Record<string, unknown> {
  return el.props as Record<string, unknown>;
}

describe("StatusBlock — what is it", () => {
  it("shows state, priority, column and kind as chips", () => {
    const element = render({ column: "waiting" });
    expect(findAllByType(element, StateChip)).toHaveLength(1);
    expect(findAllByType(element, PriorityChip)).toHaveLength(1);
    // The column's HUMAN title, not just the raw id — an attribute nobody
    // reads is not the column having reached the screen.
    expect(textOf(element)).toContain("Waiting");
  });

  it("suppresses a project's own state but still shows its column", () => {
    // DECISIONS.md §13c: a project's stored state is a creation leftover.
    const element = render({
      item: item({ kind: "project", state: "on_deck" }),
      column: "completed",
    });
    expect(findAllByType(element, StateChip)).toEqual([]);
    expect(textOf(element)).toContain("Completed");
  });

  it("passes the item's age to the staleness dot", () => {
    const element = render({
      item: item({ updatedAt: "2026-01-01T00:00:00.000Z" }),
      now: Date.parse("2026-01-05T00:00:00.000Z"),
    });
    const dot = findOneByType(element, StalenessDot);
    expect(propsOf(dot).ageMs).toBe(4 * 24 * 60 * 60 * 1000);
  });
});

describe("StatusBlock — ownership", () => {
  it("names the holder, the role, when they took it and when they were last active", () => {
    const element = render({
      assignments: [
        assignment({
          displayName: "Gary",
          role: "orchestrator",
          claimedAt: "2026-01-01T09:00:00.000Z",
          lastActive: "2026-01-01T11:30:00.000Z",
        }),
      ],
    });
    const text = textOf(element);
    expect(text).toContain("Gary");
    expect(text).toContain("orchestrator");
    expect(text).toContain("2026-01-01T09:00:00.000Z");
    expect(text).toContain("2026-01-01T11:30:00.000Z");
  });

  it("shows the machine, branch and model — where the work is happening", () => {
    const element = render({
      assignments: [
        assignment({ machine: "a-machine", branch: "feat/a-branch", model: "a-model" }),
      ],
    });
    const facts = textOf(oneWithProp(element, "data-facts"));
    expect(facts).toContain("a-machine");
    expect(facts).toContain("feat/a-branch");
    expect(facts).toContain("a-model");
  });

  it("omits a branch and model that were never recorded, rather than printing null", () => {
    const element = render({
      assignments: [assignment({ machine: "a-machine", branch: null, model: null })],
    });
    const facts = textOf(oneWithProp(element, "data-facts"));
    expect(facts).toBe("a-machine");
  });

  it("says nobody holds it — it does NOT render blank", () => {
    // An acceptance criterion, and the one a blank region fails silently:
    // nothing rendered is indistinguishable from a section that broke.
    const element = render({ assignments: [] });
    expect(textOf(element)).toContain("Nobody holds this");
    expect(propsOf(oneWithProp(element, "data-unowned"))["data-unowned"]).toBe(true);
  });

  it("renders a dead holder as a holder, not as an empty block", () => {
    // The other criterion. A dead claim is a hole in the fleet — the item
    // IS held, by a session that will never let go, which is very often the
    // whole answer to "why is this stuck".
    const element = render({
      assignments: [assignment({ displayName: "A gone agent", liveness: "dead" })],
    });
    const text = textOf(element);
    expect(text).toContain("A gone agent");
    expect(text).toContain("dead");
    expect(text).not.toContain("Nobody holds this");
  });

  it("shows every live holder when several hold it at once", () => {
    // An item can be held by an orchestrator and a builder at the same time
    // (SCHEMA.md §2), so a block that rendered only the first would hide
    // half the ownership.
    const element = render({
      assignments: [
        assignment({ id: "a", holderId: "h-1", displayName: "First", role: "orchestrator" }),
        assignment({ id: "b", holderId: "h-2", displayName: "Second", role: "builder" }),
      ],
    });
    const text = textOf(element);
    expect(text).toContain("First");
    expect(text).toContain("Second");
  });
});

describe("StatusBlock — liveness", () => {
  const values = ["running", "stalled", "dead", "superseded"] as const;

  it("renders all four values distinguishably — distinct class AND distinct word", () => {
    // The acceptance criterion. Class alone would let two values share a
    // word; word alone would let them share a shape. Both must differ.
    const classes = new Set<string>();
    const words = new Set<string>();
    for (const liveness of values) {
      const element = render({ assignments: [assignment({ liveness })] });
      const dot = oneWithProp(element, "data-liveness");
      classes.add(String(propsOf(dot).className));
      words.add(textOf(element).match(/running|stalled|dead|superseded/)?.[0] ?? "");
    }
    expect(classes.size).toBe(4);
    expect(words.size).toBe(4);
  });

  it("gives superseded its own treatment rather than the dead one", () => {
    const superseded = oneWithProp(
      render({ assignments: [assignment({ liveness: "superseded" })] }),
      "data-liveness",
    );
    const dead = oneWithProp(
      render({ assignments: [assignment({ liveness: "dead" })] }),
      "data-liveness",
    );
    expect(propsOf(superseded).className).not.toBe(propsOf(dead).className);
  });

  it("names the liveness in the accessible label, not colour alone", () => {
    const dot = oneWithProp(
      render({ assignments: [assignment({ displayName: "Gary", liveness: "stalled" })] }),
      "data-liveness",
    );
    expect(propsOf(dot)["aria-label"]).toBe("Gary is stalled");
    expect(propsOf(dot).role).toBe("img");
  });
});

describe("StatusBlock — earlier holders", () => {
  it("renders released holders as history, with their release times", () => {
    // The acceptance criterion — "who had this before it stalled" is
    // unanswerable without the release time: it is what separates a
    // handover an hour ago from one three weeks ago.
    const element = render({
      previousHolders: [
        assignment({
          id: "old-1",
          holderId: "h-old",
          displayName: "An earlier holder",
          releasedAt: "2026-01-01T08:00:00.000Z",
        }),
      ],
    });
    const text = textOf(element);
    expect(text).toContain("An earlier holder");
    expect(text).toContain("2026-01-01T08:00:00.000Z");
    expect(
      propsOf(oneWithProp(element, "data-previous-holder-id"))["data-previous-holder-id"],
    ).toBe("h-old");
  });

  it("does not render the earlier-holders region when there are none", () => {
    const element = render({ previousHolders: [] });
    expect(
      [...walk(element)].filter((el) => propsOf(el)["data-region"] === "previous-holders"),
    ).toEqual([]);
  });

  it("says so when a released holder has no release time recorded", () => {
    // Rather than printing "released null", or silently omitting the holder.
    const element = render({
      previousHolders: [
        assignment({ id: "old-1", displayName: "Nameless exit", releasedAt: null }),
      ],
    });
    const text = textOf(element);
    expect(text).toContain("Nameless exit");
    expect(text).toContain("release time not recorded");
    expect(text).not.toContain("null");
  });

  it("keeps earlier holders separate from the live one", () => {
    const element = render({
      assignments: [assignment({ id: "live", holderId: "h-live", displayName: "Current" })],
      previousHolders: [
        assignment({
          id: "old",
          holderId: "h-old",
          displayName: "Earlier",
          releasedAt: "2026-01-01T08:00:00.000Z",
        }),
      ],
    });
    expect(propsOf(oneWithProp(element, "data-holder-id"))["data-holder-id"]).toBe("h-live");
    expect(
      propsOf(oneWithProp(element, "data-previous-holder-id"))["data-previous-holder-id"],
    ).toBe("h-old");
  });
});

describe("StatusBlock — blocked on", () => {
  function blockedElement(overrides: Partial<DetailItem>) {
    return render({ item: item({ state: "blocked", ...overrides }) });
  }

  it("renders the three kinds with three different treatments", () => {
    // THE acceptance criterion — a sibling surface routes a person's queue
    // off this distinction, so the three must not collapse into one banner.
    const kinds = ["person", "external_process", "time"] as const;
    const classes = new Set<string>();
    const labels = new Set<string>();
    for (const blockedOnType of kinds) {
      const element = blockedElement({ blockedOnType });
      const region = oneWithProp(element, "data-blocked-on-type");
      classes.add(String(propsOf(region).className));
      labels.add(textOf(region));
    }
    expect(classes.size).toBe(3);
    expect(labels.size).toBe(3);
  });

  it("marks a person block with the person who must act", () => {
    const element = blockedElement({ blockedOnType: "person", blockedOnPersonId: "p-1" });
    expect(propsOf(oneWithProp(element, "data-blocked-on-type"))["data-blocked-on-type"]).toBe(
      "person",
    );
    expect(textOf(element)).toContain("p-1");
  });

  it("shows when a time block lifts", () => {
    const element = blockedElement({
      blockedOnType: "time",
      unblockAt: "2026-02-01T00:00:00.000Z",
    });
    const text = textOf(element);
    expect(text).toContain("Unblocks");
    expect(text).toContain("2026-02-01T00:00:00.000Z");
  });

  it("says a time block was DUE when its moment has already passed", () => {
    // Past its own unblock time and still blocked is not "waiting" — it is
    // "the clock ran out and nothing picked this up", which is a different
    // fact and the more urgent one.
    const element = render({
      item: item({
        state: "blocked",
        blockedOnType: "time",
        unblockAt: "2026-01-01T00:00:00.000Z",
      }),
      now: Date.parse("2026-01-09T00:00:00.000Z"),
    });
    expect(textOf(element)).toContain("Was due");
  });

  it("does not name a person or a clock on an external-process block", () => {
    const element = blockedElement({
      blockedOnType: "external_process",
      blockedOnPersonId: "p-1",
      unblockAt: "2026-02-01T00:00:00.000Z",
    });
    const text = textOf(element);
    expect(text).not.toContain("p-1");
    expect(text).not.toContain("2026-02-01T00:00:00.000Z");
  });

  it("marks an unrecorded blocker as its own case, not as one of the three", () => {
    const element = blockedElement({ blockedOnType: null, blockedReason: "something vague" });
    const region = oneWithProp(element, "data-blocked-on-type");
    expect(propsOf(region)["data-blocked-on-type"]).toBe("unspecified");
    expect(textOf(region)).toContain("something vague");
  });

  it("renders no blocked region at all on an item that is not blocked", () => {
    const element = render({ item: item({ state: "executing", blockedReason: "stale" }) });
    expect(
      [...walk(element)].filter((el) => propsOf(el)["data-blocked-on-type"] !== undefined),
    ).toEqual([]);
  });
});

describe("StatusBlock — checkpoint", () => {
  it("shows the latest checkpoint's headline", () => {
    const element = render({
      history: [event({ id: "2", headline: "waiting on the migration" })],
    });
    expect(textOf(element)).toContain("waiting on the migration");
  });

  it("says there is none rather than rendering blank", () => {
    const element = render({ history: [] });
    expect(textOf(element)).toContain("No checkpoint yet");
  });
});

describe("StatusBlock — open loops", () => {
  it("renders an open loop", () => {
    const element = render({
      history: [
        event({ id: "1", type: "open_loop", payload: { loopId: "l-1", text: "the retry path" } }),
      ],
    });
    expect(textOf(element)).toContain("the retry path");
    expect(propsOf(oneWithProp(element, "data-loop-id"))["data-loop-id"]).toBe("l-1");
  });

  it("does NOT render a closed loop", () => {
    // The acceptance criterion's other half. A block that rendered every
    // `open_loop` event would pass the test above and fail this one.
    const element = render({
      history: [
        event({ id: "1", type: "open_loop", payload: { loopId: "l-1", text: "resolved thing" } }),
        event({ id: "2", type: "open_loop_closed", payload: { loopId: "l-1" } }),
      ],
    });
    expect(textOf(element)).not.toContain("resolved thing");
    expect([...walk(element)].filter((el) => propsOf(el)["data-loop-id"] !== undefined)).toEqual(
      [],
    );
  });

  it("shows when a loop was opened", () => {
    const element = render({
      history: [
        event({
          id: "1",
          type: "open_loop",
          ts: "2026-01-01T07:00:00.000Z",
          payload: { loopId: "l-1", text: "a loose end" },
        }),
      ],
    });
    expect(textOf(element)).toContain("2026-01-01T07:00:00.000Z");
  });

  it("says there are none rather than rendering blank", () => {
    expect(textOf(render({ history: [] }))).toContain("No open loops");
  });
});

describe("StatusBlock — the empty item", () => {
  it("renders every region for an item with no assignment, no blocker and no history", () => {
    // The whole block must survive the emptiest possible item: this is the
    // state a freshly-minted item is in, and a block that threw on it would
    // take out the detail page for every new item.
    const element = render({});
    const regions = [...walk(element)]
      .map((el) => propsOf(el)["data-region"])
      .filter((r): r is string => typeof r === "string");
    expect(regions).toContain("ownership");
    expect(regions).toContain("checkpoint");
    expect(regions).toContain("open-loops");
    const text = textOf(element);
    expect(text).toContain("Nobody holds this");
    expect(text).toContain("No checkpoint yet");
    expect(text).toContain("No open loops");
  });
});

describe("StatusBlock — chip links back to a filtered board (M10 T10)", () => {
  // `ChipLink` is its own component and this harness does not render — it
  // walks the tree a component RETURNED without calling nested component
  // functions (`tests/helpers/react-element.ts`'s own header). A
  // `<ChipLink href="…">` therefore appears in the tree as an unrendered
  // *reference* whose `href` prop is what the assertion has to read, not
  // the `<a>` it would produce if actually rendered — the same reasoning
  // `item-detail-panels-component.test.ts`'s `textOf` gives for reading a
  // `<Markdown>`'s `source` prop directly.
  function hrefsOf(root: ReactNode): string[] {
    return findAllByType(root, ChipLink)
      .map((el) => (el.props as { href?: string }).href)
      .filter((href): href is string => typeof href === "string");
  }

  it("links the state chip to /board?state=<value>", () => {
    const element = render({ item: item({ state: "blocked" }) });
    expect(hrefsOf(element)).toContain("/board?state=blocked");
  });

  it("links the priority chip to /board?priority=<value>", () => {
    const element = render({ item: item({ priority: "P0" }) });
    expect(hrefsOf(element)).toContain("/board?priority=P0");
  });

  it("links the area to /board?area=<value>", () => {
    const element = render({ item: item({ area: "billing" }) });
    expect(hrefsOf(element)).toContain("/board?area=billing");
  });

  it("links a holder's name to /board?assignee=<holderId>, not their display name", () => {
    // assignee matches a live assignment's holderId exactly (get-board.ts);
    // a link built from displayName instead would 404-equivalent (filter
    // to nothing) the moment the two differ, which they legitimately can
    // for a person.
    const element = render({
      assignments: [assignment({ holderId: "person-42", displayName: "Alex Rivera" })],
    });
    expect(hrefsOf(element)).toContain("/board?assignee=person-42");
  });
});

describe("StatusBlock — priority and area inline edit (M10 T10)", () => {
  it("shows an Edit control for priority and area when onStartEdit is wired", () => {
    const element = render({ edit: { onStartEdit: () => {} } });
    const buttons = [...walk(element)].filter((el) => el.type === "button");
    const labels = buttons.map((b) => (b.props as { "aria-label"?: string })["aria-label"]);
    expect(labels).toContain("Edit priority");
    expect(labels).toContain("Edit area");
  });

  it("shows no Edit control when onStartEdit is absent", () => {
    const element = render({});
    const buttons = [...walk(element)].filter((el) => el.type === "button");
    const labels = buttons.map((b) => (b.props as { "aria-label"?: string })["aria-label"]);
    expect(labels).not.toContain("Edit priority");
    expect(labels).not.toContain("Edit area");
  });

  it("hands InlineEditField the priority kind, editing, and the draft while priority is the editing field", () => {
    // `InlineEditField` is its own component (see the note above `hrefsOf`)
    // — what StatusBlock actually decides is which PROPS it hands that
    // component, which is what this asserts directly rather than walking
    // for the `<select>` its own render would produce.
    const element = render({ edit: { editingField: "priority", draft: "P1" } });
    const fields = findAllByType(element, InlineEditField);
    const priorityField = fields.find((f) => (f.props as { kind?: string }).kind === "priority");
    expect(priorityField).toBeDefined();
    expect((priorityField!.props as { editing?: boolean }).editing).toBe(true);
    expect((priorityField!.props as { draft?: string }).draft).toBe("P1");
    // And the chip is NOT also rendered — the two must not overlap.
    expect(findAllByType(element, PriorityChip)).toEqual([]);
  });

  it("hands InlineEditField the area's draft while area is the editing field", () => {
    const element = render({ edit: { editingField: "area", draft: "billing" } });
    const fields = findAllByType(element, InlineEditField);
    const areaField = fields.find((f) => (f.props as { label?: string }).label === "Area");
    expect(areaField).toBeDefined();
    expect((areaField!.props as { editing?: boolean }).editing).toBe(true);
    expect((areaField!.props as { draft?: string }).draft).toBe("billing");
  });

  it("passes onSaveEdit through to the priority field's onSave", () => {
    let saved = false;
    const element = render({
      edit: { editingField: "priority", draft: "P1", onSaveEdit: () => (saved = true) },
    });
    const fields = findAllByType(element, InlineEditField);
    const priorityField = fields.find((f) => (f.props as { kind?: string }).kind === "priority");
    (priorityField!.props as { onSave?: () => void }).onSave?.();
    expect(saved).toBe(true);
  });
});

describe("statusSummary — the shape the block is handed", () => {
  it("is what the block renders from, so the two cannot disagree", () => {
    // A guard on the contract rather than on behaviour: if the block ever
    // starts deriving something inline, this summary stops being the whole
    // input and the tests above stop covering what is on screen.
    const summary: StatusSummary = statusSummary(
      { item: item(), assignments: [], previousHolders: [], history: [] },
      0,
    );
    expect(Object.keys(summary).sort()).toEqual(
      ["ageMs", "blocked", "checkpoint", "holders", "loops", "previousHolders", "unowned"].sort(),
    );
  });
});
