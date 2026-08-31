// `/budget` — MILESTONES.md #87.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `BudgetEditor` is a client component
// because it fetches on mount; this page stays a server component that
// simply places it, exactly as `src/app/settings/page.tsx` places the
// settings editor.
//
// **Why this route mounts the editor.** The editor draws the chart, the
// plain-words boundaries, the crossing marks and the time scrubber itself,
// so this one page answers both "what is configured" and "change it" — a
// reader never has to know which of two pages showing the same picture they
// wanted.
//
// One rendering of the model, not two. A second read-only view of the same
// windows would have to be kept in step with this one for no gain the
// reader can name — the fields are the only difference, and somebody who
// does not want to change anything simply does not type in them.
import { BudgetEditor } from "@/components/budget/BudgetEditor";

export default function BudgetPage() {
  return <BudgetEditor />;
}
