// The board — MILESTONES.md #37.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app, above the top bar's sibling content.
// `Board` is a client component because it fetches on mount; this page
// stays a server component that simply places it.
import { Board } from "@/components/board/Board";

export default function Home() {
  return <Board />;
}
