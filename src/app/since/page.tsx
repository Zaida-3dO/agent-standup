// `/since` — kept as a redirect, not deleted.
//
// The screen it named is now `/activity`, but the path itself is in
// browser histories, bookmarks and anything that ever linked to it, and a
// 404 there would look exactly like the feature having been removed. A
// redirect costs one file and keeps every one of those links working.
//
// `redirect()` from a server component issues a real HTTP redirect during
// the render, so nothing of this route is ever painted — the reader sees
// `/activity` and not a flash of an empty page on the way to it.
import { redirect } from "next/navigation";
import { SINCE_REDIRECT_TARGET } from "@/lib/nav/redirects";

export default function SincePage() {
  redirect(SINCE_REDIRECT_TARGET);
}
