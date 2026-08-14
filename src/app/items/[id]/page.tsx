// One item's detail view — MILESTONES.md #72.
//
// No wrapping <main> here — AppShell (src/components/app-shell) already
// supplies the one for the whole app. `ItemDetailContainer` is a client
// component because it fetches on mount; this page stays a server component
// that simply resolves the route parameter and places it.
import { ItemDetailContainer } from "@/components/item-detail/ItemDetailContainer";

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // `key` so navigating between two items remounts the container rather
  // than reusing it — see its header for why that, not a state reset.
  return <ItemDetailContainer key={id} itemId={id} />;
}
