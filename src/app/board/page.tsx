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
import { Board } from "@/components/board/Board";

export default function BoardPage() {
  return <Board />;
}
