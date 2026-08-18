// MILESTONES.md #128 — the settings surface for interventions
// (`src/lib/interventions/settings.ts`).
//
// The two rules in `INTERVENTIONS.md` ("Defaults, overrides, and retiring an
// entry") are both easy to implement backwards, and both failures are
// silent. So they are the properties this suite is built around, each
// stated as the change that breaks it:
//
//   1. **Never overridden tracks the product.** If `resolveInterventionSettings`
//      materialised the current default into the override map, every
//      installation would silently become one that had an opinion about
//      everything, and a later release retuning a default would stop
//      reaching any of them. Asserted as the *absence* of keys rather than
//      as behaviour, because absence is the whole mechanism.
//   2. **An override sticks.** Asserted against an entry whose shipped
//      default differs from the stored value, which is the only arrangement
//      where "applied" and "tracks the default" are distinguishable.
//
// A third property is here because it decides whether retiring an entry is
// a release or a migration: a stored row for an id absent from this build's
// catalogue is **kept and reported**, never dropped.
import { describe, expect, it } from "vitest";
import {
  INTERVENTION_OVERRIDE_FIELDS,
  INTERVENTION_SETTING_PREFIX,
  interventionSettingKey,
  parseInterventionSettingKey,
  readInterventionSettingRows,
  renderInterventionSettings,
  resolveInterventionSettings,
} from "@/lib/interventions/settings";
import { evaluate } from "@/lib/interventions/registry";
import type { Intervention } from "@/lib/interventions/types";

function entry(overrides: Partial<Intervention> = {}): Intervention {
  return {
    id: "example",
    source: "builtin",
    summary: "An example situation.",
    phase: "pre",
    audience: "agent",
    defaultLevel: "nudge",
    defaultTiming: "digest",
    messages: { plain: "plain text", prominent: "PROMINENT TEXT" },
    predicate: () => ({ triggered: true }),
    ...overrides,
  };
}

describe("intervention settings keys", () => {
  it("round-trips an id and a field through the key format", () => {
    for (const field of INTERVENTION_OVERRIDE_FIELDS) {
      const key = interventionSettingKey("merge-without-approval-at-tip", field);
      expect(parseInterventionSettingKey(key)).toEqual({
        id: "merge-without-approval-at-tip",
        field,
      });
    }
  });

  it("keeps an id containing a dot intact", () => {
    // Parsed from the right for exactly this case. A left-to-right split
    // would return `custom` as the id and silently configure a different
    // entry — or, more likely, no entry at all, with the write landing on a
    // key no read ever looks at.
    const key = `${INTERVENTION_SETTING_PREFIX}.custom.my.entry.level`;
    expect(parseInterventionSettingKey(key)).toEqual({ id: "custom.my.entry", field: "level" });
  });

  it("rejects a key that is not an intervention setting", () => {
    for (const key of [
      "items.max_depth",
      // Shaped exactly like one of ours — three segments, ending in a real
      // field name — and belonging to another namespace entirely. This is
      // the only key that can prove the prefix is actually checked: the
      // shorter foreign keys are rejected by their shape alone, so a
      // resolver that had dropped the namespace test would still refuse
      // them and look correct.
      "hook.some-id.level",
      "interventions",
      "interventions.",
      // A field this build does not declare. Rejected rather than accepted
      // as free text: an unrecognised field would be stored and never read.
      "interventions.example.colour",
      // No id between the prefix and the field.
      "interventions.level",
    ]) {
      expect(parseInterventionSettingKey(key), key).toBeNull();
    }
  });
});

describe("resolving stored rows into overrides", () => {
  const entries = [entry({ id: "example", defaultLevel: "nudge", defaultTiming: "digest" })];

  it("produces no override at all when nothing is stored", () => {
    // Property 1, stated as the absence it is. A resolver that filled in
    // the current defaults would return `{example: {level: "nudge", …}}`
    // here — indistinguishable, downstream, from an installation that had
    // deliberately chosen every one of those values.
    const resolved = resolveInterventionSettings({ stored: [], entries });
    expect(resolved.overrides).toEqual({});
    expect(resolved.rejected).toEqual([]);
    expect(resolved.unknownIds).toEqual([]);
  });

  it("carries only the fields actually stored", () => {
    const resolved = resolveInterventionSettings({
      stored: [{ key: "interventions.example.level", value: "hard-block" }],
      entries,
    });
    // `timing`, `enabled` and both messages are absent, not defaulted.
    expect(resolved.overrides).toEqual({ example: { level: "hard-block" } });
  });

  it("applies a stored override through the registry", () => {
    // Property 2, proved end to end rather than by inspecting the map: the
    // override has to actually change what fires. The entry ships `nudge`,
    // the installation stored `hard-block`, and the finding must block.
    const resolved = resolveInterventionSettings({
      stored: [{ key: "interventions.example.level", value: "hard-block" }],
      entries,
    });
    return evaluate({
      entries,
      phase: "pre",
      context: {},
      overrides: resolved.overrides,
    }).then((findings) => {
      expect(findings).toHaveLength(1);
      expect(findings[0]?.level).toBe("hard-block");
    });
  });

  it("switches an entry off entirely", async () => {
    const resolved = resolveInterventionSettings({
      stored: [{ key: "interventions.example.enabled", value: false }],
      entries,
    });
    const findings = await evaluate({
      entries,
      phase: "pre",
      context: {},
      overrides: resolved.overrides,
    });
    expect(findings).toEqual([]);
  });

  it("overrides one message without disturbing the other", async () => {
    const resolved = resolveInterventionSettings({
      stored: [{ key: "interventions.example.message_plain", value: "rewritten" }],
      entries,
    });
    const findings = await evaluate({
      entries,
      phase: "pre",
      context: {},
      overrides: resolved.overrides,
    });
    // Field by field: the prominent form still tracks the product, which is
    // property 1 operating *within* a partially overridden entry.
    expect(findings[0]?.messages).toEqual({ plain: "rewritten", prominent: "PROMINENT TEXT" });
  });

  it("rejects a value that fails its field's schema and keeps the default", async () => {
    const resolved = resolveInterventionSettings({
      stored: [
        { key: "interventions.example.level", value: "extremely-blocked" },
        { key: "interventions.example.timing", value: 5 },
        { key: "interventions.example.message_plain", value: "   " },
      ],
      entries,
    });
    expect(resolved.rejected).toHaveLength(3);
    expect(resolved.overrides).toEqual({});

    // A rejected row must not take the tool call down with it — the entry
    // still fires, at its shipped level.
    const findings = await evaluate({
      entries,
      phase: "pre",
      context: {},
      overrides: resolved.overrides,
    });
    expect(findings[0]?.level).toBe("nudge");
  });

  it("keeps and reports a row for an entry this build does not ship", () => {
    // What makes retiring an entry a release rather than a migration. The
    // row is the only surviving record that the installation ever made a
    // decision, and an entry can also be absent because the build is older
    // than the row or because the id was renamed — so deleting on absence
    // would discard a deliberate choice in three cases to tidy up after one.
    const resolved = resolveInterventionSettings({
      stored: [{ key: "interventions.retired-entry.enabled", value: true }],
      entries,
    });
    expect(resolved.unknownIds).toEqual(["retired-entry"]);
    // Still resolved, so a surface can show it beside its id.
    expect(resolved.overrides["retired-entry"]).toEqual({ enabled: true });
  });

  it("reports a retired entry even when its stored value went stale", () => {
    // `rejected` and `unknownIds` answer different questions, and one row
    // can be the subject of both: the value is invalid *and* an entry
    // absent from this build still has configuration here. Losing the
    // second fact would defeat the purpose of `unknownIds` — preserving the
    // record that the installation made a decision — and it would be lost
    // in exactly the case that produces it, since a release that narrows a
    // field's schema is the same kind of release that retires an entry.
    const resolved = resolveInterventionSettings({
      stored: [{ key: "interventions.retired-entry.level", value: "not-a-level" }],
      entries,
    });
    expect(resolved.rejected).toHaveLength(1);
    expect(resolved.unknownIds).toEqual(["retired-entry"]);
  });

  it("ignores rows from other namespaces without reporting them", () => {
    // `stored` may legitimately be handed every settings row there is, so a
    // key under another prefix is not this module's business — reporting it
    // would fill the surface with settings that have nothing to do with
    // interventions.
    const resolved = resolveInterventionSettings({
      stored: [{ key: "items.max_depth", value: 6 }],
      entries,
    });
    expect(resolved.overrides).toEqual({});
    expect(resolved.rejected).toEqual([]);
    expect(resolved.unknownIds).toEqual([]);
  });
});

describe("reading the stored rows", () => {
  /** A handle recording the query and its bound parameters. */
  function recordingHandle(rows: { key: string; value: unknown }[] = []) {
    const calls: { query: string; params: unknown[] }[] = [];
    return {
      calls,
      $queryRawUnsafe: async <T = unknown>(query: string, ...params: unknown[]): Promise<T> => {
        calls.push({ query, params });
        return rows as T;
      },
    };
  }

  it("scopes the read to the intervention namespace", async () => {
    // The read sits on the highest-volume path in the system, and its own
    // reasoning is that a bound prefix makes this a range scan over the
    // primary key rather than a pattern match over every settings row.
    // Nothing else checks that: a widened bind would still be *correct*,
    // because `parseInterventionSettingKey` discards foreign keys anyway —
    // so the regression would be invisible in behaviour and show up only as
    // load, which is exactly the class of change that needs a test.
    const db = recordingHandle();
    await readInterventionSettingRows(db);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.params).toEqual([`${INTERVENTION_SETTING_PREFIX}.%`]);
    expect(db.calls[0]?.query).toContain(`"key" LIKE $1`);
  });

  it("hands back the rows it read, unchanged", async () => {
    const db = recordingHandle([{ key: "interventions.example.level", value: "nudge" }]);
    await expect(readInterventionSettingRows(db)).resolves.toEqual([
      { key: "interventions.example.level", value: "nudge" },
    ]);
  });
});

describe("rendering the settings surface", () => {
  const entries = [entry({ id: "example", defaultLevel: "nudge", defaultTiming: "digest" })];

  it("renders every overridable field of every entry", () => {
    const rendered = renderInterventionSettings({ entries, overrides: {} });
    expect(rendered).toHaveLength(INTERVENTION_OVERRIDE_FIELDS.length);
    expect(rendered.map((row) => row.field)).toEqual([...INTERVENTION_OVERRIDE_FIELDS]);
  });

  it("marks an unset field as tracking the default", () => {
    const rendered = renderInterventionSettings({ entries, overrides: {} });
    const level = rendered.find((row) => row.field === "level");
    expect(level?.source).toBe("default");
    expect(level?.effectiveValue).toBe("nudge");
    // The distinction a "reset to default" button depends on: a reset is a
    // deletion of the row, not a write of the current value, and a surface
    // that could not tell the two apart would offer a reset that silently
    // pinned the value forever.
    expect(level?.overriddenValue).toBeUndefined();
  });

  it("marks an overridden field, keeping the default beside it", () => {
    const rendered = renderInterventionSettings({
      entries,
      overrides: { example: { level: "hard-block" } },
    });
    const level = rendered.find((row) => row.field === "level");
    expect(level?.source).toBe("override");
    expect(level?.effectiveValue).toBe("hard-block");
    expect(level?.defaultValue).toBe("nudge");
  });

  it("renders enabled as true by default", () => {
    // An entry ships switched on — the catalogue lists it and the registry
    // runs it. An installation turns one off by storing `false`, which is
    // the direction that keeps "never overridden tracks the product"
    // meaningful for this field too.
    const rendered = renderInterventionSettings({ entries, overrides: {} });
    const enabled = rendered.find((row) => row.field === "enabled");
    expect(enabled?.defaultValue).toBe(true);
    expect(enabled?.source).toBe("default");
  });
});
