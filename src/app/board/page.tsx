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
// The fallback is `null` rather than a skeleton because `Board` renders its
// own loading state — four skeleton columns — the moment it mounts, and a
// second, different placeholder before it would make the page flash through
// two loading appearances on the way to one board.
import { Suspense } from "react";
import { Board } from "@/components/board/Board";

export default function BoardPage() {
  return (
    <Suspense fallback={null}>
      <Board />
    </Suspense>
  );
}
