// `/projects/{id}` — one project. A later task owns it; this is the route
// resolving with an honest placeholder.
//
// The id is read and shown, so a link into this route can be seen to have
// carried its parameter — a placeholder that ignored the segment would
// look identical whether routing worked or not.
import { Placeholder } from "@/components/placeholder/Placeholder";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Placeholder
      title="Project"
      summary={`The items in project ${id}, its progress over time, and who is working on it.`}
    />
  );
}
