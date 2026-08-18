// `/projects` — the organising view (MILESTONES.md #74).
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `Projects` is a client component
// because it fetches on mount; this page stays a server component that
// simply places it.
import { Projects } from "@/components/projects/Projects";

export default function ProjectsPage() {
  return <Projects />;
}
