// `/budget` — MILESTONES.md #87.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `BudgetEditor` is a client component
// because it fetches on mount; this page stays a server component that
// simply places it, exactly as `src/app/settings/page.tsx` places the
// settings editor.
//
// **Why this route mounts the editor.** The editor draws the chart, the
// plain-words boundaries and the crossing marks itself, so this one page
// answers both "what is configured" and "change it" — a reader never has to
// know which of two pages showing the same picture they wanted.
// `BudgetWindows` is the read-only rendering of the same model, kept for
// any surface that wants the picture without the fields.
import { BudgetEditor } from "@/components/budget/BudgetEditor";

export default function BudgetPage() {
  return <BudgetEditor />;
}
