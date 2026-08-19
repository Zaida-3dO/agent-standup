"use client";

// The root's redirect-or-render decision.
//
// **Why this is client-side.** The setting lives behind the service layer,
// and nothing under `src/app/` may import the service layer or the database
// client — `npm run check:db-imports` enforces that, and the front end
// reaches the service only through the HTTP adapter. So the root reads
// `GET /api/settings` like every other front-end surface does, and acts on
// the answer.
//
// **The cost of that, stated plainly:** choosing a landing page other than
// Standup means the root renders nothing for as long as the settings read
// takes, then navigates. That is one hop on the way in, not on every
// screen, and it costs nothing at all for the default — Standup lives at
// `/` and renders in place with no navigation.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchSettings } from "@/lib/settings-page/state";
import { landingRedirectPath } from "@/lib/nav/landing";
import { StandupHome } from "@/components/standup/StandupHome";

export function Landing() {
  const router = useRouter();
  // Three states, and the distinction between the first two is what stops
  // the digest flashing on screen for someone whose landing page is the
  // board: `undecided` renders nothing at all, and only `standup` renders.
  const [decision, setDecision] = useState<"undecided" | "standup" | "redirecting">("undecided");

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((response) => {
        if (cancelled) return;
        const stored = response.settings.find((s) => s.key === "ui.default_landing")?.value;
        const target = landingRedirectPath(stored);
        if (target === null) {
          setDecision("standup");
          return;
        }
        setDecision("redirecting");
        // `replace`, not `push`: the root is not a page the reader chose to
        // visit, so leaving it in the history means the back button returns
        // here and immediately bounces forward again.
        router.replace(target);
      })
      .catch(() => {
        if (cancelled) return;
        // A settings read that failed must not leave the root blank. The
        // default is the honest fallback — it is what an installation that
        // has never touched the setting gets — and Standup is reachable
        // without knowing anything about the preference.
        setDecision("standup");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (decision === "standup") return <StandupHome />;
  return null;
}
