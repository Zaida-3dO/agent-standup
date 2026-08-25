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

  it("gives every row a distinct id", () => {
    // The id is what React keys the list on and what a test names a row by.
    // Two rows sharing one would make the second unreachable in both.
    const ids = baseCommands().map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id !== "")).toBe(true);
  });
});

describe("the synonyms a person actually reaches for", () => {
  // Exercised through `matchCommands`, which is how a person meets them —
  // asserting the `keywords` array directly would pass whether or not the
  // matcher ever consulted it.
  const all = baseCommands();

  /** The ids a query surfaces from the real command list. */
  function idsFor(query: string): readonly string[] {
    return matchCommands(all, query).map((command) => command.id);
  }

  it("finds the standup page by the word home, which its label does not contain", () => {
    // "Go to Standup" contains no "home". Only the keyword can match it.
    const standup = all.find((command) => command.id === "go-standup");
    expect(standup?.label).not.toContain("home");
    expect(idsFor("home")).toContain("go-standup");
  });

  it("does not attach the home synonym to every other destination", () => {
    // The condition is `route.id === "standup"`. Inverting or truthifying it
    // would make every Go-to row answer to "home".
    const found = idsFor("home");
    expect(found).toEqual(["go-standup"]);
  });

  it("finds create by new, add and mint", () => {
    for (const word of ["new", "add", "mint"]) {
      expect(idsFor(word), `"${word}" should reach the create row`).toContain("create");
    }
  });

  it("finds the help sheet by keys", () => {
    const help = all.find((command) => command.id === "help");
    expect(help?.label).not.toContain("keys");
    expect(idsFor("keys")).toContain("help");
  });

  it("finds a state row by move and by transition", () => {
    const withItem = commandsFor({ itemId: "item-1", itemState: "executing" });
    for (const word of ["move", "transition"]) {
      const found = matchCommands(withItem, word).map((command) => command.id);
      expect(found, `"${word}" should reach the state rows`).toContain("state-merged");
    }
  });

  it("finds a state row by the state's own value", () => {
    // `merged` is in the label too, but `plan_review` is not — the label
    // reads "plan review", so only the keyword carries the raw value.
    const withItem = commandsFor({ itemId: "item-1", itemState: "executing" });
    const found = matchCommands(withItem, "plan_review").map((command) => command.id);
    expect(found).toEqual(["state-plan_review"]);
  });

  it("gives every state row a distinct id naming its own state", () => {
    for (const command of stateCommands("executing")) {
      if (command.intent.kind !== "change-state") throw new Error("expected a state row");
      expect(command.id).toBe(`state-${command.intent.to}`);
    }
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

  it("returns the very same list on an empty query, rather than a filtered copy", () => {
    // The guard is `if (needle === "") return commands`. Removing it would
    // still return both rows here — every string contains "" — so a length
    // check alone cannot tell the guard from its absence. Identity can.
    expect(matchCommands(table, "")).toBe(table);
  });

  it("matches a row with no keywords at all", () => {
    // `command.keywords ?? []` is the only thing standing between an
    // undefined `keywords` and a thrown `.some` of undefined.
    const noKeywords: readonly Command[] = [
      { id: "bare", label: "Bare row", group: "Actions", intent: { kind: "create" } },
    ];
    expect(matchCommands(noKeywords, "bare").map((c) => c.id)).toEqual(["bare"]);
    expect(matchCommands(noKeywords, "zzz")).toHaveLength(0);
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
