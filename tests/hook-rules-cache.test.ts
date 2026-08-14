// MILESTONES.md #42 — the cached rule lists (`src/lib/hook/rules-cache.ts`).
//
// The distinction these tests exist to protect: **an unreadable cache is not
// an empty cache.** With empty lists every command matches neither list and
// is denied, which is right for a guarded command and catastrophic as the
// response to a missing file — it would refuse every tool call on a machine
// whose installation is merely incomplete. `unavailable` and a valid-but-
// empty rule set are therefore different states, and several tests below do
// nothing but hold them apart.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_TTL_MS,
  readCache,
  readRulesFromResponse,
  serialiseCache,
} from "@/lib/hook/rules-cache";

const NOW = 1_700_000_000_000;

function cacheText(overrides: Record<string, unknown> = {}, fetchedAt: number = NOW): string {
  return JSON.stringify({
    allowPatterns: ["^git status$"],
    askPatterns: ["^git push"],
    fetchedAt,
    ...overrides,
  });
}

describe("readCache reads a usable cache", () => {
  it("reports fresh inside the TTL and hands back both lists", () => {
    const state = readCache({ text: cacheText({}, NOW - 1000), now: NOW });
    expect(state).toEqual({
      status: "fresh",
      rules: { allowPatterns: ["^git status$"], askPatterns: ["^git push"] },
    });
  });

  it("reports fresh at one millisecond under the TTL and stale exactly at it", () => {
    // The boundary, pinned in both directions: an off-by-one here is a cache
    // that either never expires or expires immediately, and neither shows up
    // in a test that only checks a value in the middle.
    const justInside = readCache({
      text: cacheText({}, NOW - (DEFAULT_CACHE_TTL_MS - 1)),
      now: NOW,
    });
    expect(justInside.status).toBe("fresh");

    const exactlyAt = readCache({ text: cacheText({}, NOW - DEFAULT_CACHE_TTL_MS), now: NOW });
    expect(exactlyAt.status).toBe("stale");
  });

  it("reports stale past the TTL but still hands back the lists", () => {
    // Stale is usable. An hour-old rule list is a far better input than
    // none, and refusing to classify against it would deny every unmatched
    // command on a machine that had simply not fetched recently.
    const state = readCache({ text: cacheText({}, NOW - 60 * 60 * 1000), now: NOW });
    expect(state.status).toBe("stale");
    expect(state.status === "stale" && state.rules.askPatterns).toEqual(["^git push"]);
    expect(state.status === "stale" && state.ageMs).toBe(60 * 60 * 1000);
  });

  it("treats a cache stamped in the future as stale, not fresh", () => {
    // Clock skew, or a cache file copied from another machine, must not be
    // able to mint a rule set that never expires — that failure is silent
    // and permanent, and the cost of being wrong is one extra fetch.
    const state = readCache({ text: cacheText({}, NOW + 60_000), now: NOW });
    expect(state.status).toBe("stale");
  });

  it("honours an explicit TTL over the default", () => {
    const state = readCache({ text: cacheText({}, NOW - 2000), now: NOW, ttlMs: 1000 });
    expect(state.status).toBe("stale");
  });

  it("accepts two empty lists as a complete answer, not as an unavailable cache", () => {
    // "Guard nothing by name, deny the unknown" is a legitimate
    // configuration — it is in fact the shipped default for both settings.
    // Reading it as `unavailable` would send every call to the server.
    const state = readCache({
      text: cacheText({ allowPatterns: [], askPatterns: [] }, NOW),
      now: NOW,
    });
    expect(state).toEqual({ status: "fresh", rules: { allowPatterns: [], askPatterns: [] } });
  });
});

describe("readCache reports unavailable rather than pretending the lists are empty", () => {
  it("when there is no file", () => {
    const state = readCache({ text: undefined, now: NOW });
    expect(state.status).toBe("unavailable");
    expect(state.status === "unavailable" && state.reason).toContain("no cached rules");
  });

  it("when the file is not JSON", () => {
    const state = readCache({ text: "{ truncated", now: NOW });
    expect(state.status).toBe("unavailable");
    expect(state.status === "unavailable" && state.reason).toContain("valid JSON");
  });

  it("when the file is JSON but not an object", () => {
    for (const text of ["[]", '"x"', "7", "null"]) {
      expect(readCache({ text, now: NOW }).status, `expected ${text} unavailable`).toBe(
        "unavailable",
      );
    }
  });

  it("when either pattern list is missing", () => {
    expect(
      readCache({ text: JSON.stringify({ askPatterns: [], fetchedAt: NOW }), now: NOW }).status,
    ).toBe("unavailable");
    expect(
      readCache({ text: JSON.stringify({ allowPatterns: [], fetchedAt: NOW }), now: NOW }).status,
    ).toBe("unavailable");
  });

  it("when a pattern list is not a list of strings", () => {
    expect(readCache({ text: cacheText({ allowPatterns: "^git" }), now: NOW }).status).toBe(
      "unavailable",
    );
    expect(readCache({ text: cacheText({ askPatterns: [1, 2] }), now: NOW }).status).toBe(
      "unavailable",
    );
  });

  it("when a cached pattern cannot compile as a regular expression", () => {
    // A pattern that does not compile is skipped at match time, so the entry
    // someone added to guard something would simply not guard it — silently.
    // Rejecting the whole cache costs one fetch and makes it loud.
    const state = readCache({ text: cacheText({ askPatterns: ["([unclosed"] }), now: NOW });
    expect(state.status).toBe("unavailable");
    expect(state.status === "unavailable" && state.reason).toContain("two pattern lists");
  });

  it("when an entry is an empty string", () => {
    // An empty pattern compiles and matches everything, so it would turn an
    // allow-list entry into "allow all" — the single most dangerous value
    // this file can hold.
    expect(readCache({ text: cacheText({ allowPatterns: [""] }), now: NOW }).status).toBe(
      "unavailable",
    );
  });

  it("when there is no fetch time to judge freshness against", () => {
    const state = readCache({
      text: JSON.stringify({ allowPatterns: [], askPatterns: [] }),
      now: NOW,
    });
    expect(state.status).toBe("unavailable");
    expect(state.status === "unavailable" && state.reason).toContain("fetch time");
  });

  it("when the fetch time is not a finite number", () => {
    for (const fetchedAt of ["2026-01-01", Number.NaN, Number.POSITIVE_INFINITY]) {
      const text = JSON.stringify({ allowPatterns: [], askPatterns: [], fetchedAt });
      expect(
        readCache({ text, now: NOW }).status,
        `expected ${String(fetchedAt)} unavailable`,
      ).toBe("unavailable");
    }
  });
});

describe("serialiseCache round-trips", () => {
  it("writes something readCache reads back as fresh", () => {
    const text = serialiseCache({ allowPatterns: ["^ls"], askPatterns: [] }, NOW);
    expect(readCache({ text, now: NOW })).toEqual({
      status: "fresh",
      rules: { allowPatterns: ["^ls"], askPatterns: [] },
    });
  });

  it("stamps the fetch time it was given, not the read time", () => {
    const text = serialiseCache({ allowPatterns: [], askPatterns: [] }, NOW - 10_000);
    const state = readCache({ text, now: NOW, ttlMs: 5000 });
    expect(state.status).toBe("stale");
  });
});

describe("readRulesFromResponse validates the wire as strictly as the file", () => {
  it("reads two valid lists", () => {
    expect(readRulesFromResponse({ allowPatterns: ["^a"], askPatterns: ["^b"] })).toEqual({
      allowPatterns: ["^a"],
      askPatterns: ["^b"],
    });
  });

  it("returns undefined when the response carries no rules", () => {
    expect(readRulesFromResponse({ decision: "allow" })).toBeUndefined();
    expect(readRulesFromResponse(null)).toBeUndefined();
    expect(readRulesFromResponse("rules")).toBeUndefined();
  });

  it("refuses an uncompilable pattern arriving over the wire", () => {
    // Rules from the network are no more trustworthy than rules from disk;
    // a build that validated one and not the other has a hole exactly the
    // width of whichever it trusted.
    expect(
      readRulesFromResponse({ allowPatterns: ["([unclosed"], askPatterns: [] }),
    ).toBeUndefined();
  });
});
