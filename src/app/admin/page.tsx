// `/admin` — MILESTONES.md #93.
//
// Redirects to the first kind rather than rendering a menu of five links
// that every kind's own page already carries in its tabs. A landing page
// whose only content is navigation duplicated below it is a click nobody
// needs.
import { redirect } from "next/navigation";
import { ADMIN_KINDS } from "@/lib/admin/kinds";

export default function AdminIndexPage() {
  // `ADMIN_KINDS` is a non-empty frozen list, so the first entry always
  // exists; the fallback keeps the redirect total rather than relying on
  // that being obvious at the call site.
  redirect(`/admin/${ADMIN_KINDS[0]?.slug ?? "repos"}`);
}
