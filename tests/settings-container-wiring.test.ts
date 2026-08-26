// @vitest-environment jsdom
//
// **`Settings`, mounted in real React.**
//
// `tests/settings-page-state.test.ts` proves `writeSetting` serialises
// whatever `value`/`typed` it is handed and gates on confirmation.
// `tests/settings-page-widget.test.ts` proves `inputToValue` parses a raw
// string correctly for a given widget kind. `tests/settings-view-component.test.ts`
// proves `SettingField` calls `onSave(field.key)` when its button is
// pressed. None of the three can see `Settings.tsx`'s `onSave` callback
// itself — the seam this row is about — which:
//
//   1. resolves the field's widget from the registry (`widgetFor`),
//   2. reads that key's stored value out of `loadState`,
//   3. falls back to the draft only if the person has typed one
//      (`drafts[key] ?? stored`),
//   4. parses that through `inputToValue`, and
//   5. only THEN calls `writeSetting`, passing along whatever sits in
//      `confirmations[key]`.
//
// A caller that sent a literal, skipped the draft fallback, sent the wrong
// key's confirmation text, or read `drafts[key]` unconditionally (losing the
// "show the stored value until touched" behaviour) would satisfy every
// individual unit test above while sending the wrong request. Only a test
// that types into the real rendered field and presses the real rendered
// button can see it — this is the same needs-you shape as
// tests/project-detail-container-wiring.test.ts.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** Same
// reasoning as the other `*-wiring.test.ts` files: the repo is deliberately
// `environment: "node"` with no DOM, and this is the narrow, deliberate
// exception. It asserts that the right request reaches the network, not
// what the page looks like.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "@/components/settings/Settings";
import { SETTINGS_REGISTRY, SETTING_KEYS, type SettingKey } from "@/lib/settings";
import type { RenderedSetting, SettingsResponse } from "@/lib/settings-page/model";

/** A key with a plain number widget, unguarded — matches `tests/settings-view-component.test.ts`'s `PLAIN_KEY`. */
const PLAIN_KEY: SettingKey = "items.max_depth";
/** A sensitive (guarded) key, so the confirmation-gated path is exercised too. */
const SENSITIVE_KEY: SettingKey = "budget.enabled";

function rendered(key: SettingKey, overrides: Partial<RenderedSetting> = {}): RenderedSetting {
  const definition = SETTINGS_REGISTRY[key];
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

function settingsResponse(): SettingsResponse {
  return {
    settings: SETTING_KEYS.map((key) => rendered(key)),
    unrecognised: [],
    constants: [],
    bootstrap: [],
    revision: "3",
  };
}

/** Every `PUT /api/settings/{key}` the stubbed network received. */
const writeCalls: { key: string; body: unknown }[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  writeCalls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/ui/settings/") && method === "PUT") {
        const key = decodeURIComponent(url.split("/api/ui/settings/")[1] ?? "");
        writeCalls.push({ key, body: JSON.parse(String(init?.body ?? "{}")) as unknown });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        } as Response);
      }
      if (url.includes("/api/ui/settings")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(settingsResponse()),
        } as Response);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Mounts the real container under StrictMode and lets the mount-time load resolve. */
async function mountSettings(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(StrictMode, null, createElement(Settings)));
  });
}

function fieldInput(key: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`[id="setting-${key}"]`);
  if (!input) throw new Error(`no input rendered for ${key} — the fixture is wrong, not the code`);
  return input as HTMLInputElement;
}

function saveButton(key: string): HTMLButtonElement {
  const input = fieldInput(key);
  const field = input.closest("li");
  const button = Array.from(field?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent === "Save",
  );
  if (!button) throw new Error(`no Save button rendered for ${key}`);
  return button;
}

function confirmInput(key: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `[aria-label="Type ${key} to confirm"]`,
  );
  if (!input) throw new Error(`no confirmation input rendered for ${key}`);
  return input;
}

/** Types into a controlled input the way React sees a real keystroke — matches `tests/budget-editor-wiring.test.ts`. */
async function type(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Settings, mounted in real React", () => {
  it("renders the plain field's editor, so the assertions below are not vacuous", async () => {
    await mountSettings();
    expect(fieldInput(PLAIN_KEY)).not.toBeNull();
    expect(saveButton(PLAIN_KEY)).not.toBeNull();
  });

  it("saves the typed draft value, parsed, not the stored value", async () => {
    // **The core assertion.** With the defect shape this row is named
    // after — `onSave` reading the stored value unconditionally instead of
    // `drafts[key] ?? stored` — this sends the unedited default (6) instead
    // of what was typed. No unit test of `inputToValue` or `writeSetting`
    // can see this: each is handed a value directly by its own test.
    await mountSettings();

    await type(fieldInput(PLAIN_KEY), "9");
    await act(async () => {
      saveButton(PLAIN_KEY).click();
    });

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.key).toBe(PLAIN_KEY);
    // Parsed to a number, not sent as the raw string "9" — proves
    // `inputToValue` actually ran on the draft rather than the draft being
    // forwarded verbatim.
    expect(writeCalls[0]?.body).toEqual({ value: 9 });
  });

  it("saves the stored default when the field was never touched", async () => {
    // The other arm of the `drafts[key] ?? stored` fallback: a caller that
    // always read `drafts[key]` (with no fallback) would send `undefined`
    // for an untouched field, and `JSON.stringify` would either drop the
    // key or crash rather than send the field's actual current value.
    await mountSettings();

    await act(async () => {
      saveButton(PLAIN_KEY).click();
    });

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.body).toEqual({ value: SETTINGS_REGISTRY[PLAIN_KEY].default });
  });

  it("does not reach the network when a guarded key's confirmation is missing", async () => {
    // The confirmation gate lives in `writeSetting` (`confirmWrite`), but
    // whether it is even given a chance to run depends on `Settings.tsx`
    // actually forwarding `confirmations[key]` — an `onSave` that hard-coded
    // `typed: null` would still call `writeSetting`, and the gate would
    // still refuse it for the RIGHT reason but by ACCIDENT, masking a caller
    // that dropped the confirmation box's contents entirely.
    await mountSettings();

    await act(async () => {
      saveButton(SENSITIVE_KEY).click();
    });

    expect(writeCalls).toHaveLength(0);
    const field = fieldInput(SENSITIVE_KEY).closest("li");
    expect(field?.textContent).toContain(SENSITIVE_KEY);
  });

  it("reaches the network once the guarded key's own text is typed into confirmation", async () => {
    // Proves the confirmation box's value is the thing forwarded — not a
    // hard-coded pass, and not some other field's confirmation text
    // (confirmations is a per-key map; a caller that read the wrong key, or
    // a shared variable, would pass here for the wrong reason and fail this
    // one only under a fixture with two guarded fields, which this suite
    // does not need in order to catch the plainer version of that mistake).
    await mountSettings();

    await type(confirmInput(SENSITIVE_KEY), SENSITIVE_KEY);
    await act(async () => {
      saveButton(SENSITIVE_KEY).click();
    });

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.key).toBe(SENSITIVE_KEY);
  });
});
