// `/activity` — the event ledger, and the address the folded "since your
// last visit" route now points at.
//
// **The seen-state is real and is not being dropped.** The feed component,
// its per-profile read state and the `POST /api/events/{id}/seen` writes
// behind it are unchanged and rendered here; only the address moved, and
// `/since` redirects here (see `src/app/since/page.tsx`). A later task
// widens this screen into the full ledger — filtering by actor and by
// event kind — and it widens a screen that already works rather than
// building one from nothing.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `SinceLastVisit` is a client
// component because it fetches on mount; this page stays a server
// component that simply places it.
import { SinceLastVisit } from "@/components/since/SinceLastVisit";

export default function ActivityPage() {
  return <SinceLastVisit />;
}
