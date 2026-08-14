// `/settings` — MILESTONES.md #86.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `Settings` is a client component
// because it fetches on mount; this page stays a server component that
// simply places it, exactly as `src/app/page.tsx` places the board.
import { Settings } from "@/components/settings/Settings";

export default function SettingsPage() {
  return <Settings />;
}
