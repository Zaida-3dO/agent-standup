// The stdio-only tool-description suffix (`@/lib/mcp/tools.ts`).
//
// A no-server installation's stdio session is unobserved by any server-side
// hook (`src/lib/hook/` flushes and asks over HTTP only) and has no other
// way to learn that. This row makes it discoverable from the one place
// every session reads regardless of how confused it is: the tool list
// itself. `tests/mcp-server.test.ts`'s "takes each tool's description from
// the operation's own summary" already pins the `mcp_http` case (unchanged,
// verbatim summary); this file is the stdio counterpart and the
// derived-not-listed property that has to survive both.
import { describe, expect, it } from "vitest";
import { defineOperation, listOperations, type AnyOperation } from "@/lib/service";
import { toolsFromOperations } from "@/lib/mcp";

const SAMPLE: AnyOperation = defineOperation({
  name: "sample_op",
  kind: "read",
  summary: "A sample operation's summary.",
  input: {} as never,
  async handler() {
    return {};
  },
});

describe("toolsFromOperations — the adapter-aware description suffix", () => {
  it("leaves the description exactly as the operation's summary when no adapter is given", () => {
    // The pre-adapter-awareness behaviour, still reachable — a caller
    // exercising the derivation in isolation (this file, others) must not
    // be forced to pick an adapter to get the operation's own words back.
    const [tool] = toolsFromOperations([SAMPLE]);
    expect(tool?.description).toBe("A sample operation's summary.");
  });

  it("leaves the description unchanged on mcp_http", () => {
    const [tool] = toolsFromOperations([SAMPLE], "mcp_http");
    expect(tool?.description).toBe("A sample operation's summary.");
  });

  it("appends a suffix on mcp_stdio, without altering the summary itself", () => {
    const [tool] = toolsFromOperations([SAMPLE], "mcp_stdio");
    expect(tool?.description).toContain("A sample operation's summary.");
    expect(tool?.description).not.toBe("A sample operation's summary.");
    expect(tool?.description?.startsWith("A sample operation's summary.")).toBe(true);
  });

  it("states the two facts the item requires: unobserved, and the claim-blocking setting", () => {
    const [tool] = toolsFromOperations([SAMPLE], "mcp_stdio");
    const description = tool?.description ?? "";
    expect(description.toLowerCase()).toContain("unobserved");
    expect(description).toContain("hook.require_registration_to_claim");
  });

  it("applies the identical suffix to every operation — uniform, not per-operation", () => {
    // The property the item's scope explicitly forbids losing: no
    // hand-written per-operation table. Two different operations must carry
    // the same suffix text, differing only in their own summary.
    const other = defineOperation({
      name: "other_op",
      kind: "write",
      summary: "A different summary entirely.",
      input: {} as never,
      async handler() {
        return {};
      },
    });
    const [first, second] = toolsFromOperations([SAMPLE, other], "mcp_stdio");
    const suffixOf = (description: string | undefined, summary: string) =>
      description?.slice(summary.length);
    expect(suffixOf(first?.description, SAMPLE.summary)).toBe(
      suffixOf(second?.description, other.summary),
    );
  });

  it("keeps deriving from the real operation registry with the suffix applied", () => {
    // The structural property this module's own header states: every
    // registered operation becomes a tool, adapter suffix or not. Proven
    // against the live registry, not a hand-built list.
    const tools = toolsFromOperations(listOperations(), "mcp_stdio");
    expect(tools.length).toBe(listOperations().length);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps the description short — one sentence, not a restated rationale", () => {
    // The header's own warning (describe-tool.ts's cost reasoning, inherited
    // here): this is charged to every session on every turn. A regression
    // that ballooned the suffix into paragraphs would be a real, if
    // invisible, cost — pinned here as an upper bound rather than left to
    // grow unnoticed. Generous on purpose: this pins "did not balloon", not
    // a specific target length.
    const [tool] = toolsFromOperations([SAMPLE], "mcp_stdio");
    const suffix = (tool?.description ?? "").slice(SAMPLE.summary.length);
    expect(suffix.length).toBeLessThan(280);
  });
});
