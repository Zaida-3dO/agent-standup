"use client";

// Supplies the sidebar the address it is being rendered at, so a pinned
// saved view can mark itself current — the missing half of MILESTONES.md
// #75's saved views.
//
// ── Why this component exists at all ──────────────────────────────────
//
// `SavedViewLinks` decides "this is the view you are looking at" by
// comparing its `currentHref` prop against each view's href. That prop was
// threaded from `AppShellView` down through `SidebarView` and covered by
// tests — and **nothing ever passed it a value**, so the comparison was
// always false and the highlight was dead code.
//
// The obvious fix is for `AppShell` to read the search params and pass them
// down. **That is the one fix that must not be used.** `AppShell` is
// rendered by the ROOT layout, so calling `useSearchParams()` in it opts
// every page in the app out of static rendering — Next refuses to prerender
// a page that calls it outside a `<Suspense>`, and a boundary in the root
// layout is a boundary around everything. That was tried during the task
// that built saved views, broke the build, and was backed out; `board/page.tsx`
// carries the same warning in its header and draws its boundary around the
// board alone for exactly this reason.
//
// ── How this avoids that ──────────────────────────────────────────────
//
// The `useSearchParams()` call is moved OUT of the shell and into a leaf
// that renders inside its own `<Suspense>` boundary (see `SidebarView`).
// The boundary is therefore around this one component rather than around
// the whole app, so the cost of opting out of prerendering is paid by the
// sidebar's saved-view highlight and by nothing else. Every page still
// prerenders exactly what it prerendered before.
//
// **It renders no DOM of its own.** It is a render-prop: it computes one
// string and hands it to a child function. That keeps `SavedViewLinks`
// hook-free and directly callable in this repo's DOM-free harness
// (`vitest.config.ts`: `environment: "node"`), which is the property every
// other view in this tree is written to preserve — the hook lives in the
// one component whose entire job is to hold it.
import { Suspense } from "react";
import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { currentHrefFrom } from "@/lib/nav/saved-view-links";

export interface CurrentHrefProbeProps {
  /** Receives the full path-and-query, or `null` before the router resolves. */
  readonly children: (currentHref: string | null) => ReactNode;
}

/**
 * The inner half: reads the address. Must be inside a suspense boundary.
 *
 * `usePathname` can return `null` before the router resolves;
 * `currentHrefFrom` maps that to `null` rather than to a path-less query
 * string, so a view is never marked current on the strength of a query
 * alone.
 */
function Probe({ children }: CurrentHrefProbeProps) {
  const pathname = usePathname() ?? undefined;
  const searchParams = useSearchParams();
  return <>{children(currentHrefFrom(pathname, searchParams.toString()))}</>;
}

/**
 * The boundary plus the probe.
 *
 * The fallback renders the children with `null` — i.e. the sidebar still
 * draws, with no view marked current — rather than rendering nothing. The
 * saved-view links are navigation and must be present and clickable from
 * first paint; a fallback of `null` would make the whole "Views" section
 * pop in a moment late, which is a worse outcome than a highlight that
 * arrives a moment late.
 */
export function CurrentHrefProbe({ children }: CurrentHrefProbeProps) {
  return (
    <Suspense fallback={<>{children(null)}</>}>
      <Probe>{children}</Probe>
    </Suspense>
  );
}
