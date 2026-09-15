"use client";

// The thin container for `/needs-you`: fetches the inbox for the active
// profile and wires the four response actions, handing everything else to
// `NeedsYouInboxView` as plain props — the same split `SinceLastVisit.tsx`
// follows and for the same reason (see that file's header).
//
// The reply text for each row lives here rather than in the row, so
// `NeedsYouRow` stays hook-free and directly callable by this repo's
// DOM-free test harness.
import { useCallback, useEffect, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import {
  answer,
  approve,
  grantStandingApproval,
  reject,
  type RespondResult,
} from "@/lib/needs-you/respond";
import {
  fetchNeedsYou,
  needsYouErrorMessageFrom,
  type NeedsYouLoadState,
} from "@/lib/needs-you/state";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import { NeedsYouInboxView } from "./NeedsYouInboxView";

export function NeedsYouInbox() {
  const { activeProfile } = useProfile();
  const personId = activeProfile?.id ?? null;

  // Same staleness guard `SinceLastVisit` uses: the loaded state carries the
  // profile id it was loaded for, so switching profiles mid-flight cannot
  // paint one person's inbox as another's while the new fetch is still in
  // the air. See that component's header for the full reasoning.
  const [loaded, setLoaded] = useState<{
    personId: string | null;
    state: NeedsYouLoadState;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [respondError, setRespondError] = useState<string | null>(null);
  const [respondNotice, setRespondNotice] = useState<string | null>(null);
  const [replyTexts, setReplyTexts] = useState<Record<string, string>>({});
  /**
   * Which rows have armed the standing grant's confirm step.
   *
   * Held here rather than in the row for the same reason `replyTexts` is:
   * `NeedsYouRow` stays hook-free so a test can call it as a function and
   * read back the element tree, which this repo's node-environment harness
   * requires.
   */
  const [standingPending, setStandingPending] = useState<Record<string, boolean>>({});
  // Sampled once per load rather than read at render time — see
  // `StandupHome.tsx`'s own note (and `Projects.tsx`, which this mirrors)
  // on why `Date.now()` cannot be called during render.
  const [now, setNow] = useState(0);

  const loadState: NeedsYouLoadState =
    loaded !== null && loaded.personId === personId ? loaded.state : { status: "loading" };

  const load = useCallback(() => {
    let cancelled = false;
    fetchNeedsYou(personId)
      .then(({ items, total }) => {
        if (cancelled) return;
        setNow(Date.now());
        setLoaded({ personId, state: { status: "loaded", items, total } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({ personId, state: { status: "error", message: needsYouErrorMessageFrom(err) } });
      });
    return () => {
      cancelled = true;
    };
  }, [personId]);

  useEffect(() => load(), [load]);

  const findItem = useCallback(
    (itemId: string): NeedsYouItem | null => {
      if (loaded === null || loaded.state.status !== "loaded") return null;
      return loaded.state.items.find((item) => item.id === itemId) ?? null;
    },
    [loaded],
  );

  /**
   * Runs one response and settles the row afterwards.
   *
   * Always re-fetches on success rather than removing the row locally: a
   * response may or may not remove the item from the inbox (an approved
   * merge does; a recorded visual review may not, if the item is still held
   * by another clause), and re-deriving that here would be a second copy of
   * the admission rule. Since T24 the refetch is a single bounded read.
   */
  const run = useCallback(
    (itemId: string, act: () => Promise<RespondResult>, notice: string) => {
      setRespondError(null);
      setRespondNotice(null);
      setBusyId(itemId);
      void act()
        .then((result) => {
          setBusyId(null);
          if (!result.ok) {
            setRespondError(result.message);
            return;
          }
          setRespondNotice(notice);
          load();
        })
        .catch(() => {
          setBusyId(null);
          setRespondError("Something went wrong recording that.");
        });
    },
    [load],
  );

  /** The shared input every decision action needs, or null when the row is unknown. */
  const decisionInput = useCallback(
    (itemId: string) => {
      if (personId === null) return null;
      const item = findItem(itemId);
      if (item === null) return null;
      return {
        itemId,
        reason: item.reason,
        personId,
        // The row's own `state` as the last load reported it — the server's
        // value, not one derived from `reason` here. That makes a decision
        // taken against a stale list a 409 rather than a silent overwrite.
        expectedFrom: item.state,
        tipCommitSha: item.tipCommitSha,
      };
    },
    [personId, findItem],
  );

  const handleApprove = useCallback(
    (itemId: string) => {
      const input = decisionInput(itemId);
      if (input === null) return;
      run(
        itemId,
        () => approve(input),
        input.reason === "needs_approval"
          ? "Merge approved — recorded against the commit."
          : "Recorded.",
      );
    },
    [decisionInput, run],
  );

  const handleReject = useCallback(
    (itemId: string) => {
      const input = decisionInput(itemId);
      if (input === null) return;
      run(itemId, () => reject(input), "Changes requested.");
    },
    [decisionInput, run],
  );

  const handleAnswer = useCallback(
    (itemId: string) => {
      if (personId === null) return;
      const body = replyTexts[itemId] ?? "";
      run(itemId, () => answer({ itemId, personId, body }), "Answer sent.");
      // Cleared optimistically alongside the send. On a failure the message
      // above says so and the text is gone, which is the one rough edge
      // here; keeping it would mean holding it against a refetch that may
      // have removed the row.
      setReplyTexts((prev) => ({ ...prev, [itemId]: "" }));
    },
    [personId, replyTexts, run],
  );

  const handleGrantStanding = useCallback(
    (itemId: string) => {
      run(
        itemId,
        () => grantStandingApproval({ itemId }),
        "This item is now pre-approved — it will merge without asking you again.",
      );
      // Stood back down as the grant is sent. Leaving it armed would show
      // the confirm step again on a row that has already been granted.
      setStandingPending((prev) => ({ ...prev, [itemId]: false }));
    },
    [run],
  );

  const handleStandingPendingChange = useCallback((itemId: string, pending: boolean) => {
    setStandingPending((prev) => ({ ...prev, [itemId]: pending }));
  }, []);

  const handleReplyTextChange = useCallback((itemId: string, value: string) => {
    setReplyTexts((prev) => ({ ...prev, [itemId]: value }));
  }, []);

  return (
    <NeedsYouInboxView
      loadState={loadState}
      now={now}
      busyId={busyId}
      onApprove={handleApprove}
      onReject={handleReject}
      onAnswer={handleAnswer}
      onGrantStanding={handleGrantStanding}
      replyTexts={replyTexts}
      onReplyTextChange={handleReplyTextChange}
      standingPending={standingPending}
      onStandingPendingChange={handleStandingPendingChange}
      respondError={respondError}
      respondNotice={respondNotice}
    />
  );
}
