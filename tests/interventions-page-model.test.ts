// The interventions section of `/settings` — MILESTONES.md #128.
//
// `tests/interventions-settings.test.ts` already proves the two rules in
// `INTERVENTIONS.md` hold in the **resolver**. This suite proves they
// survive the two layers built on top of it, which is where they can newly
// break and where breaking them is silent:
//
//   1. The **surface** must not turn "inherit" into a level. A control that
//      offered the resolved default as a selectable value, or that decided
//      which option is selected by comparing the level against the default,
//      would write a row for an entry nobody meant to pin — and the row is
//      indistinguishable from a deliberate one afterwards.
//   2. The **write** a choice implies must stay a deletion. `writeForChoice`
//      is the single mapping, and a surface that reimplemented it would go
//      on working until the day a shipped default moved.
//
// Every assertion here is a value comparison against a pure function, so
// each one names a single-character change that breaks it — recorded beside
// the assertions that are not obvious.
import { describe, expect, it } from "vitest";
import {
  choiceFor,
  fieldFor,
  interventionsModel,
  isSilent,
  optionsFor,
  silenceReason,
  writeForChoice,
} from "@/lib/interventions-page/model";
import { levelsFor, rejectionForLevel } from "@/lib/interventions/configurable";
import { INTERVENTION_LEVELS, isBlockingLevel } from "@/lib/interventions/types";
import type { InterventionSettingRow } from "@/lib/interventions/configurable";

function row(overrides: Partial<InterventionSettingRow> = {}): InterventionSettingRow {
  return {
    id: "example-entry",
    summary: "An example situation.",
    phase: "pre",
    audience: "agent",
    source: "builtin",
    level: "nudge",
    defaultLevel: "nudge",
    levelSource: "default",
    availableLevels: levelsFor("pre"),
    levelKey: "interventions.example-entry.level",
    enabled: true,
    enabledSource: "default",
    ...overrides,
  };
}

describe("an entry that has never been overridden tracks the product", () => {
  // Rule 1, stated at the surface. The row below is at its default and its
  // level happens to equal that default — which is every un-overridden entry
  // in the system — so a control that decided "is this overridden?" by
  // comparing the two would agree with this assertion by accident. The next
  // test is the one that separates them.
  it("shows an un-overridden entry as inheriting, not as holding its level", () => {
    const field = fieldFor(row({ level: "nudge", defaultLevel: "nudge", levelSource: "default" }));
    expect(field.choice).toBe("inherit");
    expect(field.overridden).toBe(false);
  });

  // **The load-bearing one.** An operator who deliberately pinned an entry
  // to the level it already ships has a stored row, and that decision must
  // survive a release retuning the default. Read by comparison rather than
  // from `levelSource`, this reports "inherit" — and the reset offered next
  // would look like a no-op while actually discarding the decision.
  //
  // Breaks if `choiceFor` is changed to
  // `row.level === row.defaultLevel ? "inherit" : row.level`.
  it("shows an entry pinned to its own default as overridden, not as inheriting", () => {
    const field = fieldFor(row({ level: "nudge", defaultLevel: "nudge", levelSource: "override" }));
    expect(field.choice).toBe("nudge");
    expect(field.overridden).toBe(true);
  });

  // The choice an operator makes to go back to tracking the product must
  // map to a DELETE. Writing the default back satisfies every observation
  // available while the shipped default holds, and pins the value for ever.
  //
  // Breaks if `writeForChoice` returns `{action: "set", level: ...}` for
  // "inherit".
  it("maps the inherit choice to a deletion, never to a write", () => {
    expect(writeForChoice("inherit")).toEqual({ action: "clear" });
  });

  it("maps every real level to a write of that level", () => {
    for (const level of INTERVENTION_LEVELS) {
      expect(writeForChoice(level)).toEqual({ action: "set", level });
    }
  });

  // Selecting the level an entry already inherits is a decision and must
  // still write. An optimisation that skipped the write "because nothing
  // changed" would leave the entry tracking the product against the
  // operator's stated intent.
  it("treats choosing the current default as a write, not as a no-op", () => {
    expect(writeForChoice("nudge")).toEqual({ action: "set", level: "nudge" });
  });
});

describe("the control cannot offer a blocking level to a post entry", () => {
  // Criterion 4. Derived from `isBlockingLevel` rather than compared against
  // a hand-written list, so a level added to the ladder is classified by the
  // same function the registry uses — a literal list here would pass while
  // disagreeing with the code it describes.
  it("offers a post entry only the non-blocking levels", () => {
    const offered = optionsFor("post", "nudge")
      .map((option) => option.value)
      .filter((value) => value !== "inherit");
    expect(offered).toEqual(INTERVENTION_LEVELS.filter((level) => !isBlockingLevel(level)));
    expect(offered.some((level) => isBlockingLevel(level as never))).toBe(false);
  });

  // The other half: a `pre` entry must still be offered everything, or the
  // narrowing above would be "offer nothing anywhere", which also passes a
  // test that only checks the post case.
  it("offers a pre entry the whole ladder", () => {
    const offered = optionsFor("pre", "nudge")
      .map((option) => option.value)
      .filter((value) => value !== "inherit");
    expect(offered).toEqual([...INTERVENTION_LEVELS]);
  });

  it("puts inherit first and names the level it would inherit", () => {
    const options = optionsFor("post", "nothing");
    expect(options[0]?.value).toBe("inherit");
    expect(options[0]?.label).toContain("off");
  });

  it("explains why a post entry's menu is shorter", () => {
    expect(fieldFor(row({ phase: "post" })).blockingUnavailable).toContain("never refuse");
    expect(fieldFor(row({ phase: "pre" })).blockingUnavailable).toBeNull();
  });

  // The service's refusal and the menu must agree. Two independent
  // statements of one rule is exactly how the pair drifts, so both are
  // asserted against the same phase/level pairs.
  it("refuses in the service exactly what it declines to offer in the menu", () => {
    for (const phase of ["pre", "post"] as const) {
      const offered = new Set(levelsFor(phase));
      for (const level of INTERVENTION_LEVELS) {
        const refused = rejectionForLevel(phase, level) !== null;
        expect(refused).toBe(!offered.has(level));
      }
    }
  });

  it("names the phase and the available levels when it refuses", () => {
    const message = rejectionForLevel("post", "hard-block");
    expect(message).toContain("post");
    expect(message).toContain("hard-block");
    expect(message).toContain("nudge");
  });
});

describe("an entry that says nothing explains why", () => {
  // The three silences are different facts and an operator acts on each
  // differently, so each gets its own sentence rather than one with a value
  // substituted in.
  it("distinguishes shipping off from being turned off here", () => {
    const shipsOff = row({ level: "nothing", defaultLevel: "nothing", levelSource: "default" });
    const turnedOff = row({ level: "nothing", defaultLevel: "nudge", levelSource: "override" });
    expect(silenceReason(shipsOff)).toContain("by default");
    expect(silenceReason(turnedOff)).toContain("here");
    expect(silenceReason(shipsOff)).not.toEqual(silenceReason(turnedOff));
  });

  it("reports an entry switched off entirely as not evaluated at all", () => {
    expect(silenceReason(row({ enabled: false }))).toContain("not evaluated");
  });

  it("says nothing about an entry that is speaking", () => {
    expect(silenceReason(row({ level: "nudge" }))).toBeNull();
    expect(isSilent(row({ level: "nudge" }))).toBe(false);
  });

  it("counts both kinds of silence", () => {
    expect(isSilent(row({ level: "nothing" }))).toBe(true);
    expect(isSilent(row({ enabled: false, level: "nudge" }))).toBe(true);
  });
});

describe("the section as a whole", () => {
  it("keeps the server's order rather than sorting", () => {
    const model = interventionsModel({
      interventions: [row({ id: "zebra" }), row({ id: "alpha" })],
    });
    expect(model.fields.map((field) => field.id)).toEqual(["zebra", "alpha"]);
  });

  it("counts only the entries carrying a stored level", () => {
    const model = interventionsModel({
      interventions: [
        row({ id: "a", levelSource: "override" }),
        row({ id: "b", levelSource: "default" }),
        row({ id: "c", levelSource: "override" }),
      ],
    });
    expect(model.overriddenCount).toBe(2);
  });

  it("survives an empty catalogue without throwing", () => {
    expect(interventionsModel({ interventions: [] }).fields).toEqual([]);
  });
});

describe("choiceFor", () => {
  it("reports the stored level when one is stored", () => {
    expect(choiceFor(row({ level: "hard-block", levelSource: "override" }))).toBe("hard-block");
  });

  it("reports inherit when nothing is stored, whatever the level resolves to", () => {
    expect(choiceFor(row({ level: "block-overridable", levelSource: "default" }))).toBe("inherit");
  });
});
