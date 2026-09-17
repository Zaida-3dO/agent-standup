// `/settings` — MILESTONES.md #86, and the interventions section (#128).
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. Both children are client components
// because they fetch on mount; this page stays a server component that
// simply places them, exactly as `src/app/page.tsx` places the board.
//
// **Interventions sit here rather than on `/admin`.** That page is scoped to
// data this installation owns and is explicit that what it holds are not
// settings. An intervention's level is the other thing entirely: a
// product-shipped entry an operator re-levels for their installation, which
// is the definition of a setting. They are a separate section rather than
// separate page because the question they answer — "what does this
// installation do, and who decided" — is the one somebody already came to
// `/settings` holding.
import { Settings } from "@/components/settings/Settings";
import { Interventions } from "@/components/interventions/Interventions";

export default function SettingsPage() {
  return (
    <>
      <Settings />
      <Interventions />
    </>
  );
}
