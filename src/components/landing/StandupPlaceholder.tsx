// The Standup screen's stand-in. A later task owns what actually goes here
// — the overnight digest — so this names the destination and says plainly
// that it is unbuilt rather than rendering an empty state that would be
// indistinguishable from "nothing happened overnight".
//
// Its own component rather than `Placeholder` inline in `Landing.tsx`, so
// the root's redirect decision and the screen it falls through to are
// separately testable.
import { Placeholder } from "@/components/placeholder/Placeholder";

export function StandupPlaceholder() {
  return (
    <Placeholder
      title="Standup"
      summary="A digest of what moved while you were away: overnight merges, items now blocked on you, and anything that stalled."
    />
  );
}
