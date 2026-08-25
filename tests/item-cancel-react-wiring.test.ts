// @vitest-environment jsdom
//
// **Cancelling, mounted in real React** — the fourth file in this suite to do
// that, and it exists for the reason the three before it do.
//
// `tests/board-react-wiring.test.ts` was written after a value assigned inside
// a `setDrag` updater was read on the line after it, so the very first drop
// sent nothing. `tests/undo-toast-host-wiring.test.ts` followed the identical
// defect in `UndoToastHost.onUndo`. `tests/item-archive-react-wiring.test.ts`
// covers the archive half of this panel. Every time, the unit tests stayed
// green, because every pure function being composed was correct on its own.
// The defect was in the composition, and only a mounted component sees it.
//
// This file covers the cancel affordance, which has three compositions worth
// pinning and no unit test that can reach any of them:
//
//   1. **The cancellation is issued at all.** `submitCancel` can be correct,
//      `CancelAction` can render a correct button, and the page can still send
//      nothing if the handler reads the composed decision from somewhere not
//      populated at the moment of the click. `onCancelItem` reads a ref
//      synchronously to avoid it; this asserts the ref actually works.
//   2. **The two acts stay distinguishable in the rendered tree.** The whole
//      row this comes from is about archive and cancel being conflated. A
//      regression that made cancel post a `DELETE`, or made one control's
//      copy match the other's, is a product defect that no type checks.
//   3. **A cancellation carries a decision and claims nothing shipped.** The
//      summary validator refuses a non-delivery close that also claims
//      delivery — but only if the client actually sends the non-delivery
//      shape. A body assembled wrongly is refused by the *server*, which is a
//      round trip and an error message rather than a working control.
//
// ── StrictMode, so the recurring defect cannot pass here ────────────────
//
// Mounted under `StrictMode` so updaters are double-invoked and React's
// deferral paths are live. Either mechanism alone reproduces the recurring
// defect; running under StrictMode means a regression to the updater-derived
// shape fails here rather than passing and shipping.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** The repo
// is deliberately `environment: "node"` with no DOM library, and that is worth
// keeping — it is what stops component logic drifting back out of the testable
// seams it was extracted into. The docblock above scopes the DOM to this file
// alone, matching the three wiring tests that came before it.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemDetailContainer } from "@/components/item-detail/ItemDetailContainer";
import { UndoToastHost } from "@/components/toast/UndoToastHost";
import { ProfileContext } from "@/lib/profile/ProfileProvider";
import { CANCEL_HOW_VERIFIED } from "@/lib/item-detail/cancel-state";

/** Every non-GET request that reached the stubbed network, in order. */
const writes: { method: string; url: string; body: unknown }[] = [];

/** What the next transition (`POST …/transition`) responds with. Replaced per test. */
let transitionResponse: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { outcome: { allowed: true } },
};

/** The item the detail read returns. Mutated per test to change its state. */
let itemFixture: Record<string, unknown>;

let container: HTMLDivElement;
let root: Root;

function anItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-a",
    parentId: null,
    title: "A card",
    headline: null,
    body: "",
    kind: "task",
    state: "on_deck",
    priority: "P2",
    area: "web",
    repo: null,
    branch: null,
    blockedReason: null,
    blockedOnType: null,
    blockedOnPersonId: null,
    unblockAt: null,
    pauseReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    originType: "person",
    archivedAt: null,
    archivedReason: null,
    supersededById: null,
    ...overrides,
  };
}

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  writes.length = 0;
  itemFixture = anItem();
  transitionResponse = { ok: true, status: 200, body: { outcome: { allowed: true } } };
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.includes("/detail")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              detail: {
                item: itemFixture,
                column: "backlog",
                subtasks: [],
                artifacts: [],
                history: [],
                historyTruncated: false,
                summary: null,
                assignments: [],
                previousHolders: [],
              },
            }),
        } as Response);
      }

      const body =
        init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
      writes.push({ method, url, body });

      return Promise.resolve({
        ok: transitionResponse.ok,
        status: transitionResponse.status,
        json: () => Promise.resolve(transitionResponse.body),
      } as Response);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/**
 * Mounts the real container inside a real `UndoToastHost`, under StrictMode.
 *
 * The toast host is mounted for the same reason the archive file mounts it —
 * `useUndo()` throws outside a provider — even though cancelling deliberately
 * offers no undo. One of the tests below asserts that absence, and it would be
 * vacuous if the host were missing: no toast can appear when nothing can host
 * one. Mounting it is what makes "no undo is offered" a real observation.
 *
 * `ProfileContext` is supplied directly rather than by mounting
 * `ProfileProvider`, because that provider fetches the people list on mount
 * and nothing here needs a profile.
 */
async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          ProfileContext.Provider,
          {
            value: {
              activeProfile: null,
              people: [],
              loadState: { status: "loaded", people: [] },
              setActiveProfile: () => {},
              pickerOpen: false,
              openPicker: () => {},
              closePicker: () => {},
            } as never,
          },
          createElement(
            UndoToastHost,
            null,
            createElement(ItemDetailContainer, { itemId: "item-a" }),
          ),
        ),
      ),
    );
  });
}

/** The one button carrying `data-region`, or null. */
function button(region: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[data-region="${region}"]`);
}

/** Types `text` into the decision box the way a person would. */
async function typeDecision(text: string): Promise<void> {
  const box = container.querySelector<HTMLTextAreaElement>(
    'textarea[data-region="cancel-decision-input"]',
  );
  if (box === null) throw new Error("no decision box is rendered");
  await act(async () => {
    // React tracks the last value it set on the node and skips the change
    // event when the new value matches it, so the setter has to be called on
    // the prototype for a programmatic change to reach `onChange`.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A decision that clears the twenty-character floor. */
const GOOD_DECISION = "Superseded by the new auth flow; we are not doing this separately.";

/** Opens the form and composes a valid decision. */
async function composeCancel(): Promise<void> {
  await act(async () => {
    button("cancel-begin")?.click();
  });
  await typeDecision(GOOD_DECISION);
}

/** Every transition request that reached the network. */
function transitions(): { method: string; url: string; body: unknown }[] {
  return writes.filter((w) => w.url.includes("/transition"));
}

describe("the item detail page's cancel affordance, mounted in real React", () => {
  it("renders the cancel control on a live open item, so the assertions below are not vacuous", async () => {
    // Guards the guard. Every test here asserts on the effect of a click, so
    // if the control stopped rendering they would all pass by never clicking
    // anything. This states the precondition directly and fails first.
    await mount();

    expect(button("cancel-begin")).not.toBeNull();
    // And cancelling is not one click away, for the same reason archiving is
    // not — the deliberateness test below is what actually pins this.
    expect(button("cancel-confirm")).toBeNull();
  });

  it("sends exactly one cancellation, carrying the composed decision", async () => {
    // **The assertion this file exists for, part one.**
    //
    // `onCancelItem` reads the composed decision from a ref, synchronously,
    // before any `setState`. Deriving it inside a `setCancelState` updater
    // instead — the shape that has shipped three times in this repo — makes
    // this **zero requests**: the early return fires while the state has
    // already advanced, so the count is zero rather than a request with a
    // wrong body.
    await mount();
    await composeCancel();

    await act(async () => {
      button("cancel-confirm")?.click();
    });

    const sent = transitions();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.url).toContain("item-a");

    const body = sent[0]?.body as {
      to: string;
      expectedFrom: string;
      fields: { summary: Record<string, unknown> };
    };
    expect(body.to).toBe("cancelled");
    // The precondition rides along, so a cancellation composed against a page
    // that has since moved is refused rather than applied over the move.
    expect(body.expectedFrom).toBe("on_deck");
    expect(body.fields.summary.decision).toBe(GOOD_DECISION);
  });

  it("claims nothing shipped, which is what makes it a cancellation and not a completion", async () => {
    // **Part three.** The summary validator refuses a non-delivery close that
    // also claims delivery — but that refusal only fires if the client sends
    // the non-delivery shape in the first place. A body that put the decision
    // into `shipped`, or that left `shipped` populated, would be refused by
    // the server: a round trip and an error instead of a working control.
    //
    // This also pins the `how_verified` the module derives. The field is
    // required for any close with `user_facing: false`, and deriving it is a
    // deliberate call (see `CANCEL_HOW_VERIFIED`) — asserting it here means a
    // change to that policy has to be made on purpose.
    await mount();
    await composeCancel();

    await act(async () => {
      button("cancel-confirm")?.click();
    });

    const summary = (transitions()[0]?.body as { fields: { summary: Record<string, unknown> } })
      .fields.summary;
    expect(summary.shipped).toEqual([]);
    expect(summary.user_facing).toBe(false);
    expect(summary.how_verified).toBe(CANCEL_HOW_VERIFIED);
  });

  it("cancels through the transition endpoint and never through the archive one", async () => {
    // **Part two — the conflation this whole row is about.**
    //
    // Cancelling must not archive. A regression that wired the cancel button
    // to `submitArchive` would look correct on screen, would leave the page
    // apparently working, and would hide the row while recording nothing about
    // the decision — which is precisely the harm the archive guard refuses
    // cancellation-shaped reasons to prevent. It would pass every other test
    // in this file except this one.
    await mount();
    await composeCancel();

    await act(async () => {
      button("cancel-confirm")?.click();
    });

    expect(writes.filter((w) => w.method === "DELETE")).toHaveLength(0);
    expect(transitions()).toHaveLength(1);
  });

  it("does not cancel on a single click — the decision form stands between", async () => {
    // The deliberateness criterion, asserted rather than asserted-about. One
    // click on the cancel control must reach a form, not the network.
    await mount();

    await act(async () => {
      button("cancel-begin")?.click();
    });

    expect(transitions()).toHaveLength(0);
    expect(container.querySelector('[data-region="cancel-form"]')).not.toBeNull();
  });

  it("keeps the cancel control disabled until the decision is long enough", async () => {
    // The second half of deliberateness: the form cannot be submitted with a
    // shrug. The validator would refuse a short decision anyway — this is what
    // stops the person being sent on a round trip to learn what the hint
    // already says.
    await mount();

    await act(async () => {
      button("cancel-begin")?.click();
    });
    await typeDecision("nope");

    expect(button("cancel-confirm")?.disabled).toBe(true);

    await act(async () => {
      button("cancel-confirm")?.click();
    });
    expect(transitions()).toHaveLength(0);

    await typeDecision(GOOD_DECISION);
    expect(button("cancel-confirm")?.disabled).toBe(false);
  });

  it("keeps the typed decision after a refusal, so rewording is an edit", async () => {
    // A refusal that clears the box makes the person retype a sentence they
    // just composed, which is the most annoying possible way to enforce a
    // guard. The server's sentence is shown verbatim beside it.
    transitionResponse = {
      ok: false,
      status: 422,
      body: {
        error: {
          message: "decision is 14 characters, under the 20-character floor.",
          code: "guard_rejected",
          fields: ["decision"],
        },
      },
    };
    await mount();
    await composeCancel();

    await act(async () => {
      button("cancel-confirm")?.click();
    });

    const box = container.querySelector<HTMLTextAreaElement>(
      'textarea[data-region="cancel-decision-input"]',
    );
    expect(box?.value).toBe(GOOD_DECISION);
    // The server's own sentence, not a generic substitute.
    expect(container.textContent).toContain("under the 20-character floor");
  });

  it("offers no undo for a cancellation, unlike an archive", async () => {
    // Deliberate, not an omission — see `runCancel`. An undo exists for acts
    // whose effect is hard to see; a cancelled row stays exactly where it was,
    // visibly cancelled and carrying its decision, so the mistake announces
    // itself and is fixed by transitioning the row again.
    //
    // Asserted because the opposite is what a reader would assume from the
    // archive path next to it, and because the toast host IS mounted here —
    // so this observes a real absence rather than a missing provider.
    await mount();
    await composeCancel();

    await act(async () => {
      button("cancel-confirm")?.click();
    });

    expect(container.querySelector('[data-phase="offered"]')).toBeNull();
  });

  it("offers no cancel control on an item that is already closed, and says why", async () => {
    // Cancelling records a decision to stop work that is still open. Offering
    // it on a merged row would be a control whose only outcome is a refusal.
    itemFixture = anItem({ state: "merged", completedAt: "2026-01-02T00:00:00.000Z" });
    await mount();

    expect(button("cancel-begin")).toBeNull();
    expect(container.querySelector('[data-region="cancel-already-closed"]')).not.toBeNull();
    // Named, so "nothing to cancel here" is not a mystery.
    expect(container.textContent).toContain("merged");
  });

  it("presents cancelling and archiving as two different acts", async () => {
    // **The criterion the row cares about most**, and the one nothing else
    // here would catch: two controls that look alike would be a worse outcome
    // than one control, because a person who can tell the two acts apart picks
    // correctly, and one facing two matching buttons picks by coin-flip.
    //
    // Asserted on the copy that states the *consequence*, which is the actual
    // difference between them — one hides the row, the other keeps it. A
    // change that made both say the same thing fails here.
    await mount();

    const cancelStart = container.querySelector('[data-region="cancel-start"]');
    const archiveStart = container.querySelector('[data-region="archive-start"]');
    expect(cancelStart).not.toBeNull();
    expect(archiveStart).not.toBeNull();

    expect(cancelStart?.textContent).toContain("stays visible");
    expect(archiveStart?.textContent).toContain("Removes it from the board");
    expect(cancelStart?.textContent).not.toEqual(archiveStart?.textContent);
  });

  it("asks a different question in each form, which is how a person finds out which act they are in", async () => {
    // The forms are where the choice is actually made, and their prompts are
    // the load-bearing copy: "why should this item not exist?" and "why is
    // this work not being done?" cannot both be answered honestly about the
    // same row.
    await mount();

    await act(async () => {
      button("cancel-begin")?.click();
    });
    expect(container.querySelector('[data-region="cancel-form"]')?.textContent).toContain(
      "Why is this work not being done?",
    );

    await act(async () => {
      button("cancel-abandon")?.click();
    });
    await act(async () => {
      button("archive-begin")?.click();
    });
    expect(container.querySelector('[data-region="archive-form"]')?.textContent).toContain(
      "Why should this item not exist?",
    );
  });
});
