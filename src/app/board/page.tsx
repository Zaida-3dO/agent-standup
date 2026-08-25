// The kanban.
//
// It lives here rather than at the root because the root became a choice —
// see `src/app/page.tsx` and `ui.default_landing`. The board component is
// unchanged; only its address moved.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app, above the top bar's sibling content.
// `Board` is a client component because it fetches on mount; this page
// stays a server component that simply places it.
//
// **The `<Suspense>` is required, not decorative** (MILESTONES.md #75).
// `Board` reads its filters from the URL with `useSearchParams`, and Next
// refuses to prerender a page that calls it outside a suspense boundary —
// the build fails with "useSearchParams() should be wrapped in a suspense
// boundary" rather than merely warning. The boundary is drawn here, around
// the board alone, rather than in the root layout: a boundary in the layout
// would opt *every* page out of static rendering to serve one that needs it.
//
// The fallback is `null` rather than a skeleton because each layout renders
// its own loading state the moment it mounts — the kanban four skeleton
// columns, the list eight skeleton rows — and a second, different
// placeholder before it would make the page flash through two loading
// appearances on the way to one board.
//
// **The page renders `BoardSurface`, not `Board` directly** (MILESTONES.md
// T6 §3). The same address now serves two shapes — the kanban and the list
// — chosen by the `layout` parameter in the query string, and that switch
// is what `BoardSurface` is. The address is unchanged and so is the default:
// `/board` with no `layout` is the kanban it has always been.
//
// `BoardSurface` reads `useSearchParams` too, so it sits inside the same
// suspense boundary for the same reason `Board` did.
import { Suspense } from "react";
import { BoardSurface } from "@/components/board/BoardSurface";

export default function BoardPage() {
  return (
    <Suspense fallback={null}>
      <BoardSurface />
    </Suspense>
  );
}
