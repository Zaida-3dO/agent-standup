// `src/lib/nav/redirects.ts` — where a folded route sends its reader.
import { describe, expect, it } from "vitest";
import { SINCE_REDIRECT_TARGET, redirectTargetIsRoutable } from "@/lib/nav/redirects";
import { NAV_ROUTES } from "@/lib/nav/routes";

describe("the /since redirect", () => {
  it("points at a destination the sidebar can actually reach", () => {
    // A redirect whose target is not a real route is a 404 reachable only
    // by following the redirect, so nothing surfaces it until a reader
    // hits it. Renaming `/activity` in NAV_ROUTES without updating this
    // constant fails here rather than in someone's browser.
    expect(redirectTargetIsRoutable(SINCE_REDIRECT_TARGET)).toBe(true);
    expect(NAV_ROUTES.some((route) => route.href === SINCE_REDIRECT_TARGET)).toBe(true);
  });

  it("sends the reader to the activity ledger", () => {
    // Both addresses name one read of one event stream, so `/since` folds
    // into the ledger rather than into an unrelated screen.
    expect(SINCE_REDIRECT_TARGET).toBe("/activity");
  });

  it("does not send the reader back to /since", () => {
    // A redirect to itself is an infinite loop, and it is one character
    // away in the source.
    expect(SINCE_REDIRECT_TARGET).not.toBe("/since");
  });
});

describe("redirectTargetIsRoutable", () => {
  it("rejects a path no destination declares", () => {
    expect(redirectTargetIsRoutable("/nowhere")).toBe(false);
  });
});
