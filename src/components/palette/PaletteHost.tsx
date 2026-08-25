"use client";

// The palette's container — the one place in this piece that holds state,
// listens to the document and talks to the network.
//
// ── Why this is a provider, and why it is the only thing AppShell mounts ─
//
// T18-A's `UndoToastHost` established the pattern deliberately: one element
// in `AppShell`, and every other surface reaches the feature through a hook
// (`useUndo().offer(...)`) rather than importing the component. This does
// the same — `usePalette().openCreate()` — for the same reason. The `+`
// button in the top strip, the `c` shortcut and the palette's own "Create
// an item" row all need to open the same dialog, none of them is a child of
// the others, and threading an `onOpenCreate` prop through the shell to
// each would make the shell a router for a feature it does not own.
//
// **Two rows land here, in one file, on purpose.** The command palette and
// the quick-create mount both attach to `AppShell.tsx`, and splitting them
// across two changes would have put two authors in one file. They also
// genuinely interlock: the palette's "create" verb opens the dialog, and
// both need the same focus trap and the same scroll lock, so a second
// implementation of either would have been the thing to review.
//
// ── The split, again ────────────────────────────────────────────────────
//
// Everything decidable without a DOM lives in `@/lib/palette` as pure
// functions and is tested directly (`vitest.config.ts`: `environment:
// "node"`). What is left here is wiring — a `useState`, a listener, a
// `fetch` — with as little branching that decides anything as possible.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { QuickCreateDialog } from "@/components/create/QuickCreateDialog";
import { emptyDraft, submitCreate, type QuickCreateDraft } from "@/lib/create/state";
import {
  commandsFor,
  matchCommands,
  stateChangeRequest,
  type Command,
} from "@/lib/palette/commands";
import { decideKey } from "@/lib/palette/keys";
import { FOCUSABLE_SELECTOR, nextTrapFocus } from "@/lib/palette/focus-trap";
import {
  decidePaletteKey,
  movedSelection,
  selectedCommand,
  FIRST_INDEX,
} from "@/lib/palette/state";
import { fetchPaletteItem, itemIdFromPath, type PaletteItem } from "@/lib/palette/item-context";
import { uiApiPath } from "@/lib/ui-proxy/path";
import { CommandPalette } from "./CommandPalette";
import { ShortcutHelp } from "./ShortcutHelp";

/**
 * Which overlay is open, as one value rather than three booleans.
 *
 * Three flags admit eight states, five of which are nonsense ("the palette
 * and the help sheet are both open"). One value admits exactly the four
 * that exist, so "close whatever is open" is a single assignment rather
 * than three that must not be forgotten.
 */
type Overlay = "none" | "palette" | "help" | "create";

/** What any surface in the app can ask the palette for. */
export interface PaletteApi {
  readonly openPalette: () => void;
  readonly openCreate: () => void;
  readonly openHelp: () => void;
  /**
   * Whether a modal overlay is covering the page right now.
   *
   * **Why a feature that opens overlays also reports that it has.** The
   * undo toast sits at `z-index: 50`, deliberately beneath every overlay
   * here (60/70) so that a modal stays modal. The consequence measured in
   * a browser is that an undo offered while one of these is open is
   * visible through the scrim and completely unclickable —
   * `elementFromPoint` at the centre of the button returns the backdrop.
   *
   * The toast cannot fix that by rendering higher without breaking the
   * modality the layering exists to protect, so it has to know instead:
   * it suppresses itself and freezes its window while this is true. See
   * `@/lib/undo/suspension` for the whole argument, and `UndoToastHost`
   * for the consumption.
   *
   * This is the one piece of overlay state worth exposing, and it is
   * exposed as a single boolean rather than the `Overlay` union on
   * purpose: a consumer that could see *which* overlay is open would
   * start branching on it, and nothing outside this file has any business
   * knowing the difference between the palette and the help sheet.
   */
  readonly overlayOpen: boolean;
}

/**
 * A no-op default, so `usePalette()` outside the provider renders instead
 * of throwing — the same trade `UndoToastHost`'s `NO_UNDO` makes and for
 * the same reason: a missing overlay is a missing convenience, a thrown
 * error takes down the page that was trying to offer it.
 */
const NO_PALETTE: PaletteApi = {
  openPalette: () => {},
  openCreate: () => {},
  openHelp: () => {},
  // No provider means no overlay this hook could know about. `false` is the
  // truthful default rather than the convenient one: a toast reading this
  // outside the host is on a page with no palette mounted, so nothing here
  // is covering it.
  overlayOpen: false,
};

const PaletteContext = createContext<PaletteApi>(NO_PALETTE);

export function usePalette(): PaletteApi {
  return useContext(PaletteContext);
}

/** The page's own search box, for the `/` shortcut to focus. */
const SEARCH_BOX_SELECTOR = 'input[type="search"], [role="search"] input';

/** True when the press landed in something the person is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The app router, or `null` where there is not one mounted.
 *
 * **Why this is not a bare `useRouter()`.** `useRouter` does not degrade —
 * it throws `invariant expected app router to be mounted`. `AppShell` is
 * server-rendered without a router by `tests/app-shell.test.ts`, which
 * renders it through `renderToStaticMarkup` to prove its context relay, and
 * a host that threw there would take that whole suite down for a reason
 * having nothing to do with what it is testing. `usePathname` beside it
 * already returns `null` rather than throwing, which is the behaviour worth
 * matching.
 *
 * The hook is still called unconditionally, so the rules of hooks hold; the
 * `try` only converts the throw into an absence. Every caller below treats
 * `null` as "cannot navigate", which is exactly true: there is no router to
 * navigate with, and the overlays that do not navigate keep working.
 */
function useOptionalRouter(): ReturnType<typeof useRouter> | null {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

export function PaletteHost({ children }: { children: ReactNode }) {
  const router = useOptionalRouter();
  const pathname = usePathname() ?? undefined;

  const [overlay, setOverlay] = useState<Overlay>("none");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(FIRST_INDEX);
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const [item, setItem] = useState<PaletteItem | null>(null);

  const [draft, setDraft] = useState<QuickCreateDraft>(() => emptyDraft());
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // **Where focus was when the overlay opened**, so it can be given back.
  // A ref rather than state: nothing renders from it, and holding it in
  // state would re-render the whole subtree to record a fact only the
  // close path ever reads.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const open = useCallback((next: Exclude<Overlay, "none">) => {
    // Captured before the overlay renders and takes focus. `document` is
    // guarded because this module is imported in a server render too.
    if (typeof document !== "undefined") {
      const active = document.activeElement;
      returnFocusTo.current = active instanceof HTMLElement ? active : null;
    }
    setQuery("");
    setSelected(FIRST_INDEX);
    setPaletteError(null);
    setCreateError(null);
    setOverlay(next);
  }, []);

  const close = useCallback(() => {
    setOverlay("none");
    // **Focus returns to the trigger.** Without this, closing a modal drops
    // focus onto `<body>` and a keyboard-only person is returned to the top
    // of the document — they have to Tab all the way back to where they
    // were, which is what makes a modal unusable without a mouse rather
    // than merely awkward.
    //
    // `document.contains` because the trigger may be gone: the palette can
    // navigate, and focusing a detached element silently moves focus to the
    // body, which is the thing this is preventing.
    const target = returnFocusTo.current;
    returnFocusTo.current = null;
    if (target !== null && typeof document !== "undefined" && document.contains(target)) {
      target.focus();
    }
  }, []);

  const openPalette = useCallback(() => open("palette"), [open]);
  const openHelp = useCallback(() => open("help"), [open]);
  const openCreate = useCallback(() => {
    setDraft(emptyDraft());
    open("create");
  }, [open]);

  // Derived from the single `overlay` value, which is why that value being
  // one field rather than three booleans matters here too: "is anything
  // open" is one comparison that cannot drift out of step with the flags it
  // summarises.
  const overlayOpen = overlay !== "none";

  const api = useMemo<PaletteApi>(
    () => ({ openPalette, openCreate, openHelp, overlayOpen }),
    [openPalette, openCreate, openHelp, overlayOpen],
  );

  const itemId = itemIdFromPath(pathname);

  // Read when the palette opens on an item page, not on every navigation:
  // this exists solely to supply a truthful `expectedFrom`, and the moment
  // that matters is the moment the verbs become available. Re-read on each
  // open rather than cached, so a palette opened twenty minutes later does
  // not carry a twenty-minute-old premise.
  useEffect(() => {
    if (overlay !== "palette" || itemId === null) return;
    let cancelled = false;
    void fetchPaletteItem(itemId).then((next) => {
      if (!cancelled) setItem(next);
    });
    return () => {
      cancelled = true;
    };
  }, [overlay, itemId]);

  // **Staleness is derived during render, not cleared by an effect.** The
  // stored `item` is whatever the last read produced; `currentItem` is what
  // that amounts to for the page being rendered now. An
  // `useEffect(() => setItem(null))` would be a synchronous `setState`
  // inside an effect — a cascading render, and what
  // `react-hooks/set-state-in-effect` refuses. `UndoToastHost` derives its
  // expiry the same way, and `AppShell` its mobile nav sheet.
  //
  // The comparison is the point rather than a formality: without it, a
  // palette opened on `/items/A` and then reopened on `/items/B` would
  // still be holding A's id and state, and a "change state" verb would
  // send a correct-looking `expectedFrom` for the wrong item.
  const currentItem = item !== null && item.id === itemId ? item : null;

  // **The page behind does not scroll.** Set on `<body>` here rather than
  // by each overlay, because it is one fact about the app ("something modal
  // is open") and three components each setting it would race on the way
  // out — the last to unmount would clear it while another was still open.
  useEffect(() => {
    if (overlay === "none" || typeof document === "undefined") return;
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, [overlay]);

  // The pending `g` prefix. A ref, not state: the listener below is the
  // only reader and the only writer, and nothing renders from it, so making
  // it state would re-render the app on every `g`.
  const pendingPrefix = useRef<string | null>(null);

  // The one document-level listener. Everything it decides is decided by
  // `decideKey`; this reduces the event to the two booleans that rule needs
  // and applies the answer.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const decision = decideKey(event, pendingPrefix.current, {
        typing: isTypingTarget(event.target),
        overlayOpen: overlay !== "none",
      });
      pendingPrefix.current = decision.pendingPrefix;
      if (decision.handled) event.preventDefault();
      const intent = decision.intent;
      if (intent === null) return;
      switch (intent.kind) {
        case "navigate":
          router?.push(intent.href);
          return;
        case "open-palette":
          openPalette();
          return;
        case "open-create":
          openCreate();
          return;
        case "open-help":
          openHelp();
          return;
        case "focus-search": {
          // `/` focuses the page's own search box when it has one. The
          // palette is not a substitute for it — a board's search filters
          // the board in place, which is a different thing from running a
          // command — so it is only the fallback for a page with no box.
          const box = document.querySelector<HTMLElement>(SEARCH_BOX_SELECTOR);
          if (box === null) openPalette();
          else box.focus();
          return;
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [overlay, router, openPalette, openCreate, openHelp]);

  // **The focus trap.** One handler shared by all three overlays, attached
  // to the panel rather than the document, so it only ever sees keys
  // pressed inside the thing it is trapping. `nextTrapFocus` decides which
  // element Tab should reach; this moves focus and suppresses the browser's
  // default only on the presses where it actually redirected something.
  const onTrapKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = overlayRef.current;
      if (panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const active = document.activeElement;
      const next = nextTrapFocus(
        focusable,
        active instanceof HTMLElement ? active : null,
        event.shiftKey,
      );
      // `null` means the browser's own order is already right — see
      // `nextTrapFocus`, which returns it for every press in the middle of
      // the cycle rather than re-implementing focus order.
      if (next === null) return;
      event.preventDefault();
      next.focus();
    },
    [close],
  );

  const commands = useMemo(
    () =>
      matchCommands(
        commandsFor({ itemId: currentItem?.id ?? null, itemState: currentItem?.state ?? null }),
        query,
      ),
    [currentItem, query],
  );

  const runCommand = useCallback(
    (command: Command) => {
      switch (command.intent.kind) {
        case "navigate":
          close();
          router?.push(command.intent.href);
          return;
        case "create":
          openCreate();
          return;
        case "help":
          openHelp();
          return;
        case "change-state": {
          // Only reachable with an item in context, because `commandsFor`
          // emits no state rows without one — so `item` is non-null here,
          // and its `state` came from the server, which is what makes the
          // `expectedFrom` below a real precondition rather than an echo of
          // whatever the page happened to have rendered.
          if (currentItem === null) return;
          const body = stateChangeRequest(command.intent.to, currentItem.state);
          setPaletteError(null);
          void fetch(uiApiPath(`/api/items/${encodeURIComponent(currentItem.id)}/transition`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
            .then(async (response) => {
              if (response.ok) {
                close();
                router?.refresh();
                return;
              }
              // A 409 is the precondition doing its job: someone else moved
              // the item between the palette reading it and this press.
              // Reported, never retried — a retry would re-send with the
              // new state as the premise, which is exactly the silent
              // clobber the precondition exists to prevent
              // (`@/lib/undo/request` documents the same rule at length).
              const payload = (await response.json().catch(() => null)) as {
                error?: { message?: unknown };
              } | null;
              const message = payload?.error?.message;
              setPaletteError(
                typeof message === "string" && message !== ""
                  ? message
                  : `The state change was refused (${response.status}).`,
              );
            })
            .catch(() => setPaletteError("The state change could not be sent."));
          return;
        }
      }
    },
    [close, currentItem, openCreate, openHelp, router],
  );

  const onPaletteKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const action = decidePaletteKey(event);
      if (action.kind === "pass") {
        // Tab still has to be trapped. `decidePaletteKey` deliberately does
        // not claim it, because trapping is not the palette's own behaviour
        // but every overlay's — so it falls through to the shared handler.
        onTrapKeyDown(event);
        return;
      }
      event.preventDefault();
      if (action.kind === "close") {
        close();
        return;
      }
      if (action.kind === "move") {
        setSelected((current) => movedSelection(commands.length, current, action.delta));
        return;
      }
      const command = selectedCommand(commands, selected);
      if (command !== null) runCommand(command);
    },
    [close, commands, onTrapKeyDown, runCommand, selected],
  );

  const onQueryChange = useCallback((next: string) => {
    setQuery(next);
    // The list changes under the selection, so the selection goes back to
    // the top — see `FIRST_INDEX` for why clamping the previous index
    // would leave the highlight on a command nobody looked at.
    setSelected(FIRST_INDEX);
  }, []);

  const onCreateSubmit = useCallback(() => {
    setSubmitting(true);
    setCreateError(null);
    submitCreate(draft)
      .then((created) => {
        setSubmitting(false);
        close();
        setDraft(emptyDraft());
        // Straight to the item that was just minted. A create that leaves
        // you where you were makes you go and find the thing you just made.
        router?.push(`/items/${encodeURIComponent(created.id)}`);
      })
      .catch((error: unknown) => {
        setSubmitting(false);
        // `submitCreate` throws a message already fit to show — see its
        // header — so this is a type narrowing rather than a translation.
        setCreateError(error instanceof Error ? error.message : "The item could not be created.");
      });
  }, [close, draft, router]);

  return (
    <PaletteContext.Provider value={api}>
      {children}
      {overlay !== "none" && (
        <div ref={overlayRef}>
          {overlay === "palette" && (
            <CommandPalette
              commands={commands}
              query={query}
              selectedIndex={selected}
              itemLabel={currentItem?.title ?? null}
              errorMessage={paletteError}
              onQueryChange={onQueryChange}
              onSelect={setSelected}
              onRun={runCommand}
              onClose={close}
              onKeyDown={onPaletteKeyDown}
            />
          )}
          {overlay === "help" && <ShortcutHelp onClose={close} onKeyDown={onTrapKeyDown} />}
          {overlay === "create" && (
            // The dialog built in PR #266, mounted. It stays hook-free and
            // prop-driven exactly as it was written — the draft, the
            // pending flag, the error, the focus trap and the scroll lock
            // are all this container's, which is what its row asked for.
            <div onKeyDown={onTrapKeyDown}>
              <QuickCreateDialog
                draft={draft}
                submitting={submitting}
                errorMessage={createError}
                onChange={setDraft}
                onSubmit={onCreateSubmit}
                onCancel={close}
              />
            </div>
          )}
        </div>
      )}
    </PaletteContext.Provider>
  );
}
