// `/fleet` — who is working right now. A later task owns it; this is the
// route resolving with an honest placeholder.
import { Placeholder } from "@/components/placeholder/Placeholder";

export default function FleetPage() {
  return (
    <Placeholder
      title="Fleet"
      summary="Every live claim: which agent, on which machine, on which branch, and how long since it last reported."
    />
  );
}
