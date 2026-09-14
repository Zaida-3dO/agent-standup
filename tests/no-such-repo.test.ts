// `noSuchRepoMessage` (src/lib/service/items/no-such-repo.ts) — pure logic
// against a fake `TransactionHandle`, no database needed. The DB-backed
// suites (`admin-operations.test.ts`, `items-operations.test.ts`,
// `delete-reference-row.test.ts`) and the fake-handle end-to-end suite
// (`describe-tool.test.ts`) prove the wiring into each operation; this file
// is the one place the message-building logic itself — the cap, the
// near-miss ordering, the empty-table fallback — is pinned directly.
import { describe, expect, it } from "vitest";
import { noSuchRepoMessage } from "@/lib/service/items/no-such-repo";
import type { TransactionHandle } from "@/lib/service";

function handleFor(ids: readonly string[]): TransactionHandle {
  return {
    $queryRawUnsafe: async <T = unknown>(): Promise<T> => ids.map((id) => ({ id })) as T,
    $executeRawUnsafe: async (): Promise<number> => 0,
  };
}

describe("noSuchRepoMessage", () => {
  it("names the bad input", async () => {
    const message = await noSuchRepoMessage(handleFor(["web"]), "typo-repo");
    expect(message).toContain("No such repo: typo-repo");
  });

  it("reports an honest 'nothing registered yet' when the Repo table is empty", async () => {
    const message = await noSuchRepoMessage(handleFor([]), "anything");
    expect(message).toContain("No repos are registered yet");
    // Does not claim a valid set exists when there is none.
    expect(message).not.toContain("Valid repos:");
  });

  it("lists every id when the count is at or under the cap", async () => {
    const ids = ["alpha", "beta", "gamma"];
    const message = await noSuchRepoMessage(handleFor(ids), "not-a-repo");
    for (const id of ids) expect(message).toContain(id);
    expect(message).not.toContain("more");
  });

  it("caps the list and states the remainder rather than dumping every id", async () => {
    // 23 repos: comfortably over the 10-id cap, exercising the "and N more"
    // branch with a number a caller could sanity-check.
    const ids = Array.from({ length: 23 }, (_, i) => `repo-${String(i).padStart(2, "0")}`);
    const message = await noSuchRepoMessage(handleFor(ids), "not-a-repo");
    expect(message).toContain("and 13 more");
    // Exactly 10 ids appear as list entries — proven by counting commas
    // (10 entries => 9 separating commas before "and 13 more").
    const beforeMore = message.split(", and 13 more")[0]!;
    const listedPortion = beforeMore.split("Valid repos: ")[1]!;
    expect(listedPortion.split(", ")).toHaveLength(10);
  });

  it("sorts by edit distance to the caller's input, closest first", async () => {
    // "aaaa" is 1 substitution from "aaab" and much further from "zzzz".
    const ids = ["zzzz", "aaab", "qqqq"];
    const message = await noSuchRepoMessage(handleFor(ids), "aaaa");
    const idxAaab = message.indexOf("aaab");
    const idxZzzz = message.indexOf("zzzz");
    const idxQqqq = message.indexOf("qqqq");
    expect(idxAaab).toBeGreaterThan(-1);
    expect(idxAaab).toBeLessThan(idxZzzz);
    expect(idxAaab).toBeLessThan(idxQqqq);
  });

  it("surfaces the exact reported case: a case/punctuation near-miss leads", async () => {
    const ids = ["joda-creative-studio", "fynance", "agent-standup", "home-assistant"];
    const message = await noSuchRepoMessage(handleFor(ids), "Joda-creative-studio");
    const idxReal = message.indexOf("joda-creative-studio");
    expect(idxReal).toBeGreaterThan(-1);
    for (const other of ["fynance", "agent-standup", "home-assistant"]) {
      expect(idxReal).toBeLessThan(message.indexOf(other));
    }
  });
});
