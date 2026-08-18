// `/cost` — what the work cost. A later task owns it; this is the route
// resolving with an honest placeholder.
import { Placeholder } from "@/components/placeholder/Placeholder";

export default function CostPage() {
  return (
    <Placeholder
      title="Cost"
      summary="Token spend and its money value, broken down by item, by model and by period."
    />
  );
}
