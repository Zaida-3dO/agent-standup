// `/needs-you` — the narrow list behind the sidebar's badge: everything
// genuinely requiring a person, oldest-first, decidable in place.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `NeedsYouInbox` is a client component
// because it fetches on mount; this page stays a server component that
// simply places it, matching `BoardPage`/`ActivityPage`.
import { NeedsYouInbox } from "@/components/needs-you/NeedsYouInbox";

export default function NeedsYouPage() {
  return <NeedsYouInbox />;
}
