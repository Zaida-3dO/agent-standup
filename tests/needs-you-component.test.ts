// The `/needs-you` components. Hook-free and prop-driven (see each
// component's header), so they're called directly as functions and their
// returned element trees inspected — same technique as
// `tests/board-view-component.test.ts` and `tests/board-column-bounded.test.ts`
// (which is also where the "find the shared state component by type and
// assert on its props, don't grep for text" convention comes from).
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
    ...overrides,
  };
}

describe("NeedsYouRow — the decide affordance", () => {
  it("shows Approve/Deny for a plan_review item, and calls back with the item id", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const tree = NeedsYouRow({
      item: item({ id: "item-x", reason: "plan_review" }),
      now: Date.now(),
      deciding: false,
      onApprove,
      onDeny,
    });
    const buttons = findAllByType(tree, "button");
    expect(buttons).toHaveLength(2);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onApprove).toHaveBeenCalledWith("item-x");
    (buttons[1]!.props as { onClick: () => void }).onClick();
    expect(onDeny).toHaveBeenCalledWith("item-x");
  });

  it("disables both buttons while a decision is in flight for this item", () => {
    const tree = NeedsYouRow({
      item: item({ reason: "needs_approval" }),
      now: Date.now(),
      deciding: true,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
    });
    const buttons = findAllByType(tree, "button");
    for (const button of buttons) {
      expect((button.props as { disabled?: boolean }).disabled).toBe(true);
    }
  });

  it("offers no Approve/Deny for blocked_on_you — only a link to the item", () => {
    const tree = NeedsYouRow({
      item: item({ reason: "blocked_on_you" }),
      now: Date.now(),
      deciding: false,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
    });
    expect(findAllByType(tree, "button")).toHaveLength(0);
    // The title and the "Open item" link both go to the bare item — there
    // is no review artifact for a blocked_on_you row to deep-link into.
    const links = findAllByType(tree, Link);
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect((link.props as { href: string }).href).toBe("/items/item-a");
    }
  });

  it("links every affordance on a decidable row to the item's Reviews tab, never the bare item", () => {
    const tree = NeedsYouRow({
      item: item({ id: "item-y", reason: "plan_review" }),
      now: Date.now(),
      deciding: false,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
    });
    // A decidable row carries two links (the title, and "See findings") —
    // both must point at the Reviews tab, so approving is never one click
    // away from the findings behind it.
    const links = findAllByType(tree, Link);
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect((link.props as { href: string }).href).toBe("/items/item-y#reviews");
    }
  });
});

describe("NeedsYouInboxView — load branches and ordering", () => {
  it("hands the error message to ErrorState on a failed load", () => {
    const tree = NeedsYouInboxView({
      loadState: { status: "error", message: "the API said no" },
      now: Date.now(),
      decidingId: null,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
      decideError: null,
    });
    const error = findOneByType(tree, ErrorState);
    expect((error.props as { message: string }).message).toBe("the API said no");
  });

  it("shows the empty state when the loaded list is empty", () => {
    const tree = NeedsYouInboxView({
      loadState: { status: "loaded", items: [], total: [].length },
      now: Date.now(),
      decidingId: null,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
      decideError: null,
    });
    const empty = findOneByType(tree, EmptyState);
    expect((empty.props as { kind: string }).kind).toBe("empty");
    expect(findAllByType(tree, NeedsYouRow)).toHaveLength(0);
  });

  it("orders the loaded list oldest-first", () => {
    const newer = item({ id: "newer", updatedAt: "2026-08-18T12:00:00.000Z" });
    const older = item({ id: "older", updatedAt: "2026-08-18T08:00:00.000Z" });
    const tree = NeedsYouInboxView({
      loadState: { status: "loaded", items: [newer, older], total: 2 },
      now: Date.now(),
      decidingId: null,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
      decideError: null,
    });
    const rows = findAllByType(tree, NeedsYouRow);
    expect(rows.map((row) => (row.props as { item: NeedsYouItem }).item.id)).toEqual([
      "older",
      "newer",
    ]);
  });

  it("passes decidingId through so only the matching row is disabled", () => {
    const a = item({ id: "a", reason: "plan_review", updatedAt: "2026-08-18T08:00:00.000Z" });
    const b = item({ id: "b", reason: "plan_review", updatedAt: "2026-08-18T09:00:00.000Z" });
    const tree = NeedsYouInboxView({
      loadState: { status: "loaded", items: [a, b], total: 2 },
      now: Date.now(),
      decidingId: "a",
      onApprove: vi.fn(),
      onDeny: vi.fn(),
      decideError: null,
    });
    const rows = findAllByType(tree, NeedsYouRow);
    const byId = new Map(rows.map((row) => [(row.props as { item: NeedsYouItem }).item.id, row]));
    expect((byId.get("a")!.props as { deciding: boolean }).deciding).toBe(true);
    expect((byId.get("b")!.props as { deciding: boolean }).deciding).toBe(false);
  });

  it("surfaces a decision failure above the list without discarding what loaded", () => {
    const tree = NeedsYouInboxView({
      loadState: { status: "loaded", items: [item()], total: 1 },
      now: Date.now(),
      decidingId: null,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
      decideError: "Could not record the approval.",
    });
    expect(findAllByType(tree, NeedsYouRow)).toHaveLength(1);
    // The failure text itself lives directly in the view's own tree (not a
    // shared component), so it is asserted on the raw props of the <p> that
    // carries it.
    const alerts = findAllByType(tree, "p").filter(
      (el) => (el.props as { role?: string }).role === "alert",
    );
    expect(alerts).toHaveLength(1);
    expect((alerts[0]!.props as { children: string }).children).toBe(
      "Could not record the approval.",
    );
  });
});
