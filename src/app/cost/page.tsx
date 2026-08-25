// `/cost` — what the work cost. T19.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `Cost` is a client component because it
// fetches on mount; this page stays a server component that simply places
// it.
import { Cost } from "@/components/cost/Cost";

export default function CostPage() {
  return <Cost />;
}
