// `TrustBadge` — MILESTONES.md #131. Hook-free and prop-driven, called
// directly as a function (`tests/helpers/react-element.ts`).
import { describe, expect, it } from "vitest";
import { TrustBadge } from "@/components/chips/TrustBadge";
import { walk } from "./helpers/react-element";
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

describe("TrustBadge", () => {
  it("renders 'Imported' when unverified", () => {
    const badge = TrustBadge({ verified: false });
    expect(textOf(badge)).toContain("Imported");
    expect((badge.props as { "data-trust": string })["data-trust"]).toBe("unverified");
  });

  it("renders 'Verified' when a check is on file", () => {
    const badge = TrustBadge({
      verified: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      checkedByType: "agent",
    });
    expect(textOf(badge)).toContain("Verified");
    expect((badge.props as { "data-trust": string })["data-trust"]).toBe("verified");
  });

  // Fails if the aria-label loses the "Trust:" prefix or the label word.
  it("carries an accessible label naming the trust state", () => {
    const badge = TrustBadge({ verified: false });
    expect((badge.props as { "aria-label": string })["aria-label"]).toBe("Trust: Imported");
  });

  // Fails if the title stops mentioning who checked, e.g. drops checkedByType.
  it("names who checked in the title when verified by a person", () => {
    const badge = TrustBadge({
      verified: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      checkedByType: "person",
    });
    expect((badge.props as { title: string }).title).toContain("a person");
  });

  it("names an agent check distinctly from a person check", () => {
    const badge = TrustBadge({
      verified: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      checkedByType: "agent",
    });
    expect((badge.props as { title: string }).title).toContain("an agent");
  });
});
