// @vitest-environment jsdom
//
// **"Confirm state", mounted in real React** — the second half of the seam
// `tests/item-edit-react-wiring.test.ts` left uncovered (that PR's own "What
// was NOT reached"). Same shape, applied to `ItemDetailContainer.tsx`'s
// `onVerifyState`:
//
//   const tipCommitSha = currentTipCommitSha(artifacts);
//   verifyState({
//     itemId: item.id,
//     commitSha: tipCommitSha,
//     body: bodyFor(outcome, item.state),
//     createdByType: "person",
//     createdById: activeProfile.id,
//   })
//
// `tests/item-detail-view.test.ts` and unit tests of `currentTipCommitSha`
// and `bodyFor` each hand those functions their inputs directly and cannot
// see this composition. A caller that read the wrong artifact, hard-coded a
// sha, passed the destination state instead of the current one, or dropped
// the `activeProfile` guard would satisfy every one of those unit tests
// while recording a `historical_verification` against the wrong commit — a
// durable claim about a specific sha, which is what makes this seam sharper
// than the edit one: `record_artifact` writes it, and the merge-authorising
// guard later reads it back.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** Same
// reasoning as every other `*-wiring.test.ts` file in this suite.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemDetailContainer } from "@/components/item-detail/ItemDetailContainer";
import { ProfileContext } from "@/lib/profile/ProfileProvider";

/** Every POST to the artifacts endpoint the stubbed network received. */
const posts: { url: string; body: Record<string, unknown> }[] = [];

/** The item the detail read returns. Reset per test. */
let itemFixture: Record<string, unknown>;
/** The artifacts the detail read returns — drives `currentTipCommitSha`. */
let artifactsFixture: Record<string, unknown>[];

let container: HTMLDivElement;
let root: Root;

function anItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-a",
    parentId: null,
    title: "The original title",
    headline: "The original headline",
    body: "",
    kind: "task",
    // `isUnverifiedOrigin` gates whether the confirm-state action renders
    // at all — must be "source" or there is nothing to click.
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
    originType: "source",
    archivedAt: null,
    archivedReason: null,
    supersededById: null,
    ...overrides,
  };
}

/** A minimal `commit`-kind artifact — the only kind `currentTipCommitSha` reads. */
function aCommitArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "artifact-commit-1",
    kind: "commit",
    verdict: null,
    reviewRound: 1,
    commitSha: "aaaaaaa1111111111111111111111111111111",
    ref: null,
    body: null,
    findings: null,
    followUpItemId: null,
    createdByType: "agent",
    createdById: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  posts.length = 0;
  itemFixture = anItem();
  artifactsFixture = [aCommitArtifact()];
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
                artifacts: artifactsFixture,
                history: [],
                historyTruncated: false,
                summary: null,
                assignments: [],
                previousHolders: [],
              },
            }),
        } as Response);
      }

      if (method === "POST" && url.includes("/api/ui/items/item-a/artifacts")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        posts.push({ url, body });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true }),
        } as Response);
      }

      throw new Error(`unexpected fetch to ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/**
 * Mounts the real container under StrictMode with a chosen `activeProfile`
 * — matches `tests/item-edit-react-wiring.test.ts`, except this seam
 * refuses without a real profile, so the happy-path tests supply one.
 */
async function mount(
  activeProfile: {
    id: string;
    displayName: string;
    avatar: string | null;
    colour: string | null;
  } | null,
): Promise<void> {
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
              activeProfile,
              people: [],
              loadState: { status: "loaded", people: [] },
              setActiveProfile: () => {},
              pickerOpen: false,
              openPicker: () => {},
              closePicker: () => {},
            } as never,
          },
          createElement(ItemDetailContainer, { itemId: "item-a" }),
        ),
      ),
    );
  });
}

function agreeButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[data-verify-outcome="agrees"]');
  if (!button)
    throw new Error("no 'State is correct' button rendered — the fixture is wrong, not the code");
  return button;
}

function disagreeButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[data-verify-outcome="disagrees"]',
  );
  if (!button) throw new Error("no 'State is wrong' button rendered");
  return button;
}

describe("the item detail page's confirm-state action, mounted in real React", () => {
  it("renders the confirm-state buttons once a commit artifact and a profile are present, so the assertions below are not vacuous", async () => {
    await mount({ id: "person-1", displayName: "Ope", avatar: null, colour: null });
    expect(agreeButton()).not.toBeNull();
    expect(disagreeButton()).not.toBeNull();
  });

  it("records the verification against the artifact fixture's tip commit sha, not a hard-coded or stale one", async () => {
    // **The core assertion.** With `onVerifyState` reading the wrong seam —
    // hard-coding a sha, or reading a different artifact — this posts a
    // `commitSha` that does not track the fixture. Mutating the fixture's
    // tip below (not the source) and re-asserting is what proves the value
    // is genuinely read rather than coincidentally correct.
    await mount({ id: "person-1", displayName: "Ope", avatar: null, colour: null });
    await act(async () => {
      agreeButton().click();
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain("/api/ui/items/item-a/artifacts");
    expect(posts[0]?.body.commitSha).toBe("aaaaaaa1111111111111111111111111111111");
  });

  it("tracks a changed tip commit sha in the fixture — proves the value is read, not hard-coded", async () => {
    artifactsFixture = [
      aCommitArtifact({
        id: "artifact-commit-2",
        commitSha: "bbbbbbb2222222222222222222222222222222",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ];
    await mount({ id: "person-1", displayName: "Ope", avatar: null, colour: null });
    await act(async () => {
      agreeButton().click();
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.commitSha).toBe("bbbbbbb2222222222222222222222222222222");
  });

  it("posts the body for the button pressed and the item's fetched state, not the destination state twice", async () => {
    // **The seam's sharpest edge.** `bodyFor(outcome, item.state)` reads
    // TWO things: which button the reader pressed, and the item's CURRENT
    // stored state (`on_deck` here) — not a literal, and not whatever the
    // outcome implies. A caller that composed the body from `outcome` alone
    // would still pass every unit test of `bodyFor` (handed its inputs
    // directly) while writing a body that does not name the state actually
    // on file.
    await mount({ id: "person-1", displayName: "Ope", avatar: null, colour: null });
    await act(async () => {
      disagreeButton().click();
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.body).toBe(
      "Checked against the tip commit — the stored state (on_deck) does NOT match what was found.",
    );
  });

  it("sends createdByType and createdById from the active profile, not a literal", async () => {
    await mount({ id: "person-42", displayName: "Someone Else", avatar: null, colour: null });
    await act(async () => {
      agreeButton().click();
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.createdByType).toBe("person");
    expect(posts[0]?.body.createdById).toBe("person-42");
  });

  it("refuses without a chosen profile, and never reaches the network", async () => {
    await mount(null);

    // With no `activeProfile`, `onVerifyState` sets an error and returns
    // before calling `verifyState` at all — the same "say the refusal
    // before the click, not after" discipline the file header describes.
    await act(async () => {
      agreeButton().click();
    });

    expect(posts).toHaveLength(0);
    expect(container.textContent).toContain(
      "Choose who you are (top right) before recording a verification.",
    );
  });
});
