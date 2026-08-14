// "Since your last visit" — MILESTONES.md #38.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app, above the top bar's sibling content,
// same as `src/app/page.tsx`. `SinceLastVisit` is a client component
// because it fetches on mount and needs the active profile from context;
// this page stays a server component that simply places it.
import { SinceLastVisit } from "@/components/since/SinceLastVisit";

export default function SincePage() {
  return <SinceLastVisit />;
}
