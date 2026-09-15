// The `/needs-you` components. Hook-free and prop-driven (see each
// component's header), so they're called directly as functions and their
// returned element trees inspected — same technique as
// `tests/board-view-component.test.ts` and `tests/board-column-bounded.test.ts`
// (which is also where the "find the shared state component by type and
// assert on its props, don't grep for text" convention comes from).
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import Link from "next/link";
import { NeedsYouInboxView } from "@/components/needs-you/NeedsYouInboxView";
import { NeedsYouRow } from "@/components/needs-you/NeedsYouRow";
import { EmptyState } from "@/components/states/EmptyState";
import { ErrorState } from "@/components/states/ErrorState";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import { findAllByType, findOneByType } from "./helpers/react-element";

function item(overrides: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: "item-a",
    title: "Item A",
    headline: null,
    state: "blocked",
    reason: "blocked_on_you",
    blockedReason: null,
    updatedAt: "2026-08-18T10:00:00.000Z",
    mergeAuthority: "agent_judgement",
    needsVisualReview: false,
    tipCommitSha: null,
    ...overrides,
  };
}

/** The row's callback props, all stubbed — a test overrides only what it asserts on. */
function rowProps(overrides: Partial<Parameters<typeof NeedsYouRow>[0]> = {}) {
  return {
    item: item(),
    now: Date.now(),
    busy: false,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onAnswer: vi.fn(),
    onGrantStanding: vi.fn(),
    replyText: "",
    standingPending: false,
    onStandingPendingChange: () => {},
    onReplyTextChange: vi.fn(),
    ...overrides,
  };
}

/** The view's props, all stubbed. */
function viewProps(overrides: Partial<Parameters<typeof NeedsYouInboxView>[0]> = {}) {
  return {
    loadState: { status: "loaded", items: [], total: 0 } as const,
    now: Date.now(),
    busyId: null,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onAnswer: vi.fn(),
    onGrantStanding: vi.fn(),
    replyTexts: {},
    standingPending: {},
    onStandingPendingChange: () => {},
    onReplyTextChange: vi.fn(),
    respondError: null,
    respondNotice: null,
    ...overrides,
  };
}

/** Every `<button>` in the tree, by its rendered label. */
function buttonLabels(tree: ReactNode): string[] {
  return findAllByType(tree, "button").map((button) =>
    String((button.props as { children: unknown }).children),
  );
}

describe("NeedsYouRow — the control matches the reason", () => {
  it("offers approve and reject for plan_review, calling back with the item id", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const tree = NeedsYouRow(
      rowProps({
        item: item({ id: "item-x", reason: "plan_review", state: "plan_review" }),
        onApprove,
        onReject,
      }),
    );

    const buttons = findAllByType(tree, "button");
    expect(buttons).toHaveLength(2);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onApprove).toHaveBeenCalledWith("item-x");
    (buttons[1]!.props as { onClick: () => void }).onClick();
    expect(onReject).toHaveBeenCalledWith("item-x");
  });

  it("offers no reject button for needs_approval — an approval is withheld, not refused", () => {
    const tree = NeedsYouRow(
      rowProps({
        item: item({
          reason: "needs_approval",
          state: "in_review",
          mergeAuthority: "needs_approval",
          tipCommitSha: "abc1234def",
        }),
      }),
    );

    const labels = buttonLabels(tree);
    // The approve button and the standing-grant link-button, and nothing
    // that would record a rejecting row in a person's name.
    expect(labels).toContain("Approve merge");
    expect(labels.some((label) => /reject|deny|request changes/i.test(label))).toBe(false);
  });

  it("names the act on the button rather than a generic Approve", () => {
    const visual = NeedsYouRow(
      rowProps({
        item: item({ reason: "needs_visual_review", state: "in_review", tipCommitSha: "abc1234" }),
      }),
    );
    expect(buttonLabels(visual)).toContain("Looks right");

    const merge = NeedsYouRow(
      rowProps({
        item: item({ reason: "needs_approval", state: "in_review", tipCommitSha: "abc1234" }),
      }),
    );
    expect(buttonLabels(merge)).toContain("Approve merge");
  });

  it("disables the row's controls while a response is in flight for it", () => {
    const tree = NeedsYouRow(
      rowProps({
        item: item({ reason: "needs_approval", state: "in_review", tipCommitSha: "abc1234" }),
        busy: true,
      }),
    );
    for (const button of findAllByType(tree, "button")) {
      expect((button.props as { disabled?: boolean }).disabled).toBe(true);
    }
  });

  it("offers no decision button when the item has no commit to pin an approval to", () => {
    const tree = NeedsYouRow(
      rowProps({
        item: item({ reason: "needs_approval", state: "in_review", tipCommitSha: null }),
      }),
    );
    // The standing grant remains (it pins no commit); what must not appear
    // is an approve button that could only fail server-side.
    expect(buttonLabels(tree)).not.toContain("Approve merge");
  });

  it("explains the missing approval where the button would have been", () => {
    // A withheld control leaves a gap, and a gap is something the reader has
    // to interpret. The explanation stands in the action cluster rather than
    // elsewhere on the row, so the answer is where the question is.
    const tree = NeedsYouRow(
      rowProps({
        item: item({ reason: "needs_approval", state: "in_review", tipCommitSha: null }),
      }),
    );
    const texts = findAllByType(tree, "span").map((el) =>
      JSON.stringify((el.props as { children: unknown }).children),
    );
    expect(texts.some((text) => /no commit recorded yet/i.test(text))).toBe(true);
  });

  it("shows the short sha a decision will be recorded against", () => {
    const tree = NeedsYouRow(
      rowProps({
        item: item({
          reason: "needs_approval",
          state: "in_review",
          tipCommitSha: "a1b2c3d4e5f6a7b8",
        }),
      }),
    );
    const spans = findAllByType(tree, "span").map((el) =>
      String((el.props as { children: unknown }).children),
    );
    expect(spans.some((text) => text.includes("a1b2c3d"))).toBe(true);
  });
});

describe("NeedsYouRow — the standing grant is a separate, quieter act", () => {
  it("offers it only for needs_approval, where a merge hold exists to lift", () => {
    const withHold = NeedsYouRow(
      rowProps({
        item: item({ reason: "needs_approval", state: "in_review", tipCommitSha: "abc1234" }),
      }),
    );
    expect(buttonLabels(withHold).some((label) => /always approve/i.test(label))).toBe(true);

    const withoutHold = NeedsYouRow(
      rowProps({
        item: item({ reason: "needs_visual_review", state: "in_review", tipCommitSha: "abc1234" }),
      }),
    );
    expect(buttonLabels(withoutHold).some((label) => /always approve/i.test(label))).toBe(false);
  });

  it("is a different control from approve, and says so", () => {
    const onApprove = vi.fn();
    const onGrantStanding = vi.fn();
    const onStandingPendingChange = vi.fn();
    const tree = NeedsYouRow(
      rowProps({
        item: item({ id: "item-z", reason: "needs_approval", tipCommitSha: "abc1234" }),
        onApprove,
        onGrantStanding,
        onStandingPendingChange,
      }),
    );

    const standing = findAllByType(tree, "button").find((button) =>
      /always approve/i.test(String((button.props as { children: unknown }).children)),
    );
    (standing!.props as { onClick: () => void }).onClick();

    // The first click ARMS the confirm step rather than granting. Clicking
    // the standing grant must never also record a one-off approval: they are
    // different acts and conflating them would grant far more than the
    // reader intended.
    expect(onStandingPendingChange).toHaveBeenCalledWith("item-z", true);
    expect(onGrantStanding).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  // The HIGH finding from the visual review (artifact `5a1fd673`): with no
  // commit to approve, the standing grant is the ONLY control on the row —
  // so the broadest, least reversible decision was also the quietest thing
  // on the card, and looked like the links beside it.
  it("does not grant on a single click — it asks first", () => {
    const onGrantStanding = vi.fn();
    const tree = NeedsYouRow(
      rowProps({
        item: item({ id: "item-z", reason: "needs_approval", tipCommitSha: null }),
        onGrantStanding,
      }),
    );

    for (const button of findAllByType(tree, "button")) {
      (button.props as { onClick: () => void }).onClick();
    }

    // Nothing on the unconfirmed row can reach the grant. Removing the
    // confirm step passes every other case in this file and fails this one.
    expect(onGrantStanding).not.toHaveBeenCalled();
  });

  it("grants only from the confirm step, and names what is being granted", () => {
    const onGrantStanding = vi.fn();
    const tree = NeedsYouRow(
      rowProps({
        item: item({
          id: "item-z",
          title: "Ship the thing",
          reason: "needs_approval",
          tipCommitSha: "abc1234",
        }),
        standingPending: true,
        onGrantStanding,
      }),
    );

    const confirm = findAllByType(tree, "button").find((button) =>
      /yes, always approve/i.test(String((button.props as { children: unknown }).children)),
    );
    expect(confirm).toBeDefined();
    (confirm!.props as { onClick: () => void }).onClick();
    expect(onGrantStanding).toHaveBeenCalledWith("item-z");
  });

  it("offers a way back out of the confirm step", () => {
    // A confirm step with no cancel is a trap rather than a guard.
    const onStandingPendingChange = vi.fn();
    const onGrantStanding = vi.fn();
    const tree = NeedsYouRow(
      rowProps({
        item: item({ id: "item-z", reason: "needs_approval", tipCommitSha: "abc1234" }),
        standingPending: true,
        onStandingPendingChange,
        onGrantStanding,
      }),
    );

    const cancel = findAllByType(tree, "button").find((button) =>
      /cancel/i.test(String((button.props as { children: unknown }).children)),
    );
    (cancel!.props as { onClick: () => void }).onClick();

    expect(onStandingPendingChange).toHaveBeenCalledWith("item-z", false);
    expect(onGrantStanding).not.toHaveBeenCalled();
  });

  it("keeps the unconfirmed prompt off the row until it is armed", () => {
    // The confirm prompt must not be present-but-hidden: this harness reads
    // the element tree, and a row that always rendered the confirm buttons
    // would let the cases above pass while showing both states at once.
    const tree = NeedsYouRow(
      rowProps({
        item: item({ id: "item-z", reason: "needs_approval", tipCommitSha: "abc1234" }),
        standingPending: false,
      }),
    );
    const labels = buttonLabels(tree);
    expect(labels.some((label) => /yes, always approve/i.test(label))).toBe(false);
    expect(labels.some((label) => /cancel/i.test(label))).toBe(false);
  });

  it("still disables every control while a response is in flight", () => {
    // Including the confirm step, which is the most consequential one here.
    const tree = NeedsYouRow(
      rowProps({
        item: item({ reason: "needs_approval", tipCommitSha: "abc1234" }),
        standingPending: true,
        busy: true,
      }),
    );
    for (const button of findAllByType(tree, "button")) {
      expect((button.props as { disabled?: boolean }).disabled).toBe(true);
    }
  });
});

describe("NeedsYouRow — blocked_on_you gets a reply, not a decision", () => {
  it("renders a reply box and sends its text", () => {
    const onAnswer = vi.fn();
    const tree = NeedsYouRow(
      rowProps({
        item: item({ id: "item-q", reason: "blocked_on_you" }),
        replyText: "Yes, go with the second option.",
        onAnswer,
      }),
    );

    expect(findAllByType(tree, "textarea")).toHaveLength(1);
    const send = findAllByType(tree, "button").find((button) =>
      /send/i.test(String((button.props as { children: unknown }).children)),
    );
    (send!.props as { onClick: () => void }).onClick();
    expect(onAnswer).toHaveBeenCalledWith("item-q");
  });

  it("disables sending an empty reply", () => {
    const tree = NeedsYouRow(
      rowProps({ item: item({ reason: "blocked_on_you" }), replyText: "   " }),
    );
    const send = findAllByType(tree, "button").find((button) =>
      /send/i.test(String((button.props as { children: unknown }).children)),
    );
    expect((send!.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it("reports typing back to the container, which owns the text", () => {
    const onReplyTextChange = vi.fn();
    const tree = NeedsYouRow(
      rowProps({ item: item({ id: "item-q", reason: "blocked_on_you" }), onReplyTextChange }),
    );
    const textarea = findOneByType(tree, "textarea");
    (textarea.props as { onChange: (e: unknown) => void }).onChange({
      target: { value: "typed" },
    });
    expect(onReplyTextChange).toHaveBeenCalledWith("item-q", "typed");
  });

  it("links to the bare item — there is no review artifact to deep-link into", () => {
    const tree = NeedsYouRow(rowProps({ item: item({ reason: "blocked_on_you" }) }));
    for (const link of findAllByType(tree, Link)) {
      expect((link.props as { href: string }).href).toBe("/items/item-a");
    }
  });

  it("offers no approve or reject control at all", () => {
    const tree = NeedsYouRow(rowProps({ item: item({ reason: "blocked_on_you" }) }));
    const labels = buttonLabels(tree);
    expect(labels.some((label) => /approve|reject|looks right/i.test(label))).toBe(false);
  });
});

describe("NeedsYouRow — decision rows link to their findings", () => {
  it("points every link on a decision row at the Reviews tab", () => {
    const tree = NeedsYouRow(
      rowProps({
        item: item({ id: "item-y", reason: "plan_review", state: "plan_review" }),
      }),
    );
    const links = findAllByType(tree, Link);
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect((link.props as { href: string }).href).toBe("/items/item-y#reviews");
    }
  });
});

describe("NeedsYouInboxView — load branches and ordering", () => {
  it("hands the error message to ErrorState on a failed load", () => {
    const tree = NeedsYouInboxView(
      viewProps({ loadState: { status: "error", message: "the API said no" } }),
    );
    const error = findOneByType(tree, ErrorState);
    expect((error.props as { message: string }).message).toBe("the API said no");
  });

  it("shows the empty state when the loaded list is empty", () => {
    const tree = NeedsYouInboxView(viewProps());
    const empty = findOneByType(tree, EmptyState);
    expect((empty.props as { kind: string }).kind).toBe("empty");
    expect(findAllByType(tree, NeedsYouRow)).toHaveLength(0);
  });

  it("orders the loaded list oldest-first", () => {
    const newer = item({ id: "newer", updatedAt: "2026-08-18T12:00:00.000Z" });
    const older = item({ id: "older", updatedAt: "2026-08-18T08:00:00.000Z" });
    const tree = NeedsYouInboxView(
      viewProps({ loadState: { status: "loaded", items: [newer, older], total: 2 } }),
    );
    const rows = findAllByType(tree, NeedsYouRow);
    expect(rows.map((row) => (row.props as { item: NeedsYouItem }).item.id)).toEqual([
      "older",
      "newer",
    ]);
  });

  it("passes busyId through so only the matching row is disabled", () => {
    const a = item({ id: "a", reason: "plan_review", updatedAt: "2026-08-18T08:00:00.000Z" });
    const b = item({ id: "b", reason: "plan_review", updatedAt: "2026-08-18T09:00:00.000Z" });
    const tree = NeedsYouInboxView(
      viewProps({ loadState: { status: "loaded", items: [a, b], total: 2 }, busyId: "a" }),
    );
    const rows = findAllByType(tree, NeedsYouRow);
    const byId = new Map(rows.map((row) => [(row.props as { item: NeedsYouItem }).item.id, row]));
    expect((byId.get("a")!.props as { busy: boolean }).busy).toBe(true);
    expect((byId.get("b")!.props as { busy: boolean }).busy).toBe(false);
  });

  it("gives each row its own reply text, keyed by item id", () => {
    const a = item({ id: "a", updatedAt: "2026-08-18T08:00:00.000Z" });
    const b = item({ id: "b", updatedAt: "2026-08-18T09:00:00.000Z" });
    const tree = NeedsYouInboxView(
      viewProps({
        loadState: { status: "loaded", items: [a, b], total: 2 },
        replyTexts: { a: "answer for a" },
      }),
    );
    const rows = findAllByType(tree, NeedsYouRow);
    const byId = new Map(rows.map((row) => [(row.props as { item: NeedsYouItem }).item.id, row]));
    expect((byId.get("a")!.props as { replyText: string }).replyText).toBe("answer for a");
    // Absent rather than leaking the neighbour's draft.
    expect((byId.get("b")!.props as { replyText: string }).replyText).toBe("");
  });

  it("surfaces a failure above the list without discarding what loaded", () => {
    const tree = NeedsYouInboxView(
      viewProps({
        loadState: { status: "loaded", items: [item()], total: 1 },
        respondError: "Could not record the approval.",
      }),
    );
    expect(findAllByType(tree, NeedsYouRow)).toHaveLength(1);
    const alerts = findAllByType(tree, "p").filter(
      (el) => (el.props as { role?: string }).role === "alert",
    );
    expect(alerts).toHaveLength(1);
    expect((alerts[0]!.props as { children: string }).children).toBe(
      "Could not record the approval.",
    );
  });

  it("confirms a response that landed — a vanished row alone reads as a no-op", () => {
    const tree = NeedsYouInboxView(
      viewProps({
        loadState: { status: "loaded", items: [item()], total: 1 },
        respondNotice: "Merge approved — recorded against the commit.",
      }),
    );
    const notices = findAllByType(tree, "p").filter(
      (el) => (el.props as { role?: string }).role === "status",
    );
    expect(notices).toHaveLength(1);
    expect((notices[0]!.props as { children: string }).children).toBe(
      "Merge approved — recorded against the commit.",
    );
  });
});
