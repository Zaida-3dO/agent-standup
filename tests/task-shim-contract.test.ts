// MILESTONES.md #39 — the shape this surface keeps unchanged. These tests
// are the ones that make "unchanged" a checked claim rather than a
// description: the vocabulary is exactly five words, the projected shape is
// exactly six fields, and nothing from the richer item record leaks through.
import { describe, expect, it } from "vitest";
import { STATUS_REMAP } from "@/lib/import-items";
import {
  SHIM_STATUSES,
  isShimStatus,
  stateForStatus,
  statusForState,
  toShimTask,
} from "@/lib/task-shim/contract";

describe("SHIM_STATUSES stays in sync with the source store's own vocabulary", () => {
  it("is exactly the keys STATUS_REMAP (#10) uses, in the same set", () => {
    expect(new Set(SHIM_STATUSES)).toEqual(new Set(Object.keys(STATUS_REMAP)));
  });

  it("is exactly five statuses — this surface's vocabulary is deliberately narrow", () => {
    expect(SHIM_STATUSES).toHaveLength(5);
  });
});

describe("isShimStatus", () => {
  it.each(SHIM_STATUSES)("accepts %s", (status) => {
    expect(isShimStatus(status)).toBe(true);
  });

  it.each(["on_deck", "executing", "bogus", "", "TODO", "done "])("refuses %j", (value) => {
    expect(isShimStatus(value)).toBe(false);
  });
});

describe("stateForStatus", () => {
  it.each(SHIM_STATUSES)("maps %s to STATUS_REMAP's own value", (status) => {
    expect(stateForStatus(status)).toBe(STATUS_REMAP[status]);
  });

  it("maps done to merged specifically", () => {
    expect(stateForStatus("done")).toBe("merged");
  });

  it("maps waiting to paused, not blocked", () => {
    // DECISIONS.md/import-items.ts: the source has no separate "blocked"
    // signal, so its one waiting state remaps to `paused`. A shim that got
    // this backwards would route a `waiting` task at the wrong guard.
    expect(stateForStatus("waiting")).toBe("paused");
  });
});

describe("statusForState — the reverse mapping", () => {
  it.each(SHIM_STATUSES)("round-trips %s through its state and back", (status) => {
    expect(statusForState(stateForStatus(status))).toBe(status);
  });

  it("falls back to the raw state for a state outside the five-word vocabulary", () => {
    // `blocked` and `planning` exist in the item state machine but have no
    // word in this surface's vocabulary — the fallback is what keeps
    // `show`/`list` working for a task that has moved past what this
    // surface predates, rather than throwing or lying about its status.
    expect(statusForState("blocked")).toBe("blocked");
    expect(statusForState("planning")).toBe("planning");
  });
});

describe("toShimTask — the projection that makes this a shim, not an alias", () => {
  const richItem = {
    id: "item-1",
    title: "Get the thing working",
    body: "Some detail.",
    state: "executing",
    area: "web",
    repo: "web",
    // Everything below exists on a real item record and must not survive
    // the projection — a caller written against the five-field store this
    // surface fronts has no schema for any of it.
    priority: "P0",
    driveMode: "autonomous",
    mergeAuthority: "needs_approval",
    blockedReason: null,
    customFields: { legacy_id: "T-1" },
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("keeps exactly the six old fields, nothing else", () => {
    const task = toShimTask(richItem);
    expect(Object.keys(task).sort()).toEqual(["area", "body", "id", "repo", "status", "title"]);
  });

  it("translates state into this surface's five-word status vocabulary", () => {
    expect(toShimTask(richItem).status).toBe("in-progress");
  });

  it("passes id, title, body and area through verbatim", () => {
    const task = toShimTask(richItem);
    expect(task.id).toBe("item-1");
    expect(task.title).toBe("Get the thing working");
    expect(task.body).toBe("Some detail.");
    expect(task.area).toBe("web");
  });

  it("reports repo as null when the item has none", () => {
    const task = toShimTask({ ...richItem, repo: null });
    expect(task.repo).toBeNull();
  });

  it("passes an unmapped state through raw rather than inventing a status", () => {
    const task = toShimTask({ ...richItem, state: "blocked" });
    expect(task.status).toBe("blocked");
  });

  it("defaults missing or wrongly-typed fields rather than throwing", () => {
    const task = toShimTask({ id: "item-2" });
    expect(task).toEqual({ id: "item-2", title: "", body: "", status: "", repo: null, area: "" });
  });
});
