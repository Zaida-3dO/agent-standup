// The root, which is a *choice* rather than a screen.
//
// Standup — a digest of what happened while you were away and what needs
// you — is the default entry, with the project list one click away in the
// rail. That resolution has an argument behind it: projects are the
// organising principle of the product and serve the weekly job of
// steering, but the daily jobs are overnight triage and "what needs me",
// and landing on the project list costs a navigation every single morning
// to reach them. Projects-first as the organising principle, Standup-first
// as the entry point.
//
// It is stored as a setting (`ui.default_landing`) rather than settled by
// argument, so use decides it — moving the landing page is one preference
// change, not a rewrite.
import { Landing } from "@/components/landing/Landing";

export default function RootPage() {
  return <Landing />;
}
