// `/needs-you` — the narrow list behind the sidebar's badge. A later task
// owns it; this is the route resolving with an honest placeholder.
import { Placeholder } from "@/components/placeholder/Placeholder";

export default function NeedsYouPage() {
  return (
    <Placeholder
      title="Needs you"
      summary="Items blocked on you specifically — not everything that is blocked, and not everything that is paused."
    />
  );
}
