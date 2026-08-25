// @vitest-environment jsdom
//
// **Archive and restore, mounted in real React** — the third file in this
// suite to do that, and it exists for the same reason as the first two.
//
// `tests/board-react-wiring.test.ts` was written after a value assigned inside
// a `setDrag` updater was read on the line after it, so the very first drop
// sent nothing. `tests/undo-toast-host-wiring.test.ts` was written after the
// identical defect recurred in `UndoToastHost.onUndo`. Both times every unit
// test stayed green, because every pure function being composed was correct
// on its own. The defect was in the composition — the thirty lines that call
// them in order — and only a mounted component can see it.
//
// This file covers the same seam for the archive affordance, which has two
// compositions worth pinning and no unit test that can reach either:
//
//   1. **The archive request is issued at all.** `submitArchive` can be
//      correct, `ArchiveAction` can render a correct button, and the page can
//      still send nothing — if the handler reads the composed reason from a
//      place that is not populated at the moment of the click. That is exactly
//      the shape that has shipped three times, and `onArchive` reads a ref
//      synchronously to avoid it. This asserts the ref actually works.
//
//   2. **The archive offers an undo.** `inverseOf({kind: "archive"})` derives
//      a real restore step and `runUndo` posts it — both directly tested — but
//      until something calls `offer` with an `archive` action, that entire
//      path is unreachable and its correctness buys nothing. A unit test on
//      `inverseOf` cannot tell whether anyone ever constructs the action. This
//      mounts the container inside a real `UndoToastHost` and asserts the
//      toast appears with a working Undo, and that pressing it posts a
//      restore.
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
// alone, matching the two wiring tests that came before it.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemDetailContainer } from "@/components/item-detail/ItemDetailContainer";
import { UndoToastHost } from "@/components/toast/UndoToastHost";
import { ProfileContext } from "@/lib/profile/ProfileProvider";

/** Every non-GET request that reached the stubbed network, in order. */
const writes: { method: string; url: string; body: unknown }[] = [];

/** What the next archive (`DELETE`) responds with. Replaced per test. */
let archiveResponse: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { archived: true },
};

/** What the next restore (`POST …/restore`) responds with. */
let restoreResponse: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { restored: true },
};

/** The item the detail read returns. Mutated per test to make it archived. */
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
  archiveResponse = { ok: true, status: 200, body: { archived: true } };
  restoreResponse = { ok: true, status: 200, body: { restored: true } };
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

      const chosen = url.includes("/restore") ? restoreResponse : archiveResponse;
      return Promise.resolve({
        ok: chosen.ok,
        status: chosen.status,
        json: () => Promise.resolve(chosen.body),
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
 * The toast host is the point of mounting it this way rather than rendering
 * the container alone: `useUndo()` returns a no-op outside a provider, so a
 * container mounted bare would call `offer` into the void and every undo
 * assertion below would pass vacuously by never rendering a toast. Wrapping it
 * in the same provider `AppShell` mounts is what makes the offer observable.
 *
 * `ProfileContext` is supplied directly rather than by mounting
 * `ProfileProvider`, because that provider fetches the people list on mount
 * and nothing here needs a profile — `useProfile()` throws without a provider,
 * so this satisfies it with a fixed value and keeps the stubbed network to the
 * calls the test is actually about.
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

/** Types `text` into the reason box the way a person would. */
async function typeReason(text: string): Promise<void> {
  const box = container.querySelector<HTMLTextAreaElement>(
    'textarea[data-region="archive-reason-input"]',
  );
  if (box === null) throw new Error("no reason box is rendered");
  await act(async () => {
    // React tracks the last value it set on the node and skips the change
    // event when the new value matches it, so the setter has to be called on
    // the prototype for a programmatic change to reach `onChange`.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A reason that clears `delete_item`'s twenty-character rule. */
const GOOD_REASON = "duplicate of the session-registration task, created twice";

/** Opens the form and composes a valid reason. */
async function composeArchive(): Promise<void> {
  await act(async () => {
    button("archive-begin")?.click();
  });
  await typeReason(GOOD_REASON);
}

describe("the item detail page's archive affordance, mounted in real React", () => {
  it("renders the archive control on a live item, so the assertions below are not vacuous", async () => {
    // Guards the guard. Every test here asserts on the effect of a click, so
    // if the control stopped rendering they would all pass by never clicking
    // anything. This states the precondition directly and fails first.
    await mount();

    expect(button("archive-begin")).not.toBeNull();
    // And the destructive control is NOT reachable in one click — see the
    // deliberateness test below for the assertion that actually pins this.
    expect(button("archive-confirm")).toBeNull();
  });

  it("sends exactly one archive request, with the composed reason", async () => {
    // **The assertion this file exists for, part one.**
    //
    // `onArchive` reads the composed reason from a ref, synchronously, before
    // any `setState`. Deriving it inside a `setArchiveState` updater instead —
    // the shape that has shipped three times — makes this **zero requests**:
    // the early return fires while the state has already advanced, so the
    // count is zero rather than a request with the wrong body.
    await mount();
    await composeArchive();

    await act(async () => {
      button("archive-confirm")?.click();
    });

    const archives = writes.filter((w) => w.method === "DELETE");
    expect(archives).toHaveLength(1);
    expect(archives[0]?.url).toContain("item-a");
    // The body matters as much as the count: an archive that sent an empty or
    // stale reason would still be one request, and would be refused by the
    // server for a reason the person could not act on.
    expect(archives[0]?.body).toEqual({ reason: GOOD_REASON });
  });

  it("offers an undo after archiving, and pressing it posts a restore", async () => {
    // **The assertion this file exists for, part two — the dead branch.**
    //
    // `inverseOf` has derived a real restore step for `kind: "archive"` for a
    // while, and `runUndo` has known how to post it. Neither was reachable,
    // because nothing constructed an `archive` action. Deleting the `offer`
    // call in `ItemDetailContainer.runArchive` leaves every unit test green
    // and fails exactly this.
    await mount();
    await composeArchive();

    await act(async () => {
      button("archive-confirm")?.click();
    });

    // The toast is showing, and it is showing an *offered* action — not a
    // bare confirmation. `data-phase` is what distinguishes them.
    expect(container.querySelector('[data-phase="offered"]')).not.toBeNull();
    expect(container.textContent).toContain("A card");

    const undo = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Undo"),
    );
    expect(undo).toBeDefined();

    await act(async () => {
      undo?.click();
    });

    const restores = writes.filter((w) => w.url.includes("/restore"));
    expect(restores).toHaveLength(1);
    expect(restores[0]?.method).toBe("POST");
  });

  it("does not archive on a single click — the reason form stands between", async () => {
    // The deliberateness criterion, asserted rather than asserted-about. One
    // click on the only control a live item shows must reach a form, not the
    // network. A change that made the first button archive directly passes
    // every other test in this file and fails this one.
    await mount();

    await act(async () => {
      button("archive-begin")?.click();
    });

    expect(writes.filter((w) => w.method === "DELETE")).toHaveLength(0);
    expect(container.querySelector('[data-region="archive-form"]')).not.toBeNull();
  });

  it("keeps the archive control disabled until the reason is long enough", async () => {
    // The second half of deliberateness: the form cannot be submitted with a
    // shrug. `delete_item` would refuse a short reason anyway — this is what
    // stops the person being sent on a round trip to learn what the hint
    // beside the box already says.
    await mount();
    await act(async () => {
      button("archive-begin")?.click();
    });
    await typeReason("dupe");

    expect(button("archive-confirm")?.disabled).toBe(true);

    await act(async () => {
      button("archive-confirm")?.click();
    });
    expect(writes.filter((w) => w.method === "DELETE")).toHaveLength(0);

    await typeReason(GOOD_REASON);
    expect(button("archive-confirm")?.disabled).toBe(false);
  });

  it("shows the server's own refusal, verbatim, rather than a generic failure", async () => {
    // The refusal messages were written to be read — `delete_item`'s names
    // every live child and holder pointing at the row. A surface that replaced
    // them with "Could not archive this item" would throw away the only part
    // of the response that says what to do next.
    const refusal =
      "2 things point at this item and would be left pointing at something no read " +
      "returns: child item-b — Wire the toast (executing); live_claim asg-1 — crew-1 is " +
      "holding this item. Move or resolve them first, or pass acknowledgeReferences to " +
      "proceed anyway.";
    archiveResponse = {
      ok: false,
      status: 409,
      body: { error: { message: refusal, guard: "items.archive_has_inbound_references" } },
    };

    await mount();
    await composeArchive();
    await act(async () => {
      button("archive-confirm")?.click();
    });

    const shown = container.querySelector('[data-region="archive-error"]')?.textContent ?? "";
    expect(shown).toContain(refusal);
    // And the acknowledge path is offered, because this particular refusal is
    // one the person can pass by saying they have read it.
    expect(button("archive-acknowledge")).not.toBeNull();
  });

  it("retries with the acknowledgement, keeping the reason the person typed", async () => {
    // Two things at once, both composition: the flag is sent on the retry (and
    // NOT on the first attempt), and the composed reason survives the refusal
    // rather than having to be retyped.
    archiveResponse = {
      ok: false,
      status: 409,
      body: {
        error: {
          message: "2 things point at this item.",
          guard: "items.archive_has_inbound_references",
        },
      },
    };

    await mount();
    await composeArchive();
    await act(async () => {
      button("archive-confirm")?.click();
    });

    archiveResponse = { ok: true, status: 200, body: { archived: true } };
    await act(async () => {
      button("archive-acknowledge")?.click();
    });

    const archives = writes.filter((w) => w.method === "DELETE");
    expect(archives).toHaveLength(2);
    // The first attempt deliberately does not acknowledge anything — the
    // refusal is what shows the person the list.
    expect(archives[0]?.body).toEqual({ reason: GOOD_REASON });
    expect(archives[1]?.body).toEqual({ reason: GOOD_REASON, acknowledgeReferences: true });
  });
});

describe("the item detail page's restore affordance, mounted in real React", () => {
  it("offers Restore on an archived item, and posts one restore", async () => {
    itemFixture = anItem({
      archivedAt: "2026-02-01T00:00:00.000Z",
      archivedReason: "duplicate of the session-registration task",
    });

    await mount();

    // The archived state is stated on the page, not merely implied by a
    // missing control — a reader can arrive here by a stale link with no idea
    // the row is archived.
    expect(container.querySelector('[data-region="archived-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-region="archived-reason"]')?.textContent).toContain(
      "duplicate of the session-registration task",
    );
    expect(button("archive-begin")).toBeNull();

    await act(async () => {
      button("restore-item")?.click();
    });

    const restores = writes.filter((w) => w.url.includes("/restore"));
    expect(restores).toHaveLength(1);
    expect(restores[0]?.method).toBe("POST");
    // No acknowledgement on a first attempt, for the same reason the archive
    // does not send one: the refusal is what informs the decision.
    expect(restores[0]?.body).toEqual({});
  });

  it("surfaces the superseded refusal by name, and links the replacement", async () => {
    // This is the refusal `restore_item` was most careful about: it names the
    // row the work was taken up by, so the person can go and look before
    // deciding. Swallowing it would leave them with "restore failed" and an
    // id they never saw.
    itemFixture = anItem({ archivedAt: "2026-02-01T00:00:00.000Z" });
    const refusal =
      "This item was not archived by accident — it was archived in favour of item-z, " +
      "which is where its work was taken up. Restoring it puts a second row for the same " +
      "work back on the board. If they are genuinely different work, pass " +
      "acknowledgeSuperseded to restore it anyway.";
    restoreResponse = {
      ok: false,
      status: 409,
      body: {
        error: {
          message: refusal,
          guard: "items.restore_superseded_needs_acknowledgement",
          details: { supersededById: "item-z" },
        },
      },
    };

    await mount();
    await act(async () => {
      button("restore-item")?.click();
    });

    expect(container.querySelector('[data-region="archive-error"]')?.textContent).toContain(
      refusal,
    );
    // The named replacement is reachable, not just quoted.
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-region="archive-superseded-link"]',
    );
    expect(link?.getAttribute("href")).toBe("/items/item-z");

    // And acknowledging sends the flag.
    restoreResponse = { ok: true, status: 200, body: { restored: true } };
    await act(async () => {
      button("archive-acknowledge")?.click();
    });
    const restores = writes.filter((w) => w.url.includes("/restore"));
    expect(restores).toHaveLength(2);
    expect(restores[1]?.body).toEqual({ acknowledgeSuperseded: true });
  });

  it("surfaces an archived-parent refusal without offering to acknowledge past it", async () => {
    // The other refusal, and the distinction that matters: this one is NOT
    // acknowledgeable. It names something the person must go and fix on
    // another row. Offering an "anyway" button here would promise a way past a
    // guard that has none, and the click would simply fail again.
    itemFixture = anItem({ archivedAt: "2026-02-01T00:00:00.000Z" });
    const refusal =
      "This item cannot be restored where it stands: its parent (item-p) is itself " +
      "archived, so restoring this row would hang it under something no ordinary read " +
      "returns — restore the parent first.";
    restoreResponse = {
      ok: false,
      status: 409,
      body: { error: { message: refusal, guard: "items.restore_into_archived_context" } },
    };

    await mount();
    await act(async () => {
      button("restore-item")?.click();
    });

    expect(container.querySelector('[data-region="archive-error"]')?.textContent).toContain(
      refusal,
    );
    expect(button("archive-acknowledge")).toBeNull();
  });
});
