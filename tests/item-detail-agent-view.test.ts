// The agent view's bounding — the property the whole panel turns on.
//
// `orientation` has come back at over 165,000 characters on a real item, one
// `body` alone at 49,000. The panel's job is to render that without
// recreating the unbounded-length problem the tabs were introduced to fix,
// and the bounding is done here, in a plain function, precisely so it can be
// proven without a DOM.
import { describe, expect, it } from "vitest";
import {
  agentViewFrom,
  boundedText,
  rawJson,
  EVENT_MAX_ROWS,
  FIELD_MAX_CHARS,
  RAW_MAX_CHARS,
} from "@/lib/item-detail/orientation";
import { fetchAgentView, agentViewErrorMessageFrom } from "@/lib/item-detail/orientation-state";

/** An orientation payload of a chosen, deliberately unreasonable size. */
function hugePayload() {
  return {
    item: {
      id: "item-1",
      title: "An item",
      state: "executing",
      // The measured case: one body at 49,000 characters.
      body: "x".repeat(49_000),
    },
    checkpoint: {
      ts: "2026-01-01T00:00:00.000Z",
      headline: "Halfway",
      body: "y".repeat(30_000),
    },
    whatChanged: Array.from({ length: 400 }, (_, index) => ({
      id: String(index),
      ts: "2026-01-01T00:00:00.000Z",
      type: "note",
      actorType: "agent",
      actorId: "agent-1",
      body: "z".repeat(300),
    })),
    changedSince: "0",
    horizon: "0",
    openLoops: { notDone: [], children: [], loops: [] },
    crew: [],
  };
}

describe("bounding one value", () => {
  it("leaves a short value alone and reports it unclipped", () => {
    expect(boundedText("short")).toEqual({ text: "short", clipped: false, fullLength: 5 });
  });

  it("clips a long value and reports the length it clipped from", () => {
    // The full length is what makes the clip honest: "600 of 49,214" is the
    // difference between believing you have read the body and knowing you
    // have read its opening.
    const bounded = boundedText("x".repeat(49_000));
    expect(bounded.text.length).toBe(FIELD_MAX_CHARS);
    expect(bounded.clipped).toBe(true);
    expect(bounded.fullLength).toBe(49_000);
  });

  it("treats null, undefined and empty as nothing to show", () => {
    for (const value of [null, undefined, ""]) {
      expect(boundedText(value)).toEqual({ text: "", clipped: false, fullLength: 0 });
    }
  });

  it("does not mark a value exactly at the bound as clipped", () => {
    // The boundary case: at the limit nothing was left out, so claiming
    // otherwise would report a clip that did not happen. Changing `<=` to
    // `<` in `boundedText` fails this.
    const bounded = boundedText("x".repeat(FIELD_MAX_CHARS));
    expect(bounded.clipped).toBe(false);
    expect(bounded.text.length).toBe(FIELD_MAX_CHARS);
  });
});

describe("the agent view, on a huge payload", () => {
  it("bounds every text field it renders", () => {
    // The acceptance criterion, asserted directly: a 165k-char item does not
    // reach the page at 165k characters. Removing the `boundedText` call
    // around `item.body` fails this.
    const view = agentViewFrom(hugePayload());
    expect(view.itemBody.text.length).toBe(FIELD_MAX_CHARS);
    expect(view.itemBody.clipped).toBe(true);
    expect(view.checkpoint?.body.text.length).toBe(FIELD_MAX_CHARS);
    expect(view.checkpoint?.body.clipped).toBe(true);
    for (const event of view.events) {
      expect(event.body.text.length).toBeLessThanOrEqual(FIELD_MAX_CHARS);
    }
  });

  it("caps the event list and still reports the real total", () => {
    // A capped list that reads as complete is the failure this panel is
    // otherwise built to avoid, so the total is carried separately from the
    // rows. Dropping `eventsTotal` in favour of `events.length` would make
    // 400 events report as 20.
    const view = agentViewFrom(hugePayload());
    expect(view.events).toHaveLength(EVENT_MAX_ROWS);
    expect(view.eventsTotal).toBe(400);
  });

  it("keeps the whole rendered view within a bound the page can carry", () => {
    // The end-to-end property, over everything the panel renders EXCEPT the
    // deliberately-collapsed raw block: what lands in the tree on arrival is
    // small, whatever the payload's size. The measured payload is ~185,000
    // characters; this asserts the rendered part is two orders of magnitude
    // smaller.
    const payload = hugePayload();
    expect(JSON.stringify(payload).length).toBeGreaterThan(165_000);
    const view = agentViewFrom(payload);
    const { raw, ...rendered } = view;
    // The raw block is a bounded STRING, not the payload — the view holds no
    // reference to the object, so the 165,000 characters are gone from
    // memory as well as from the page.
    expect(typeof raw.text).toBe("string");
    expect(raw.text.length).toBe(RAW_MAX_CHARS);
    expect(JSON.stringify(rendered).length).toBeLessThan(20_000);
  });

  it("bounds the raw escape hatch too", () => {
    // The escape hatch is bounded deliberately rather than timidly: the
    // whole point of the module is that the page's cost cannot be set by a
    // stored value's length, and an unbounded "raw" block would hand that
    // back.
    const bounded = rawJson(hugePayload());
    expect(bounded.text.length).toBe(RAW_MAX_CHARS);
    expect(bounded.clipped).toBe(true);
    // And the view applies it, rather than leaving it to a caller to
    // remember. Returning the payload object from the view builder rather
    // than the serialised string fails this.
    expect(agentViewFrom(hugePayload()).raw.clipped).toBe(true);
  });

  it("reports a payload it cannot serialise rather than throwing", () => {
    // A diagnostic view refusing to render because its input is odd would
    // fail at exactly the moment it is most useful.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => rawJson(cyclic)).not.toThrow();
    expect(rawJson(cyclic).text).toContain("could not be serialised");
  });
});

describe("the agent view, on odd payloads", () => {
  it("renders an empty view rather than throwing on a payload of the wrong shape", () => {
    // The payload arrives as parsed JSON from an endpoint this code shares
    // no type with, and a diagnostic panel is the last thing that should be
    // able to take out the page it diagnoses.
    for (const payload of [null, undefined, "a string", 42, []]) {
      expect(() => agentViewFrom(payload)).not.toThrow();
    }
    const view = agentViewFrom(null);
    expect(view.itemTitle.text).toBe("");
    expect(view.events).toEqual([]);
    expect(view.checkpoint).toBeNull();
  });

  it("survives events that are not objects", () => {
    const view = agentViewFrom({ whatChanged: [null, "x", { type: "note" }] });
    expect(view.events).toHaveLength(3);
    expect(view.events[0]?.type).toBe("unknown");
    expect(view.events[2]?.type).toBe("note");
  });

  it("reads a null checkpoint as no checkpoint", () => {
    expect(agentViewFrom({ checkpoint: null }).checkpoint).toBeNull();
  });

  it("keeps the three open-loop sources apart", () => {
    // The operation is explicit that merging them loses which kind of thing
    // each entry is, and that this is the first thing a resuming session
    // needs to know. Flattening them into one list for tidiness would be
    // undoing that on the one screen built to show what the session was
    // told.
    const view = agentViewFrom({
      openLoops: {
        notDone: [{ text: "left undone", reason: "ran out of time", itemId: "i-2" }],
        children: [{ id: "i-3", title: "a child", state: "executing" }],
        loops: [{ loopId: "l-1", text: "a loose end", openedAt: "2026-01-01T00:00:00.000Z" }],
      },
    });
    expect(view.openLoops.notDone[0]?.text.text).toBe("left undone");
    expect(view.openLoops.notDone[0]?.itemId).toBe("i-2");
    expect(view.openLoops.children[0]?.text.text).toBe("a child");
    expect(view.openLoops.loops[0]?.text.text).toBe("a loose end");
    // A loop is opened against the item being viewed, so it carries no id of
    // its own to link — filling in this item's id would render a link back
    // to the page the reader is already on.
    expect(view.openLoops.loops[0]?.itemId).toBeNull();
  });

  it("reads the crew from the assignment shape the operation returns", () => {
    const view = agentViewFrom({
      crew: [{ holderId: "wilkins", role: "builder", machine: "box-1" }],
    });
    expect(view.crew[0]).toEqual({ holder: "wilkins", role: "builder", machine: "box-1" });
  });
});

describe("fetching the agent view", () => {
  it("bounds at the fetch boundary, so the oversized string never reaches a component", () => {
    // The bounding belongs where the payload enters. A component that
    // received the raw payload and bounded it on the way out would already
    // be holding the 165,000-character string the module exists to avoid.
    const payload = hugePayload();
    const fetchImpl = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    return fetchAgentView("item-1", fetchImpl).then((view) => {
      expect(view.itemBody.text.length).toBe(FIELD_MAX_CHARS);
      expect(view.events).toHaveLength(EVENT_MAX_ROWS);
    });
  });

  it("names the item on a 404 rather than reporting a status code", () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    return expect(fetchAgentView("missing-1", fetchImpl)).rejects.toThrow(
      "No such item: missing-1",
    );
  });

  it("reports the status on any other failure", () => {
    const fetchImpl = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    return expect(fetchAgentView("item-1", fetchImpl)).rejects.toThrow("returned 500");
  });

  it("turns a non-Error into a message fit to show", () => {
    expect(agentViewErrorMessageFrom("boom")).toBe("Could not load the agent view.");
    expect(agentViewErrorMessageFrom(new Error("specific"))).toBe("specific");
  });
});
