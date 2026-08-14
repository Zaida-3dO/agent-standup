// src/lib/settings-page/model.ts — the page's structure, derived from the
// registry and the `GET /settings` answer (MILESTONES.md #86: categories,
// value-source badges, reset-to-default, the `sensitive` section).
import { describe, expect, it } from "vitest";
import {
  canReset,
  isGuarded,
  settingsPageModel,
  sourceBadge,
  type RenderedSetting,
  type SettingsResponse,
} from "@/lib/settings-page/model";
import {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  type SettingDefinition,
  type SettingKey,
} from "@/lib/settings";

/** The registry as a plain map, for lookups by a key the test narrowed itself. */
const registry: Readonly<Record<SettingKey, SettingDefinition>> = SETTINGS_REGISTRY;

/** One rendered setting, defaulting to the registry's own declaration for the key. */
function rendered(key: SettingKey, overrides: Partial<RenderedSetting> = {}): RenderedSetting {
  const definition = registry[key];
  return {
    key,
    value: definition.default,
    source: "default",
    label: definition.label,
    help: definition.help,
    category: definition.category,
    appliesWhen: definition.appliesWhen,
    sensitive: definition.sensitive,
    irreversible: definition.irreversible,
    ...overrides,
  };
}

/** A full server answer: every declared key at its default, nothing else. */
function response(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    settings: SETTING_KEYS.map((key) => rendered(key)),
    unrecognised: [],
    constants: [],
    bootstrap: [],
    revision: "7",
    ...overrides,
  };
}

describe("value-source badges", () => {
  it("names each of the three sources SCHEMA.md §17.2 distinguishes", () => {
    expect(sourceBadge(rendered("items.max_depth", { source: "default" }))).toBe("Default");
    expect(sourceBadge(rendered("items.max_depth", { source: "override" }))).toBe("Overridden");
    expect(sourceBadge(rendered("items.max_depth", { source: "invalid-override" }))).toBe(
      "Invalid override",
    );
  });

  it("falls back to the most cautious badge for a source it does not recognise", () => {
    // A field whose provenance cannot be established must not look like one
    // sitting safely at its default.
    const odd = { ...rendered("items.max_depth"), source: "wat" } as unknown as RenderedSetting;
    expect(sourceBadge(odd)).toBe("Invalid override");
  });
});

describe("reset-to-default is offered exactly where it does something", () => {
  it("is not offered at the default — there is no override row to clear", () => {
    expect(canReset(rendered("items.max_depth", { source: "default" }))).toBe(false);
  });

  it("is offered for an override", () => {
    expect(canReset(rendered("items.max_depth", { source: "override" }))).toBe(true);
  });

  it("is offered for an invalid override — the case it matters most for", () => {
    // §17.3 serves an invalid override *displaying its default*, so a rule
    // keyed on the displayed value would hide the one button that fixes it.
    expect(canReset(rendered("items.max_depth", { source: "invalid-override" }))).toBe(true);
  });
});

describe("the guarded section", () => {
  it("takes a field when either flag is set, matching the command line's rule", () => {
    expect(isGuarded({ sensitive: true, irreversible: false })).toBe(true);
    expect(isGuarded({ sensitive: false, irreversible: true })).toBe(true);
    expect(isGuarded({ sensitive: true, irreversible: true })).toBe(true);
    expect(isGuarded({ sensitive: false, irreversible: false })).toBe(false);
  });

  it("holds exactly the registry's flagged keys", () => {
    const model = settingsPageModel(response());
    const guarded = model.guarded.map((field) => field.key).sort();
    const expected = SETTING_KEYS.filter((key) => {
      const definition = registry[key];
      return definition.sensitive || definition.irreversible;
    })
      .slice()
      .sort();
    expect(guarded).toEqual(expected);
    expect(guarded.length).toBeGreaterThan(0);
  });

  it("puts a guarded field in the guarded section and nowhere else", () => {
    // Two inputs writing one key would mean the second one visited silently
    // overwrites the first.
    const model = settingsPageModel(response());
    const inSections = model.sections.flatMap((section) => section.fields.map((f) => f.key));
    for (const field of model.guarded) {
      expect(inSections, field.key).not.toContain(field.key);
    }
    const all = [...inSections, ...model.guarded.map((f) => f.key)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("categories come from the registry", () => {
  it("files every ordinary key under the category the registry declares for it", () => {
    const model = settingsPageModel(response());
    for (const section of model.sections) {
      for (const field of section.fields) {
        expect(registry[field.key as SettingKey].category, field.key).toBe(section.category);
      }
    }
  });

  it("shows no empty category headings", () => {
    const model = settingsPageModel(response());
    for (const section of model.sections) {
      expect(section.fields.length, section.category).toBeGreaterThan(0);
    }
  });

  it("ignores a category the server made up, filing by the registry instead", () => {
    // The registry is the source of the category and it is a closed list;
    // trusting a free string from the response would open a section that
    // matches no heading and drop the field out of the page entirely.
    const model = settingsPageModel(
      response({
        settings: SETTING_KEYS.map((key) => rendered(key, { category: "Nonsense" })),
      }),
    );
    const placed = model.sections.flatMap((s) => s.fields.map((f) => f.key));
    const guarded = model.guarded.map((f) => f.key);
    expect(new Set([...placed, ...guarded]).size).toBe(SETTING_KEYS.length);
  });
});

describe("every declared key renders, whatever the server sent", () => {
  it("renders all of them when the server sent all of them", () => {
    const model = settingsPageModel(response());
    const keys = [
      ...model.sections.flatMap((s) => s.fields.map((f) => f.key)),
      ...model.guarded.map((f) => f.key),
    ];
    expect(keys.slice().sort()).toEqual(SETTING_KEYS.slice().sort());
  });

  it("still renders a key the server omitted, at its registry default", () => {
    // A settings page that silently omits a field is worse than one showing
    // a stale value: nobody looks for something they cannot see is missing.
    const partial = response({
      settings: SETTING_KEYS.filter((key) => key !== "items.max_depth").map((key) => rendered(key)),
    });
    const model = settingsPageModel(partial);
    const keys = [
      ...model.sections.flatMap((s) => s.fields.map((f) => f.key)),
      ...model.guarded.map((f) => f.key),
    ];
    expect(keys).toContain("items.max_depth");
    const field = model.sections.flatMap((s) => s.fields).find((f) => f.key === "items.max_depth");
    expect(field?.value).toBe(SETTINGS_REGISTRY["items.max_depth"].default);
    expect(field?.badge).toBe("Default");
  });

  it("renders every key even when the server sent none at all", () => {
    const model = settingsPageModel(response({ settings: [] }));
    const keys = [
      ...model.sections.flatMap((s) => s.fields.map((f) => f.key)),
      ...model.guarded.map((f) => f.key),
    ];
    expect(keys.slice().sort()).toEqual(SETTING_KEYS.slice().sort());
  });

  it("gives every field a widget, its help, and when it applies", () => {
    const model = settingsPageModel(response());
    const all = [...model.sections.flatMap((s) => s.fields), ...model.guarded];
    for (const field of all) {
      expect(field.widget, field.key).not.toBeNull();
      expect(field.help.length, field.key).toBeGreaterThan(0);
      expect(field.appliesWhen.length, field.key).toBeGreaterThan(0);
    }
  });
});

describe("the invalid-override detail is carried through", () => {
  it("keeps the stored value and the errors beside the field", () => {
    const model = settingsPageModel(
      response({
        settings: SETTING_KEYS.map((key) =>
          key === "items.max_depth"
            ? rendered(key, {
                source: "invalid-override",
                invalidOverride: { storedValue: 999, errors: ["too big"] },
              })
            : rendered(key),
        ),
      }),
    );
    const field = model.sections.flatMap((s) => s.fields).find((f) => f.key === "items.max_depth");
    expect(field?.badge).toBe("Invalid override");
    expect(field?.invalidOverride).toEqual({ storedValue: 999, errors: ["too big"] });
    expect(field?.canReset).toBe(true);
  });

  it("omits the detail entirely for a field that has none", () => {
    const model = settingsPageModel(response());
    const field = model.sections.flatMap((s) => s.fields).find((f) => f.key === "items.max_depth");
    expect(field?.invalidOverride).toBeUndefined();
  });
});

describe("the passthrough collections", () => {
  it("carries the unrecognised rows, constants, bootstrap and revision", () => {
    const model = settingsPageModel(
      response({
        unrecognised: [{ key: "old.key", storedValue: 1 }],
        constants: [{ name: "APP_VERSION", value: "1.2.3", meaning: "what" }],
        bootstrap: [{ name: "DATABASE_URL", set: true, meaning: "why" }],
        revision: "42",
      }),
    );
    expect(model.unrecognised).toEqual([{ key: "old.key", storedValue: 1 }]);
    expect(model.constants[0]?.value).toBe("1.2.3");
    expect(model.bootstrap[0]?.set).toBe(true);
    expect(model.revision).toBe("42");
  });

  it("survives a response missing them entirely rather than blanking the page", () => {
    const stripped = { settings: [], revision: "0" } as unknown as SettingsResponse;
    const model = settingsPageModel(stripped);
    expect(model.unrecognised).toEqual([]);
    expect(model.constants).toEqual([]);
    expect(model.bootstrap).toEqual([]);
  });
});
