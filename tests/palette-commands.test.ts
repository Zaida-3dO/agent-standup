// The palette's contents and its matching rule — `@/lib/palette/commands`.
//
// The assertion that matters most here is the last one: the "change state"
// verb must send `expectedFrom`. The row calls that out because without it
// the palette races exactly as an undo without a precondition would — a
// move made against a page rendered a minute ago silently overwrites
// whatever another session did in between.
import { describe, expect, it } from "vitest";
import {
  baseCommands,
  commandsFor,
  matchCommands,
  stateChangeRequest,
  stateCommands,
  stateLabel,
  type Command,
} from "@/lib/palette/commands";
import { ITEM_STATES } from "@/lib/service/state-machine/states";
import { NAV_ROUTES } from "@/lib/nav/routes";

describe("baseCommands", () => {
  it("offers one Go-to row per destination, pointing at the real href", () => {
    const gotos = baseCommands().filter((command) => command.intent.kind === "navigate");
    expect(gotos).toHaveLength(NAV_ROUTES.length);
    for (const route of NAV_ROUTES) {
      const match = gotos.find(
        (command) => command.intent.kind === "navigate" && command.intent.href === route.href,
      );
      expect(match, `no palette row navigates to ${route.href}`).toBeDefined();
      expect(match?.label).toBe(`Go to ${route.label}`);
    }
  });

  it("offers create and help, whatever the route map holds", () => {
    const kinds = baseCommands().map((command) => command.intent.kind);
    expect(kinds).toContain("create");
    expect(kinds).toContain("help");
  });
});

describe("stateCommands", () => {
  it("offers every state the state machine has, bar the one the item is in", () => {
    const commands = stateCommands("executing");
    // Every state to every other state is permitted, so the only exclusion
    // is the no-op. Asserting the exact count catches both a state being
    // dropped and the filter excluding more than it should.
    expect(commands).toHaveLength(ITEM_STATES.length - 1);
    const offered = commands.map((command) =>
      command.intent.kind === "change-state" ? command.intent.to : null,
    );
    expect(offered).not.toContain("executing");
    expect(offered).toContain("merged");
    expect(offered).toContain("cancelled");
  });

  it("offers all of them when the item's state is unknown", () => {
    // `null` means the read failed; there is no state to exclude.
    expect(stateCommands(null)).toHaveLength(ITEM_STATES.length);
  });

  it("is offered only with an item in context", () => {
    const withoutItem = commandsFor({ itemId: null, itemState: "executing" });
    expect(withoutItem.some((command) => command.intent.kind === "change-state")).toBe(false);

    const withItem = commandsFor({ itemId: "item-1", itemState: "executing" });
    expect(withItem.some((command) => command.intent.kind === "change-state")).toBe(true);
  });
});

describe("stateLabel", () => {
  it("reads a snake_case state as words", () => {
    // Both underscores, not just the first — `research_done` has one but a
    // future two-underscore value would expose a non-global replace.
    expect(stateLabel("plan_review")).toBe("plan review");
    expect(stateLabel("a_b_c")).toBe("a b c");
  });
});

describe("matchCommands", () => {
  const table: readonly Command[] = [
    { id: "a", label: "Go to Board", group: "Go to", intent: { kind: "navigate", href: "/board" } },
    {
      id: "b",
      label: "Create an item",
      group: "Actions",
      keywords: ["new"],
      intent: { kind: "create" },
    },
  ];

  it("returns everything for an empty or whitespace query, so the palette browses", () => {
    expect(matchCommands(table, "")).toHaveLength(2);
    expect(matchCommands(table, "   ")).toHaveLength(2);
  });

  it("matches on the label, case-insensitively", () => {
    const found = matchCommands(table, "BOARD");
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("a");
  });

  it("matches on a keyword the label does not contain", () => {
    // "new" appears nowhere in "Create an item", so a label-only match
    // would return nothing here.
    const found = matchCommands(table, "new");
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("b");
  });

  it("returns nothing for a query that matches neither", () => {
    expect(matchCommands(table, "zzz")).toHaveLength(0);
  });

  it("keeps registry order rather than ranking", () => {
    // Both rows contain an "a". Order is the table's, which is what makes
    // the selection index mean something stable.
    const found = matchCommands(table, "a");
    expect(found.map((command) => command.id)).toEqual(["a", "b"]);
  });
});

describe("stateChangeRequest — the precondition", () => {
  it("sends expectedFrom as the state the item was read in", () => {
    // The single most important assertion in this file. A body without
    // `expectedFrom` is last-writer-wins: the server would apply the move
    // whatever the item's current state, silently overwriting a concurrent
    // session's write.
    const body = stateChangeRequest("merged", "in_review");
    expect(body).toEqual({ to: "merged", expectedFrom: "in_review" });
  });

  it("does not confuse the two ends of the move", () => {
    // A transposed implementation (`{ to: from, expectedFrom: to }`) would
    // satisfy a test that only checked both keys were present.
    const body = stateChangeRequest("merged", "in_review");
    expect(body.to).toBe("merged");
    expect(body.expectedFrom).toBe("in_review");
    expect(body.to).not.toBe(body.expectedFrom);
  });
});
