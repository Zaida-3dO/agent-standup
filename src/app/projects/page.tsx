// `/projects` — the organising view. A later task owns it; this is the
// route resolving with an honest placeholder so the sidebar's link works
// and the screen's crew has an address to build at.
import { Placeholder } from "@/components/placeholder/Placeholder";

export default function ProjectsPage() {
  return (
    <Placeholder
      title="Projects"
      summary="Every project, with its progress, who is on it and what it is waiting for."
    />
  );
}
