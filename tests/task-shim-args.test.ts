// MILESTONES.md #39's own argument parser (`src/lib/task-shim/args.ts`),
// deliberately not `src/lib/cli/args.ts` — see that file's header for why.
import { describe, expect, it } from "vitest";
import { parseShimArgs } from "@/lib/task-shim/args";

describe("parseShimArgs", () => {
  it("reads a bare command with nothing after it", () => {
    expect(parseShimArgs(["list"])).toEqual({ command: "list", rest: [], flags: {} });
  });

  it("splits positional words from flags", () => {
    const parsed = parseShimArgs(["update", "T-1", "--title", "Renamed"]);
    expect(parsed).toEqual({ command: "update", rest: ["T-1"], flags: { title: "Renamed" } });
  });

  it("reads several flags in one call", () => {
    const parsed = parseShimArgs(["create", "--title", "T", "--body", "B", "--area", "web"]);
    expect(parsed.flags).toEqual({ title: "T", body: "B", area: "web" });
  });

  it("does not let a bare flag swallow the flag after it", () => {
    // `--body --area web`: `--body` has no value of its own here, so it must
    // become an empty string, not silently consume "--area" as its value and
    // lose the area flag entirely.
    const parsed = parseShimArgs(["create", "--body", "--area", "web"]);
    expect(parsed.flags).toEqual({ body: "", area: "web" });
  });

  it("reads a trailing bare flag as an empty string, not the next word", () => {
    const parsed = parseShimArgs(["show", "T-1", "--title"]);
    expect(parsed.flags).toEqual({ title: "" });
  });

  it("returns undefined for the command when argv is empty", () => {
    expect(parseShimArgs([]).command).toBeUndefined();
  });

  it("keeps multiple positional words in order", () => {
    const parsed = parseShimArgs(["status", "T-1", "in-progress"]);
    expect(parsed.rest).toEqual(["T-1", "in-progress"]);
  });
});
