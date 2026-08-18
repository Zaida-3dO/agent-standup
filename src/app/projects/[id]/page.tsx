// `/projects/{id}` — one project in full (MILESTONES.md #75).
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `ProjectDetailContainer` is a client
// component because it fetches on mount; this page stays a server component
// that simply resolves the route parameter and places it.
import { ProjectDetailContainer } from "@/components/project-detail/ProjectDetailContainer";

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // `key` so navigating between two projects remounts the container rather
  // than reusing it — the same reason the item page does it: a reused
  // container would show the previous project's data while the new read is
  // in flight.
  return <ProjectDetailContainer key={id} projectId={id} />;
}
