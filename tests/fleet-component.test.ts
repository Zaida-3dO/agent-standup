// The fleet page's components (M10 T16), called as functions and their
// returned element trees inspected (`tests/helpers/react-element.ts`).
//
// **What would make this file hollow.** Asserting a table renders SOMETHING
// proves nothing. The assertions that matter, named per test:
//
//   - all four liveness groups render even when a group is empty (the
//     failure mode #123 named for board columns, reachable here too),
//   - sweep's global scope is stated in words BEFORE the confirm click,
//     not just implied by a button label,
//   - the sweep result reports what was actually released, not a guess,
//   - a dead-but-unswept row is visibly flagged rather than looking like
//     ordinary live work.
import { describe, expect, it } from "vitest";
import { FleetView, type FleetLoadState } from "@/components/fleet/FleetView";
import { FleetRow } from "@/components/fleet/FleetRow";
import { SweepControl } from "@/components/fleet/SweepControl";
import { TakeoverDialog } from "@/components/fleet/TakeoverDialog";
import { AgentPresenceDot } from "@/components/chips/AgentPresenceDot";
import { NO_FLEET_FILTERS } from "@/lib/fleet/view";
import type { FleetAssignment } from "@/lib/fleet/types";
import { findAllByType, walk } from "./helpers/react-element";

function assignment(overrides: Partial<FleetAssignment> = {}): FleetAssignment {
  return {
    holderId: "gary",
    holderType: "agent",
    displayName: "Gary",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: "2026-08-18T10:00:00.000Z",
    id: "asn-1",
    machine: "calliope",
    branch: "feat/x",
    worktree: "/wt/x",
    model: "sonnet",
    effort: "medium",
    sessionId: "sess-1",
    rootSessionId: "sess-1",
    pid: 123,
    claimedAt: "2026-08-18T09:00:00.000Z",
    releasedAt: null,
    itemId: "item-1",
    itemTitle: "Ship the thing",
    itemKind: "task",
    itemState: "executing",
    ...overrides,
  };
}

function textOf(root: unknown): string {
  const parts: string[] = [];
  for (const el of walk(root as never)) {
    const children = (el.props as { children?: unknown }).children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

const baseViewProps = {
  now: NOW,
  deadAfterSeconds: 1800,
  filters: NO_FLEET_FILTERS,
  onFiltersChange: () => {},
  sweepConfirming: false,
  sweepRunning: false,
  sweepLastResult: null,
  sweepErrorMessage: null,
  onOpenSweepConfirm: () => {},
  onCancelSweepConfirm: () => {},
  onConfirmSweep: () => {},
  takeover: null,
  onStartTakeover: () => {},
  onTakeoverReasonChange: () => {},
  onCancelTakeover: () => {},
  onConfirmTakeover: () => {},
};

describe("FleetView — loading and error", () => {
  it("shows the loading state before the fleet arrives", () => {
    const loadState: FleetLoadState = { status: "loading" };
    const element = FleetView({ ...baseViewProps, loadState });
    const loading = [...walk(element)].find((el) => (el.props as { label?: string }).label);
    expect(loading).toBeDefined();
    expect((loading!.props as { label: string }).label).toBe("the fleet");
  });

  it("hands the failing read's message to the shared error state", () => {
    const loadState: FleetLoadState = {
      status: "error",
      message: "Could not load the fleet (GET /api/fleet returned 500).",
    };
    const element = FleetView({ ...baseViewProps, loadState });
    const error = [...walk(element)].find((el) => (el.props as { message?: string }).message);
    expect((error!.props as { message: string }).message).toBe(
      "Could not load the fleet (GET /api/fleet returned 500).",
    );
  });
});

describe("FleetView — grouping, M10 T16's central requirement", () => {
  it("renders all four liveness groups even when three of them are empty", () => {
    // Breaks if: empty bands are filtered out of the render — a reader
    // asking "is anything dead" would then see no evidence either way.
    const loadState: FleetLoadState = {
      status: "loaded",
      assignments: [assignment({ liveness: "running" })],
    };
    const element = FleetView({ ...baseViewProps, loadState });
    const groupSections = [...walk(element)].filter(
      (el) => (el.props as { "data-liveness-group"?: string })["data-liveness-group"] !== undefined,
    );
    expect(
      groupSections.map(
        (el) => (el.props as { "data-liveness-group": string })["data-liveness-group"],
      ),
    ).toEqual(["running", "stalled", "dead", "superseded"]);
  });

  it("hands one FleetRow per assignment, distinguishing all four liveness values", () => {
    // `FleetRow` renders its own `AgentPresenceDot` (proved in the FleetRow
    // describe block below); at this layer what matters is that FleetView
    // hands every assignment through, in its own liveness, rather than
    // dropping or re-labelling any of the four values.
    const loadState: FleetLoadState = {
      status: "loaded",
      assignments: [
        assignment({ id: "a1", liveness: "running" }),
        assignment({ id: "a2", liveness: "stalled" }),
        assignment({ id: "a3", liveness: "dead" }),
        assignment({ id: "a4", liveness: "superseded" }),
      ],
    };
    const element = FleetView({ ...baseViewProps, loadState });
    const rows = findAllByType(element, FleetRow);
    expect(
      rows.map((r) => (r.props as { assignment: FleetAssignment }).assignment.liveness).sort(),
    ).toEqual(["dead", "running", "stalled", "superseded"]);
  });

  it("narrows to the filtered rows, and offers to clear the filter when it hides everything", () => {
    const loadState: FleetLoadState = {
      status: "loaded",
      assignments: [assignment({ machine: "clyde" })],
    };
    const element = FleetView({
      ...baseViewProps,
      loadState,
      filters: { machine: "calliope", agent: null },
    });
    const empty = [...walk(element)].find(
      (el) => (el.props as { kind?: string }).kind === "filtered",
    );
    expect(empty).toBeDefined();
    expect((empty!.props as { onClearFilter?: unknown }).onClearFilter).toBeDefined();
  });

  it("shows a genuinely-empty message, not a filtered one, when nothing is live at all", () => {
    const loadState: FleetLoadState = { status: "loaded", assignments: [] };
    const element = FleetView({ ...baseViewProps, loadState });
    const empty = [...walk(element)].find((el) => (el.props as { kind?: string }).kind === "empty");
    expect(empty).toBeDefined();
    expect((empty!.props as { title?: string }).title).toBe("Nothing is live right now");
  });
});

describe("FleetRow — the dead-but-unswept flag", () => {
  it("flags a row that is overdue for sweep", () => {
    const row = FleetRow({
      assignment: assignment({ liveness: "running" }),
      now: NOW,
      overdueForSweep: true,
    });
    expect((row.props as { "data-overdue"?: unknown })["data-overdue"]).toBe(true);
    expect(textOf(row)).toContain("overdue for sweep");
  });

  it("does not flag an ordinary live row", () => {
    const row = FleetRow({
      assignment: assignment({ liveness: "running" }),
      now: NOW,
      overdueForSweep: false,
    });
    expect((row.props as { "data-overdue"?: unknown })["data-overdue"]).toBe(false);
    expect(textOf(row)).not.toContain("overdue for sweep");
  });

  it("shows the takeover control only when a handler is given", () => {
    const withHandler = FleetRow({
      assignment: assignment(),
      now: NOW,
      overdueForSweep: false,
      onTakeover: () => {},
    });
    expect(textOf(withHandler)).toContain("Take over");

    const without = FleetRow({ assignment: assignment(), now: NOW, overdueForSweep: false });
    expect(textOf(without)).not.toContain("Take over");
  });

  it("renders its own presence dot, carrying the assignment's liveness through unchanged", () => {
    for (const liveness of ["running", "stalled", "dead", "superseded"] as const) {
      const row = FleetRow({
        assignment: assignment({ liveness }),
        now: NOW,
        overdueForSweep: false,
      });
      const dot = findAllByType(row, AgentPresenceDot);
      expect(dot).toHaveLength(1);
      expect((dot[0]!.props as { liveness: string }).liveness).toBe(liveness);
    }
  });
});

describe("SweepControl — sweep's global scope must be unmissable BEFORE the click", () => {
  it("says nothing about scope until the confirm is opened", () => {
    const control = SweepControl({
      liveCount: 42,
      confirming: false,
      running: false,
      lastResult: null,
      errorMessage: null,
      onOpenConfirm: () => {},
      onCancelConfirm: () => {},
      onConfirmSweep: () => {},
    });
    expect(textOf(control)).not.toMatch(/whole board/i);
  });

  it("states the whole-board scope in words once the confirm is open, naming the live count", () => {
    // Breaks if: the confirm text is generic ("Are you sure?") rather than
    // naming the scope — this is the exact requirement the task states
    // twice: "the UI must make that scope unmistakable before the click".
    const control = SweepControl({
      liveCount: 42,
      confirming: true,
      running: false,
      lastResult: null,
      errorMessage: null,
      onOpenConfirm: () => {},
      onCancelConfirm: () => {},
      onConfirmSweep: () => {},
    });
    const text = textOf(control);
    expect(text).toMatch(/whole board/i);
    // "not this item or this filter" appears deliberately, as the contrast
    // that makes the whole-board scope concrete — so the negative check is
    // that the WHOLE-BOARD framing wins, not that the words never appear.
    expect(text).toMatch(/not this item|not this filter/i);
    expect(text).toContain("42");
  });

  it("reports exactly how many claims a completed sweep released", () => {
    const control = SweepControl({
      liveCount: 10,
      confirming: false,
      running: false,
      lastResult: {
        checkedAt: "2026-08-18T12:00:00.000Z",
        moves: [{ assignmentId: "a1", itemId: "i1", from: "running", to: "dead" }],
        released: ["a1", "a2", "a3"],
      },
      errorMessage: null,
      onOpenConfirm: () => {},
      onCancelConfirm: () => {},
      onConfirmSweep: () => {},
    });
    const text = textOf(control);
    expect(text).toContain("3");
    expect(text).toContain("released");
  });

  it("invokes onConfirmSweep, not onOpenConfirm, from the confirm dialog's own button", () => {
    let opened = 0;
    let confirmed = 0;
    const control = SweepControl({
      liveCount: 1,
      confirming: true,
      running: false,
      lastResult: null,
      errorMessage: null,
      onOpenConfirm: () => {
        opened++;
      },
      onCancelConfirm: () => {},
      onConfirmSweep: () => {
        confirmed++;
      },
    });
    const buttons = [...walk(control)].filter((el) => el.type === "button");
    const confirmButton = buttons.find((b) => textOf(b).includes("Sweep the whole board"));
    expect(confirmButton).toBeDefined();
    (confirmButton!.props as { onClick: () => void }).onClick();
    expect(confirmed).toBe(1);
    expect(opened).toBe(0);
  });
});

describe("TakeoverDialog — the targeted, per-row alternative to sweep", () => {
  it("names the item and the holder being displaced", () => {
    const dialog = TakeoverDialog({
      assignment: assignment({ itemTitle: "Fix the thing", displayName: "Priya" }),
      reason: "",
      submitting: false,
      errorMessage: null,
      onReasonChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    });
    const text = textOf(dialog);
    expect(text).toContain("Fix the thing");
    expect(text).toContain("Priya");
  });

  it("carries the typed reason through onReasonChange", () => {
    let seen = "";
    const dialog = TakeoverDialog({
      assignment: assignment(),
      reason: "",
      submitting: false,
      errorMessage: null,
      onReasonChange: (reason) => {
        seen = reason;
      },
      onCancel: () => {},
      onConfirm: () => {},
    });
    const textarea = [...walk(dialog)].find((el) => el.type === "textarea")!;
    (textarea.props as { onChange: (e: unknown) => void }).onChange({
      target: { value: "the person running this told me to" },
    });
    expect(seen).toBe("the person running this told me to");
  });

  it("shows the server's refusal message when one is given", () => {
    const dialog = TakeoverDialog({
      assignment: assignment(),
      reason: "",
      submitting: false,
      errorMessage: "DANGEROUS: this holder may still be alive and working.",
      onReasonChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    });
    expect(textOf(dialog)).toContain("DANGEROUS: this holder may still be alive and working.");
  });
});
