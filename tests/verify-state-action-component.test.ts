// `VerifyStateAction` — MILESTONES.md #131's "confirm state" action.
// Hook-free and prop-driven — `tests/helpers/react-element.ts`.
import { describe, expect, it, vi } from "vitest";
import { VerifyStateAction, bodyFor } from "@/components/item-detail/VerifyStateAction";
import { findAllByType, walk } from "./helpers/react-element";
import type { ReactNode } from "react";

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

describe("VerifyStateAction", () => {
  // The task brief's own requirement: say the refusal BEFORE it happens.
  it("disables the action outright when there is no commit to check against, and says why", () => {
    const element = VerifyStateAction({
      tipCommitSha: null,
      status: { status: "idle" },
      onConfirm: vi.fn(),
    });
    expect(findAllByType(element, "button")).toHaveLength(0);
    expect(textOf(element)).toContain("no commit artifact recorded");
  });

  it("offers two outcome buttons when a tip commit exists", () => {
    const element = VerifyStateAction({
      tipCommitSha: "abc123",
      status: { status: "idle" },
      onConfirm: vi.fn(),
    });
    const buttons = findAllByType(element, "button");
    expect(buttons).toHaveLength(2);
  });

  // Fails if the click handler is wired to the wrong outcome, or not passed through at all.
  it("calls onConfirm with the outcome the reader clicked", () => {
    const onConfirm = vi.fn();
    const element = VerifyStateAction({
      tipCommitSha: "abc123",
      status: { status: "idle" },
      onConfirm,
    });
    const buttons = findAllByType(element, "button") as {
      props: { onClick?: () => void; "data-verify-outcome": string };
    }[];
    const agrees = buttons.find((b) => b.props["data-verify-outcome"] === "agrees")!;
    agrees.props.onClick!();
    expect(onConfirm).toHaveBeenCalledWith("agrees");

    const disagrees = buttons.find((b) => b.props["data-verify-outcome"] === "disagrees")!;
    disagrees.props.onClick!();
    expect(onConfirm).toHaveBeenCalledWith("disagrees");
  });

  it("disables both buttons while a submission is in flight", () => {
    const element = VerifyStateAction({
      tipCommitSha: "abc123",
      status: { status: "submitting" },
      onConfirm: vi.fn(),
    });
    const buttons = findAllByType(element, "button") as { props: { disabled?: boolean } }[];
    expect(buttons.every((b) => b.props.disabled)).toBe(true);
  });

  it("shows a confirmation once the write lands", () => {
    const element = VerifyStateAction({
      tipCommitSha: "abc123",
      status: { status: "done" },
      onConfirm: vi.fn(),
    });
    expect(textOf(element)).toContain("Recorded");
  });

  it("shows the server's refusal text, never a generic message, when the write fails", () => {
    const element = VerifyStateAction({
      tipCommitSha: "abc123",
      status: { status: "error", message: "An artifact must record who produced it." },
      onConfirm: vi.fn(),
    });
    expect(textOf(element)).toContain("An artifact must record who produced it.");
  });

  // Never overstates what the record does — see the component's own header.
  it("never claims the record changes the item's state or satisfies a merge review", () => {
    const element = VerifyStateAction({
      tipCommitSha: "abc123",
      status: { status: "idle" },
      onConfirm: vi.fn(),
    });
    const text = textOf(element);
    expect(text).toContain("does not by itself change the item's state or satisfy a merge review");
  });
});

describe("bodyFor", () => {
  // Fails if the two outcomes produce the same body, or either loses the state it names.
  it("states which outcome was found, naming the checked state", () => {
    expect(bodyFor("agrees", "executing")).toContain("matches");
    expect(bodyFor("agrees", "executing")).toContain("executing");
    expect(bodyFor("disagrees", "executing")).toContain("NOT");
    expect(bodyFor("disagrees", "executing")).toContain("executing");
  });

  it("produces two genuinely different bodies for the two outcomes", () => {
    expect(bodyFor("agrees", "executing")).not.toBe(bodyFor("disagrees", "executing"));
  });
});
