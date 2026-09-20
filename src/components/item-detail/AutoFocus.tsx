// Moves focus into a control when it appears — the first half of the
// keyboard contract in docs/DESIGN-LANGUAGE.md §6.
//
// **Why an element cannot just do this itself.** React's `autoFocus`
// attribute is unreliable for a control that appears mid-page in response
// to a click, rather than on the initial mount of the whole tree; the
// dependable move is an imperative `.focus()` once the node exists. That
// needs an effect — a hook — and `InlineEditField`, which renders these
// controls, is deliberately hook-free so this repo's node-environment
// tests can call it as a plain function (see `EditTrigger.tsx`'s header
// for the full reasoning, and for the 39 tests that proved the point).
//
// So the hook lives here, in a wrapper.
//
// **What it is for, concretely.** With nothing focusing the editor,
// activating one left `document.activeElement` on `BODY` — and a control
// that does not hold focus never receives the keys aimed at it, so the
// editor's own Escape handler never ran and the editor could not be
// dismissed at all. Focusing the control is what makes "Escape cancels"
// reachable in the first place; the two are one mechanism, not two
// features.
//
// **Why it focuses a DESCENDANT rather than taking a ref to the control.**
// The alternative — `cloneElement(children, { ref })` — reads a ref during
// render, which React's own lint rule rejects (`react-hooks/refs`) because
// a ref passed that way can be read before it is attached. Querying for the
// focusable node inside an effect, once the DOM exists, avoids the question
// entirely and keeps the call site writing a plain `<input>` with no ref
// plumbing of its own.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export interface AutoFocusProps {
  readonly children: ReactNode;
}

export function AutoFocus({ children }: AutoFocusProps) {
  const holder = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    // The first focusable control inside. Every caller wraps exactly one
    // `<input>` or `<select>`, so "first" is unambiguous; `?? undefined`
    // rather than a throw because a wrapper that found nothing should
    // leave focus alone, not break the page.
    const control = holder.current?.querySelector<HTMLElement>("input, select, textarea");
    control?.focus();
    // Mount only. A re-render mid-edit (a controlled input re-renders on
    // every keystroke) must NOT re-focus: a reader who has tabbed on to
    // the Save button would be yanked back to the input on their next
    // keystroke, which is a worse trap than the one this fixes.
  }, []);

  // `display: contents` — the wrapper must not become a box. These
  // controls sit in flex rows (`.inlineEditForm`), and a plain `<span>`
  // around one would add a layout node that changes how the row wraps.
  return (
    <span ref={holder} style={{ display: "contents" }}>
      {children}
    </span>
  );
}
