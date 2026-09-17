// The two invariants, proved across an upgrade — MILESTONES.md #128.
//
// ── Why this suite exists beside the other two ─────────────────────────
//
// `tests/interventions-settings.test.ts` proves the resolver holds both
// rules, and `tests/interventions-page-model.test.ts` proves the surface
// does not undo them. Neither asks the question an operator actually cares
// about, which is a question about **time**: *I set this six months ago and
// the product has since changed its mind — what happens?*
//
// That question cannot be asked of a single catalogue. Both rules are about
// the relationship between a stored row and a default that has **moved**, so
// the only arrangement that can distinguish "applied" from "tracks the
// product" is to resolve the *same stored rows* against *two different
// catalogues* — which is exactly what a release retuning a level does, with
// the upgrade played out as a value rather than described in a comment.
//
// A test that resolved against one catalogue would pass on an implementation
// that materialised the default into the row, because with only one build
// there is nothing for the row to disagree with. That is the precise defect
// `settings.ts`'s rule 1 is written about, and it is why the pair of
// catalogues below is the whole design of this file rather than a detail of
// it.
import { describe, expect, it } from "vitest";
import {
  interventionSettingKey,
  renderInterventionSettings,
  resolveInterventionSettings,
  type StoredInterventionSetting,
} from "@/lib/interventions/settings";
import { evaluate } from "@/lib/interventions/registry";
import { choiceFor, fieldFor } from "@/lib/interventions-page/model";
import { levelsFor } from "@/lib/interventions/configurable";
import type { Intervention, InterventionLevel } from "@/lib/interventions/types";

/**
 * One catalogue entry, at whatever level the "release" ships it at.
 *
 * The predicate always triggers so that `evaluate` can be used to observe
 * the level an entry would actually *fire* at — the question the stored row
 * exists to answer. A finding is the only observation that proves the
 * configuration reached the thing it configures; asserting on the resolved
 * map alone would stop one layer short.
 */
function catalogue(
  shipped: InterventionLevel,
  phase: Intervention["phase"] = "pre",
): Intervention[] {
  return [
    {
      id: "retuned-entry",
      source: "builtin",
      summary: "An entry whose shipped level changes between releases.",
      phase,
      audience: "agent",
      defaultLevel: shipped,
      defaultTiming: "immediate",
      messages: { plain: "plain", prominent: "PROMINENT" },
      predicate: () => ({ triggered: true }),
    },
    {
      id: "untouched-entry",
      source: "builtin",
      summary: "An entry nobody ever configured.",
      phase,
      audience: "agent",
      defaultLevel: shipped,
      defaultTiming: "immediate",
      messages: { plain: "plain", prominent: "PROMINENT" },
      predicate: () => ({ triggered: true }),
    },
  ];
}

/** The level an entry actually fires at, under one catalogue and one set of rows. */
async function firesAt(
  entries: readonly Intervention[],
  stored: readonly StoredInterventionSetting[],
  id: string,
): Promise<InterventionLevel | undefined> {
  const { overrides } = resolveInterventionSettings({ stored, entries });
  const findings = await evaluate({ entries, phase: entries[0]!.phase, context: {}, overrides });
  return findings.find((finding) => finding.id === id)?.level;
}

describe("an override is a decision and it sticks across an upgrade", () => {
  // The release: `nudge` in one catalogue, `hard-block` in the next. The
  // operator's stored choice is `nudge`, which the second catalogue does not
  // ship — so across the pair the stored value and the default disagree, and
  // every assertion below can tell them apart.
  const stored: StoredInterventionSetting[] = [
    { key: interventionSettingKey("retuned-entry", "level"), value: "nudge" },
  ];
  const before = catalogue("nudge");
  const after = catalogue("hard-block");

  it("keeps the operator's level when the shipped default moves under it", async () => {
    expect(await firesAt(before, stored, "retuned-entry")).toBe("nudge");
    // The assertion the whole file is for. If `clear_intervention_level` had
    // written the resolved default into the row, or if the resolver
    // materialised defaults, this would be "hard-block" — the product
    // reversing a deliberate choice on upgrade.
    expect(await firesAt(after, stored, "retuned-entry")).toBe("nudge");
  });

  // The control. Without it, an implementation that simply ignored the
  // second catalogue would pass the assertion above, and the suite would be
  // proving "nothing ever changes" rather than "a decision sticks".
  it("moves an entry nobody configured to the newly shipped level", async () => {
    expect(await firesAt(before, stored, "untouched-entry")).toBe("nudge");
    expect(await firesAt(after, stored, "untouched-entry")).toBe("hard-block");
  });

  it("still reports the entry as overridden after the upgrade, so the reset stays offered", () => {
    const { overrides } = resolveInterventionSettings({ stored, entries: after });
    const rendered = renderInterventionSettings({ entries: after, overrides });
    const level = rendered.find((entry) => entry.id === "retuned-entry" && entry.field === "level");
    expect(level?.source).toBe("override");
    expect(level?.effectiveValue).toBe("nudge");
    expect(level?.defaultValue).toBe("hard-block");
  });

  it("shows the operator their own level, not the new default, on the settings surface", () => {
    const field = fieldFor({
      id: "retuned-entry",
      summary: "An entry whose shipped level changes between releases.",
      phase: "pre",
      audience: "agent",
      source: "builtin",
      level: "nudge",
      defaultLevel: "hard-block",
      levelSource: "override",
      availableLevels: levelsFor("pre"),
      levelKey: interventionSettingKey("retuned-entry", "level"),
      enabled: true,
      enabledSource: "default",
    });
    expect(field.choice).toBe("nudge");
    expect(field.overridden).toBe(true);
    // And the inherit option names what they would be moving to, so the
    // consequence of resetting is legible before they do it.
    expect(field.options[0]?.label).toContain("hard block");
  });
});

describe("an entry never overridden stores no row", () => {
  // Criterion 2, stated as the absence the mechanism depends on. Asserted
  // over the resolved map's own keys rather than over behaviour, because
  // behaviour is identical either way until a default moves — which is
  // exactly what makes the defect silent.
  it("produces no override entry at all for an entry with no stored rows", () => {
    const { overrides } = resolveInterventionSettings({ stored: [], entries: catalogue("nudge") });
    expect(Object.keys(overrides)).toEqual([]);
    expect(overrides["retuned-entry"]).toBeUndefined();
  });

  // Rendering the surface must not create one either. A renderer that
  // filled in the resolved default would look correct on screen and would
  // have converted the installation into one holding an opinion about
  // everything — permanently, on the first page load.
  it("does not gain an override by being rendered", () => {
    const entries = catalogue("nudge");
    const { overrides } = resolveInterventionSettings({ stored: [], entries });
    renderInterventionSettings({ entries, overrides });
    expect(Object.keys(overrides)).toEqual([]);
  });

  // **A partially configured entry keeps tracking the product for every
  // field it did not configure**, and this is the case an assertion about a
  // wholly-unconfigured entry cannot reach. Once *any* row exists for an id,
  // that id has an entry in the overrides map — so an implementation that
  // filled the remaining fields in from the catalogue would leave the
  // "stores no row" assertions above completely untouched while silently
  // pinning the level of every entry anybody ever switched off.
  //
  // Found by hand-mutating `resolveInterventionSettings` to materialise
  // `target.level ??= entry.defaultLevel`: the existing suite stayed green.
  it("does not fill in a level for an entry that configured only its enabled flag", () => {
    const stored: StoredInterventionSetting[] = [
      { key: interventionSettingKey("retuned-entry", "enabled"), value: true },
    ];
    const { overrides } = resolveInterventionSettings({ stored, entries: catalogue("nudge") });
    expect(overrides["retuned-entry"]?.enabled).toBe(true);
    expect(overrides["retuned-entry"]?.level).toBeUndefined();
  });

  // And the consequence that makes it matter: the un-configured level still
  // follows a release that retunes it.
  it("moves the level of a partially configured entry when the default moves", async () => {
    const stored: StoredInterventionSetting[] = [
      { key: interventionSettingKey("retuned-entry", "enabled"), value: true },
    ];
    expect(await firesAt(catalogue("nudge"), stored, "retuned-entry")).toBe("nudge");
    expect(await firesAt(catalogue("hard-block"), stored, "retuned-entry")).toBe("hard-block");
  });

  it("renders every field of an unconfigured entry as sourced from the default", () => {
    const entries = catalogue("nudge");
    const rendered = renderInterventionSettings({ entries, overrides: {} });
    expect(rendered.length).toBeGreaterThan(0);
    for (const field of rendered) {
      expect(field.source).toBe("default");
      expect(field.overriddenValue).toBeUndefined();
    }
  });

  // The surface's own reading of the same fact: with nothing stored, every
  // control sits on "inherit", so nothing a page renders can be mistaken for
  // a decision somebody made.
  it("shows every unconfigured entry as inheriting", () => {
    const entries = catalogue("nudge");
    for (const entry of entries) {
      expect(
        choiceFor({
          id: entry.id,
          summary: entry.summary,
          phase: entry.phase,
          audience: entry.audience,
          source: entry.source,
          level: entry.defaultLevel,
          defaultLevel: entry.defaultLevel,
          levelSource: "default",
          availableLevels: levelsFor(entry.phase),
          levelKey: interventionSettingKey(entry.id, "level"),
          enabled: true,
          enabledSource: "default",
        }),
      ).toBe("inherit");
    }
  });
});

describe("a retired entry's configuration is kept, not tidied away", () => {
  // The third property `settings.ts` names: a stored row for an id absent
  // from this build's catalogue is the only surviving record that the
  // installation ever made a decision, so it is reported rather than
  // dropped. This is what makes retiring an entry a release rather than a
  // migration.
  it("reports the id of a stored row the catalogue cannot explain", () => {
    const stored: StoredInterventionSetting[] = [
      { key: interventionSettingKey("retired-entry", "level"), value: "hard-block" },
    ];
    const { unknownIds, overrides } = resolveInterventionSettings({
      stored,
      entries: catalogue("nudge"),
    });
    expect(unknownIds).toEqual(["retired-entry"]);
    // Still resolved, not discarded — a build that reinstates the entry
    // finds the decision intact.
    expect(overrides["retired-entry"]?.level).toBe("hard-block");
  });
});
