// src/components/settings/SettingsView.tsx and SettingField.tsx — the
// branch selection and the widget rendering for MILESTONES.md #86.
//
// Hook-free and prop-driven (see each component's header), so they are
// called directly as functions and their returned element trees inspected —
// same technique as tests/app-shell-view.test.ts and
// tests/board-view-component.test.ts.
import { describe, expect, it, vi } from "vitest";
import { SettingsView, type SettingsViewProps } from "@/components/settings/SettingsView";
import { SettingField } from "@/components/settings/SettingField";
import type { RenderedSetting, SettingsResponse } from "@/lib/settings-page/model";
import {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  type SettingDefinition,
  type SettingKey,
} from "@/lib/settings";
import { findAllByType, walk } from "./helpers/react-element";

/** The registry as a plain map, for lookups by a key the test narrowed itself. */
const registry: Readonly<Record<SettingKey, SettingDefinition>> = SETTINGS_REGISTRY;

const SENSITIVE_KEY = "budget.enabled";
const IRREVERSIBLE_KEY = "retention.tool_calls_days";
const PLAIN_KEY = "items.max_depth";

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

function response(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    settings: SETTING_KEYS.map((key) => rendered(key)),
    unrecognised: [],
    constants: [],
    bootstrap: [],
    revision: "3",
    ...overrides,
  };
}

function baseProps(overrides: Partial<SettingsViewProps> = {}): SettingsViewProps {
  return {
    loadState: { status: "loaded", response: response() },
    drafts: {},
    confirmations: {},
    errors: {},
    onDraftChange: () => {},
    onConfirmChange: () => {},
    onSave: () => {},
    onReset: () => {},
    onRemoveUnrecognised: () => {},
    ...overrides,
  };
}

/** Every string of text anywhere in the tree, joined — for "does the page say X" assertions. */
function textOf(element: unknown): string {
  const parts: string[] = [];
  for (const node of walk(element as never)) {
    const children = (node.props as { children?: unknown }).children;
    const collect = (value: unknown): void => {
      if (typeof value === "string") parts.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
    };
    collect(children);
  }
  return parts.join(" ");
}

describe("the load branches", () => {
  it("shows the error message and nothing else when the load failed", () => {
    const element = SettingsView(baseProps({ loadState: { status: "error", message: "boom" } }));
    expect(textOf(element)).toContain("boom");
    expect(findAllByType(element, SettingField).length).toBe(0);
  });

  it("shows a loading state before the answer arrives", () => {
    const element = SettingsView(baseProps({ loadState: { status: "loading" } }));
    expect(textOf(element)).toContain("Loading settings");
    expect(findAllByType(element, SettingField).length).toBe(0);
  });

  it("renders a field for every declared key once loaded", () => {
    const element = SettingsView(baseProps());
    const fields = findAllByType(element, SettingField);
    expect(fields.length).toBe(SETTING_KEYS.length);
    const keys = fields.map((field) => (field.props as { field: { key: string } }).field.key);
    expect(new Set(keys).size).toBe(SETTING_KEYS.length);
  });

  it("shows the revision, so it is visible what the page was read at", () => {
    expect(textOf(SettingsView(baseProps()))).toContain("3");
  });
});

// T13: the non-first-run entry to profile management — extends #86's
// existing first-run entry rather than duplicating a second profile UI.
describe("the profile management link", () => {
  function findAdminPeopleLink(element: unknown) {
    return [...walk(element as never)].find((el) => {
      const href = (el.props as { href?: string }).href;
      return href === "/admin/people";
    });
  }

  it("links to /admin/people once settings have loaded", () => {
    const element = SettingsView(baseProps());
    expect(findAdminPeopleLink(element)).toBeTruthy();
  });

  it("is absent on the error branch", () => {
    const element = SettingsView(baseProps({ loadState: { status: "error", message: "boom" } }));
    expect(findAdminPeopleLink(element)).toBeUndefined();
  });

  it("is absent on the loading branch", () => {
    const element = SettingsView(baseProps({ loadState: { status: "loading" } }));
    expect(findAdminPeopleLink(element)).toBeUndefined();
  });
});

describe("the guarded section", () => {
  it("carries the heading SCHEMA.md §17.8 specifies", () => {
    expect(textOf(SettingsView(baseProps()))).toContain("These change what the system enforces");
  });

  it("renders the guarded keys inside it and not in their categories", () => {
    const element = SettingsView(baseProps());
    const fields = findAllByType(element, SettingField);
    const guardedRendered = fields
      .map(
        (field) =>
          (field.props as { field: { key: string; sensitive: boolean; irreversible: boolean } })
            .field,
      )
      .filter((field) => field.sensitive || field.irreversible);
    expect(guardedRendered.length).toBeGreaterThan(0);
    // Each guarded key appears exactly once across the whole page.
    const keys = fields.map((f) => (f.props as { field: { key: string } }).field.key);
    for (const field of guardedRendered) {
      expect(keys.filter((key) => key === field.key).length, field.key).toBe(1);
    }
  });
});

describe("the unrecognised section", () => {
  it("is absent when there are no unrecognised rows", () => {
    expect(textOf(SettingsView(baseProps()))).not.toContain("Unrecognised");
  });

  it("lists a stored row and its value when there is one", () => {
    const element = SettingsView(
      baseProps({
        loadState: {
          status: "loaded",
          response: response({ unrecognised: [{ key: "retired.key", storedValue: { a: 1 } }] }),
        },
      }),
    );
    const text = textOf(element);
    expect(text).toContain("Unrecognised");
    expect(text).toContain("retired.key");
    expect(text).toContain(JSON.stringify({ a: 1 }));
  });

  it("offers a remove action that calls back with the row's key", () => {
    const onRemoveUnrecognised = vi.fn();
    const element = SettingsView(
      baseProps({
        onRemoveUnrecognised,
        loadState: {
          status: "loaded",
          response: response({ unrecognised: [{ key: "retired.key", storedValue: 1 }] }),
        },
      }),
    );
    const buttons = [...walk(element as never)].filter(
      (node) =>
        node.type === "button" && (node.props as { children?: unknown }).children === "Remove",
    );
    expect(buttons.length).toBe(1);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onRemoveUnrecognised).toHaveBeenCalledWith("retired.key");
  });
});

describe("the read-only panels", () => {
  it("shows the build constants with their values", () => {
    const element = SettingsView(
      baseProps({
        loadState: {
          status: "loaded",
          response: response({
            constants: [{ name: "APP_VERSION", value: "1.2.3", meaning: "the version" }],
          }),
        },
      }),
    );
    const text = textOf(element);
    expect(text).toContain("Build constants");
    expect(text).toContain("APP_VERSION");
    expect(text).toContain("1.2.3");
  });

  it("shows bootstrap variables as set or not set, never as a value", () => {
    const element = SettingsView(
      baseProps({
        loadState: {
          status: "loaded",
          response: response({
            bootstrap: [
              { name: "DATABASE_URL", set: true, meaning: "postgres" },
              { name: "STANDUP_URL", set: false, meaning: "a server" },
            ],
          }),
        },
      }),
    );
    const text = textOf(element);
    expect(text).toContain("Bootstrap");
    expect(text).toContain("set");
    expect(text).toContain("not set");
  });

  it("says so rather than rendering an empty panel when a panel has no rows", () => {
    expect(textOf(SettingsView(baseProps()))).toContain("None reported.");
  });
});

describe("one field, drawn from its widget", () => {
  function fieldElement(key: string, extra: Record<string, unknown> = {}) {
    const view = SettingsView(baseProps());
    const match = findAllByType(view, SettingField).find(
      (node) => (node.props as { field: { key: string } }).field.key === key,
    );
    if (!match) throw new Error(`no field rendered for ${key}`);
    return SettingField({
      ...(match.props as Parameters<typeof SettingField>[0]),
      ...extra,
    } as Parameters<typeof SettingField>[0]);
  }

  it("renders a number input carrying the bounds from the key's own schema", () => {
    const element = fieldElement(PLAIN_KEY);
    const inputs = [...walk(element as never)].filter((node) => node.type === "input");
    const numberInput = inputs.find((node) => (node.props as { type?: string }).type === "number");
    expect(numberInput).toBeDefined();
    // items.max_depth is z.number().int().min(1).max(20).
    expect((numberInput!.props as { min?: number }).min).toBe(1);
    expect((numberInput!.props as { max?: number }).max).toBe(20);
  });

  it("renders an enum key as a select with exactly its declared options", () => {
    const element = fieldElement("agents.subagent_delegation");
    const options = [...walk(element as never)]
      .filter((node) => node.type === "option")
      .map((node) => (node.props as { value: string }).value);
    expect(options).toEqual(["never", "allowed", "required"]);
  });

  it("renders a boolean key as a two-option select", () => {
    const element = fieldElement(SENSITIVE_KEY);
    const options = [...walk(element as never)]
      .filter((node) => node.type === "option")
      .map((node) => (node.props as { value: string }).value);
    expect(options).toEqual(["true", "false"]);
  });

  it("renders a string-list key as a textarea", () => {
    const element = fieldElement("minting.source_globs");
    expect([...walk(element as never)].some((node) => node.type === "textarea")).toBe(true);
  });

  it("shows the key's help text and when a change applies", () => {
    const element = fieldElement(PLAIN_KEY);
    const text = textOf(element);
    expect(text).toContain(registry[PLAIN_KEY].help);
    expect(text).toContain(registry[PLAIN_KEY].appliesWhen);
  });

  it("shows a confirmation box for a guarded key, naming the key to type", () => {
    const element = fieldElement(SENSITIVE_KEY);
    const text = textOf(element);
    expect(text).toContain("to confirm");
    expect(text).toContain(SENSITIVE_KEY);
  });

  it("says data can be destroyed for the irreversible key specifically", () => {
    expect(textOf(fieldElement(IRREVERSIBLE_KEY))).toContain("destroy data");
  });

  it("shows no confirmation box for an ungated key", () => {
    expect(textOf(fieldElement(PLAIN_KEY))).not.toContain("to confirm");
  });

  it("offers no reset button at the default, and one for an override", () => {
    const atDefault = fieldElement(PLAIN_KEY);
    const buttonText = (element: unknown) =>
      [...walk(element as never)]
        .filter((node) => node.type === "button")
        .map((node) => (node.props as { children?: unknown }).children);
    expect(buttonText(atDefault)).not.toContain("Reset to default");

    const overridden = SettingField({
      ...(findAllByType(
        SettingsView(
          baseProps({
            loadState: {
              status: "loaded",
              response: response({
                settings: SETTING_KEYS.map((key) =>
                  key === PLAIN_KEY
                    ? rendered(key, { source: "override", value: 9 })
                    : rendered(key),
                ),
              }),
            },
          }),
        ),
        SettingField,
      ).find((node) => (node.props as { field: { key: string } }).field.key === PLAIN_KEY)!
        .props as Parameters<typeof SettingField>[0]),
    });
    expect(buttonText(overridden)).toContain("Reset to default");
  });

  it("shows the stored value and the validation errors for an invalid override", () => {
    const view = SettingsView(
      baseProps({
        loadState: {
          status: "loaded",
          response: response({
            settings: SETTING_KEYS.map((key) =>
              key === PLAIN_KEY
                ? rendered(key, {
                    source: "invalid-override",
                    invalidOverride: { storedValue: 999, errors: ["Number must be at most 20"] },
                  })
                : rendered(key),
            ),
          }),
        },
      }),
    );
    const match = findAllByType(view, SettingField).find(
      (node) => (node.props as { field: { key: string } }).field.key === PLAIN_KEY,
    )!;
    const text = textOf(SettingField(match.props as Parameters<typeof SettingField>[0]));
    expect(text).toContain("999");
    expect(text).toContain("Number must be at most 20");
    expect(text).toContain("Invalid override");
  });

  it("calls back with the key when save and reset are pressed", () => {
    const onSave = vi.fn();
    const onReset = vi.fn();
    const view = SettingsView(
      baseProps({
        onSave,
        onReset,
        loadState: {
          status: "loaded",
          response: response({
            settings: SETTING_KEYS.map((key) =>
              key === PLAIN_KEY ? rendered(key, { source: "override" }) : rendered(key),
            ),
          }),
        },
      }),
    );
    const match = findAllByType(view, SettingField).find(
      (node) => (node.props as { field: { key: string } }).field.key === PLAIN_KEY,
    )!;
    const element = SettingField(match.props as Parameters<typeof SettingField>[0]);
    const buttons = [...walk(element as never)].filter((node) => node.type === "button");
    for (const button of buttons) {
      (button.props as { onClick: () => void }).onClick();
    }
    expect(onSave).toHaveBeenCalledWith(PLAIN_KEY);
    expect(onReset).toHaveBeenCalledWith(PLAIN_KEY);
  });

  it("shows a per-field error message when one is supplied", () => {
    const element = fieldElement(PLAIN_KEY, { error: "That is not a number." });
    expect(textOf(element)).toContain("That is not a number.");
  });
});
