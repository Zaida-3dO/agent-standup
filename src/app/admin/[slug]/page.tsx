// `/admin/<kind>` — MILESTONES.md #93's "one page pattern per entity kind".
//
// **One route for every kind, not one route per kind.** The slug selects a
// descriptor from `ADMIN_KINDS`, and the same components render whichever it
// is — so adding a kind is adding an entry to that list, with no new file
// here. A slug that names no kind is a 404 rather than an empty page,
// because a page that renders nothing for an unknown name reads as broken
// rather than as absent.
import { notFound } from "next/navigation";
import { ADMIN_KINDS, adminKindBySlug } from "@/lib/admin/kinds";
import { Admin } from "@/components/admin/Admin";

/** Pre-renders the known kinds; anything else falls through to `notFound`. */
export function generateStaticParams() {
  return ADMIN_KINDS.map((kind) => ({ slug: kind.slug }));
}

export default async function AdminKindPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const kind = adminKindBySlug(slug);
  if (!kind) notFound();
  return <Admin kind={kind} />;
}
