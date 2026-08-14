"use client";

// The thin container: fetches `GET /api/board` once, reads who's active
// from the profile context, and hands both to `BoardView` as plain props.
// Kept deliberately empty of branching — see `BoardView.tsx`'s header for
// why the conditionals live there instead, where they're directly testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over one `service.call("get_board", …)`
// (CLAUDE.md: "Every adapter is a thin shell over a service call"). Nothing
// under `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useEffect, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { fetchBoard, boardErrorMessageFrom, type BoardLoadState } from "@/lib/board/state";
import { BoardView } from "./BoardView";

export function Board() {
  const { activeProfile } = useProfile();
  const [loadState, setLoadState] = useState<BoardLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchBoard()
      .then((board) => {
        if (cancelled) return;
        setLoadState({ status: "loaded", board });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: boardErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <BoardView loadState={loadState} personId={activeProfile?.id ?? null} />;
}
