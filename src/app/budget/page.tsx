// `/budget` — MILESTONES.md #87.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `BudgetWindows` is a client component
// because it fetches on mount; this page stays a server component that
// simply places it, exactly as `src/app/settings/page.tsx` places the
// settings editor.
import { BudgetWindows } from "@/components/budget/BudgetWindows";

export default function BudgetPage() {
  return <BudgetWindows />;
}
