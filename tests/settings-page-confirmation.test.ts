// src/lib/settings-page/confirmation.ts — the typed-confirmation gate for
// `sensitive` and `irreversible` settings (SCHEMA.md §17.8, MILESTONES.md
// #86).
//
// **These are refusal tests, and the refusals are the point.** A gate that
// never says no passes a happy-path suite and protects nothing, so the bulk
// of what follows is near-misses: the right key with different case, with
// whitespace, truncated, the key of a *different* guarded setting. Each of
// those would be let through by one specific plausible relaxation of the
// comparison, and each is asserted to be refused.
import { describe, expect, it } from "vitest";
import { confirmWrite, guardReason, requiresConfirmation } from "@/lib/settings-page/confirmation";
import { SETTINGS_REGISTRY, SETTING_KEYS, getDefinition } from "@/lib/settings";

/** A key the registry marks `sensitive` but not `irreversible`. */
const SENSITIVE_KEY = "budget.enabled";
/** The registry's `irreversible` key. */
const IRREVERSIBLE_KEY = "retention.tool_calls_days";
/** A key with neither flag. */
const PLAIN_KEY = "items.max_depth";

describe("which keys are gated", () => {
  it("gates exactly the keys the registry flags, and no others", () => {
    // Derived from the registry rather than listed here: a second list is
    // the thing that drifts. If a key's flag changes, this test follows it
    // — and if the gate ever stopped reading the registry, this fails.
    for (const key of SETTING_KEYS) {
      const definition = getDefinition(key);
      const expected = definition.sensitive || definition.irreversible;
      expect(requiresConfirmation(key), key).toBe(expected);
    }
  });

  it("gates the sensitive key and the irreversible key, and not a plain one", () => {
    // The registry-derived test above would still pass if every flag were
    // false; this pins that the three fixtures really are what they claim,
    // so the refusal tests below are exercising a gate that is on.
    expect(SETTINGS_REGISTRY[SENSITIVE_KEY].sensitive).toBe(true);
    expect(SETTINGS_REGISTRY[IRREVERSIBLE_KEY].irreversible).toBe(true);
    expect(requiresConfirmation(SENSITIVE_KEY)).toBe(true);
    expect(requiresConfirmation(IRREVERSIBLE_KEY)).toBe(true);
    expect(requiresConfirmation(PLAIN_KEY)).toBe(false);
  });

  it("does not gate a key this build does not declare", () => {
    // Not because it is safe — the service refuses it separately — but
    // because a name the registry never heard of cannot be known to be
    // sensitive, and the unrecognised-row remove action has no flag to read.
    expect(requiresConfirmation("nope.not.a.key")).toBe(false);
    expect(guardReason("nope.not.a.key")).toBeNull();
  });

  it("says why a key is guarded, distinguishing destroys-data from relaxes-enforcement", () => {
    expect(guardReason(IRREVERSIBLE_KEY)).toContain("destroy data");
    expect(guardReason(SENSITIVE_KEY)).toContain("relaxes");
    expect(guardReason(PLAIN_KEY)).toBeNull();
  });
});

describe("an ungated key needs no confirmation", () => {
  it("allows a write with nothing typed", () => {
    expect(confirmWrite({ key: PLAIN_KEY, verb: "set", typed: null }).allowed).toBe(true);
  });

  it("allows a reset with nothing typed", () => {
    expect(confirmWrite({ key: PLAIN_KEY, verb: "reset", typed: null }).allowed).toBe(true);
  });
});

describe("a gated key is refused unless its key is typed exactly", () => {
  // Every entry is a near-miss that one plausible relaxation of the
  // comparison would accept. Named so a failure says which relaxation crept
  // in rather than only that something broke.
  const nearMisses: readonly { readonly label: string; readonly typed: string | null }[] = [
    { label: "nothing typed", typed: null },
    { label: "empty string", typed: "" },
    { label: "whitespace only", typed: "   " },
    { label: "trailing space (a trim would accept)", typed: `${SENSITIVE_KEY} ` },
    { label: "leading space (a trim would accept)", typed: ` ${SENSITIVE_KEY}` },
    { label: "wrong case (a case-fold would accept)", typed: SENSITIVE_KEY.toUpperCase() },
    { label: "truncated (a prefix match would accept)", typed: SENSITIVE_KEY.slice(0, -1) },
    { label: "with a suffix (a startsWith would accept)", typed: `${SENSITIVE_KEY}x` },
    { label: "the word yes", typed: "yes" },
    { label: "the word confirm", typed: "confirm" },
    { label: "a different guarded key's name", typed: IRREVERSIBLE_KEY },
  ];

  for (const { label, typed } of nearMisses) {
    it(`refuses a set when the confirmation is ${label}`, () => {
      const decision = confirmWrite({ key: SENSITIVE_KEY, verb: "set", typed });
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.needsTyped).toBe(SENSITIVE_KEY);
      // The refusal names the key, so the person is told what to type
      // rather than only that they got it wrong.
      expect(decision.reason).toContain(SENSITIVE_KEY);
    });

    it(`refuses a reset when the confirmation is ${label}`, () => {
      // §17.8 makes no exception for clearing a guarded key: reverting
      // `budget.enabled` to its default is still a change to what the
      // system enforces.
      const decision = confirmWrite({ key: SENSITIVE_KEY, verb: "reset", typed });
      expect(decision.allowed).toBe(false);
    });
  }

  it("allows the write when the key is typed exactly", () => {
    expect(confirmWrite({ key: SENSITIVE_KEY, verb: "set", typed: SENSITIVE_KEY }).allowed).toBe(
      true,
    );
    expect(confirmWrite({ key: SENSITIVE_KEY, verb: "reset", typed: SENSITIVE_KEY }).allowed).toBe(
      true,
    );
  });

  it("gates the irreversible key the same way, and says data can be destroyed", () => {
    const refused = confirmWrite({ key: IRREVERSIBLE_KEY, verb: "set", typed: "yes" });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.reason).toContain("destroy data");
    expect(
      confirmWrite({ key: IRREVERSIBLE_KEY, verb: "set", typed: IRREVERSIBLE_KEY }).allowed,
    ).toBe(true);
  });

  it("words the refusal for what the verb will do", () => {
    const set = confirmWrite({ key: SENSITIVE_KEY, verb: "set", typed: null });
    const reset = confirmWrite({ key: SENSITIVE_KEY, verb: "reset", typed: null });
    expect(set.allowed).toBe(false);
    expect(reset.allowed).toBe(false);
    if (set.allowed || reset.allowed) return;
    expect(set.reason).toContain("change it");
    expect(reset.reason).toContain("reset it to its default");
  });

  it("refuses every guarded key in the registry when nothing is typed", () => {
    // Not just the two fixtures: every key the registry flags is covered,
    // so a key that gains a flag is gated without this test being edited.
    const guarded = SETTING_KEYS.filter((key) => requiresConfirmation(key));
    expect(guarded.length).toBeGreaterThan(0);
    for (const key of guarded) {
      expect(confirmWrite({ key, verb: "set", typed: null }).allowed, key).toBe(false);
      expect(confirmWrite({ key, verb: "set", typed: key }).allowed, key).toBe(true);
    }
  });
});
