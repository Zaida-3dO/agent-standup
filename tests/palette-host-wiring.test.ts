// @vitest-environment jsdom
//
// **`PaletteHost`, mounted in real React — the scout's note that this has
// zero mount-level test of any kind.**
//
// `tests/palette-commands.test.ts` proves `stateChangeRequest(to, from)`
// serialises whatever `to`/`from` it is handed, and that a "change state"
// command's `intent.to` is the state on the button. `tests/palette-state.test.ts`
// proves `decidePaletteKey` turns `Enter` into a `run` action.
// `tests/command-palette-component.test.ts` proves `CommandPalette` calls
// `onRun(command)` when a row is clicked. **None of the three can see
// `PaletteHost.tsx`'s `runCommand`'s `change-state` case** — the seam this
// row is about:
//
//   const body = stateChangeRequest(command.intent.to, currentItem.state);
//
// `command.intent.to` is the command the person picked; `currentItem.state`
// is what the container fetched from the server for the item ON THE PAGE.
// A caller that sent a literal for either half — or read `command.intent.to`
// twice, or read the WRONG item's cached state — would satisfy every unit
// test above (each is handed its inputs directly) while sending a `from`
// that is not the page's own precondition, which is exactly the
// last-writer-wins clobber `stateChangeRequest`'s own header says this
// exists to prevent. Only a test that opens the real palette, picks a real
// row and inspects the real network body can see it.
//
// **Scope note.** `PaletteHost` is large — three overlays, a document key
// listener, a focus trap, quick-create. This file covers the `change-state`
// composition specifically, which the scout named as the sharpest instance
// of the needs-you shape here; it does not attempt full coverage of the
// component, in line with "depth over breadth".
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** Same
// reasoning as every other `*-wiring.test.ts` file in this suite.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteHost } from "@/components/palette/PaletteHost";

let currentPathname = "/items/item-a";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => currentPathname,
}));

/** Every `POST .../transition` the stubbed network received. */
const transitionCalls: { url: string; body: unknown }[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  currentPathname = "/items/item-a";
  transitionCalls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/transition")) {
        transitionCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
      }
      if (url.includes("/api/ui/items/item-a")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              item: { id: "item-a", title: "A live item", state: "on_deck" },
            }),
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

/** Mounts the real host under StrictMode, with a plain child so there is a page behind it. */
async function mountHost(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(StrictMode, null, createElement(PaletteHost, null, createElement("main"))),
    );
  });
}

function dialog(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error("no palette dialog rendered — the fixture is wrong, not the code");
  return el;
}

function commandInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Command"]');
  if (!input) throw new Error("no command input rendered — open the palette first");
  return input;
}

async function openPaletteWithCtrlK(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  // The item's state is fetched once the palette is open (see
  // PaletteHost's item-context effect) — let that resolve before a test
  // types a query or runs a command against it.
  await act(async () => {});
}

/** Types into the palette's own combobox — a controlled input, so the native setter is required. */
async function type(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PaletteHost, mounted in real React", () => {
  it("opens the palette on Ctrl+K, so the assertions below are not vacuous", async () => {
    await mountHost();
    await openPaletteWithCtrlK();
    expect(dialog()).not.toBeNull();
    expect(commandInput()).not.toBeNull();
  });

  it("shows the item fetched for the page, naming what the state verbs will act on", async () => {
    // Guards the fixture's other half: if `currentItem` never resolved,
    // the change-state row would not exist and the test below would pass
    // vacuously by finding nothing to click.
    await mountHost();
    await openPaletteWithCtrlK();
    expect(dialog().textContent).toContain("A live item");
  });

  it("sends the item's real fetched state as expectedFrom, not a guess", async () => {
    // **The assertion this file exists for.** With the defect shape this
    // row is named after — `runCommand` sending a literal, or the wrong
    // field, instead of `currentItem.state` — this either omits
    // `expectedFrom`, sends the wrong value, or sends the destination
    // twice. `tests/palette-commands.test.ts` cannot see this: it calls
    // `stateChangeRequest` directly with values IT chose.
    await mountHost();
    await openPaletteWithCtrlK();
    await type(commandInput(), "change state to executing");

    const row = Array.from(container.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.toLowerCase().includes("executing"),
    );
    if (!row) throw new Error("no 'change state to executing' row rendered");

    await act(async () => {
      (row as HTMLElement).click();
    });

    expect(transitionCalls).toHaveLength(1);
    expect(transitionCalls[0]?.url).toContain("/api/ui/items/item-a/transition");
    // The fixture's server-reported state is `on_deck` — not the
    // destination (`executing`), and not omitted.
    expect(transitionCalls[0]?.body).toEqual({ to: "executing", expectedFrom: "on_deck" });
  });
});
