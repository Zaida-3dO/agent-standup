"use client";

// The thin container: fetches `GET /api/items/{id}/detail` once and hands
// the result to `ItemDetailView` as plain props. Kept deliberately empty of
// branching — see `ItemDetailView.tsx`'s header for why the conditionals
// live there instead, where they're directly testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over one `service.call("get_item_detail", …)`
// (CLAUDE.md: "Every adapter is a thin shell over a service call"). Nothing
// under `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useEffect, useState } from "react";
import {
  fetchItemDetail,
  detailErrorMessageFrom,
  type DetailLoadState,
} from "@/lib/item-detail/state";
import { ItemDetailView } from "./ItemDetailView";

export interface ItemDetailContainerProps {
  readonly itemId: string;
}

// **Navigating to a different item remounts this rather than resetting it.**
// The page gives this component a `key` of the item id, so React discards
// the whole instance and its state — which is what actually guarantees one
// item's detail is never shown under a different item's id.
// Resetting state inside the effect would do the same thing one render
// later, showing stale content in between; it is also what
// `react-hooks/set-state-in-effect` warns about, and the warning is right.

export function ItemDetailContainer({ itemId }: ItemDetailContainerProps) {
  const [loadState, setLoadState] = useState<DetailLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchItemDetail(itemId)
      .then((detail) => {
        if (cancelled) return;
        setLoadState({ status: "loaded", detail });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: detailErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  return <ItemDetailView loadState={loadState} />;
}
