// One tag when the area and the repo name the same thing.
//
// The pure half of the dedupe; `board-view-component.test.ts` proves the
// board card uses it. Pure module, no database: this file never skips.
import { describe, expect, it } from "vitest";
import { repoDuplicatesArea, showRepoTag } from "@/lib/design/repo-tag";

describe("repoDuplicatesArea", () => {
  it("is true for the same name", () => {
    expect(repoDuplicatesArea("web", "web")).toBe(true);
  });

  it("ignores case, spaces, hyphens and underscores", () => {
    expect(repoDuplicatesArea("Web Platform", "web-platform")).toBe(true);
    expect(repoDuplicatesArea("web_platform", "WebPlatform")).toBe(true);
  });

  it("keeps two genuinely different names apart", () => {
    // Breaks if: the comparison becomes a prefix or substring match.
    expect(repoDuplicatesArea("web", "web-api")).toBe(false);
    expect(repoDuplicatesArea("infra", "web")).toBe(false);
  });

  it("is false when there is no repo", () => {
    expect(repoDuplicatesArea("web", null)).toBe(false);
    expect(repoDuplicatesArea("web", undefined)).toBe(false);
    expect(repoDuplicatesArea("web", "")).toBe(false);
  });
});

describe("showRepoTag", () => {
  it("shows a repo that differs from the area", () => {
    expect(showRepoTag("web", "infra")).toBe(true);
  });

  it("hides a repo that repeats the area", () => {
    expect(showRepoTag("web", "web")).toBe(false);
  });

  it("hides a missing repo", () => {
    expect(showRepoTag("web", null)).toBe(false);
  });
});
