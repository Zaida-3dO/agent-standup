// MILESTONES.md #128 - delivery of a batch, and the ordinary-service-
// response field (`src/lib/interventions/delivery.ts`,
// `src/lib/interventions/service-delivery.ts`).
//
// The row lists two things as missing and this covers both, because the
// implementation answers them with one channel: findings ride back beside
// the normal payload, and a digest rides the same field when one is due.
//
// The properties below are the ways that quietly stops being true:
//
//   - attaching an envelope to a response that triggered nothing, which
//     would change the shape every existing caller reads,
//   - delivering a `digest`-timed nudge immediately, which is the drip the
//     whole design exists to avoid,
//   - deferring a block, which would arrive long after the call it existed
//     to stop,
//   - dropping a finding the accumulator declined at its bound, which loses
//     it entirely rather than delivering it late,
//   - taking a batch before holding this call's own findings, which would
//     report a digest omitting what the caller just did,
//   - mixing one session's findings into another's batch.
//
// Nothing here fakes a clock: `now` is a value everywhere, exactly as in
// `interventions-digest.test.ts`.
import { describe, expect, it } from "vitest";
import { DigestAccumulator } from "@/lib/interventions/digest";
import {
  attachInterventions,
  decideDelivery,
  hasAnything,
  partitionFindings,
  renderPayload,
  type InterventionEnvelope,
} from "@/lib/interventions/delivery";
import { createServiceDeliverer } from "@/lib/interventions/service-delivery";
import type { InterventionFinding } from "@/lib/interventions/types";

function finding(overrides: Partial<InterventionFinding> = {}): InterventionFinding {
  return {
    id: "example",
    source: "builtin",
    phase: "post",
    audience: "orchestrator",
    level: "nudge",
    timing: "digest",
    messages: { plain: "plain text", prominent: "PROMINENT TEXT" },
    ...overrides,
  };
}

/** Narrows a delivery result to the envelope, failing loudly when it is not one. */
function envelope<T>(result: T | InterventionEnvelope<T>): InterventionEnvelope<T> {
  if (typeof result !== "object" || result === null || !("interventions" in result)) {
    throw new Error(`expected an envelope, got ${JSON.stringify(result)}`);
  }
  return result as InterventionEnvelope<T>;
}

describe("splitting findings into what goes now and what waits", () => {
  it("defers a digest-timed nudge", () => {
    const { immediate, deferred } = partitionFindings([
      finding({ level: "nudge", timing: "digest" }),
    ]);
    expect(deferred).toHaveLength(1);
    expect(immediate).toHaveLength(0);
  });

  it("delivers an immediate-timed nudge now", () => {
    const { immediate, deferred } = partitionFindings([
      finding({ level: "nudge", timing: "immediate" }),
    ]);
    expect(immediate).toHaveLength(1);
    expect(deferred).toHaveLength(0);
  });

  // The one with teeth. A block that rode a digest would be delivered five
  // minutes after the call it existed to stop, which is indistinguishable
  // from never having blocked. `ridesDigest` refuses it even when the timing
  // field says otherwise, and this asserts the delivery path inherits that
  // refusal rather than forming a second opinion that could disagree.
  it("never defers a blocking finding, even when its timing says digest", () => {
    for (const level of ["block-overridable", "hard-block"] as const) {
      const { immediate, deferred } = partitionFindings([finding({ level, timing: "digest" })]);
      expect(deferred, `${level} must not be deferred`).toHaveLength(0);
      expect(immediate, `${level} must be delivered now`).toHaveLength(1);
    }
  });

  it("does not defer a nothing-level finding, which has nothing to say", () => {
    const { immediate, deferred } = partitionFindings([
      finding({ level: "nothing", timing: "digest" }),
    ]);
    expect(deferred).toHaveLength(0);
    expect(immediate).toHaveLength(1);
  });
});

describe("what rides back on one response", () => {
  it("holds a digest-timed finding rather than delivering it", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    const payload = decideDelivery(accumulator, {
      sessionId: "s1",
      findings: [finding({ timing: "digest" })],
      now: 0,
    });

    expect(payload.findings).toBeUndefined();
    expect(payload.digest).toBeUndefined();
    expect(accumulator.pendingCount("s1")).toBe(1);
  });

  it("delivers an immediate finding on the same response", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    const payload = decideDelivery(accumulator, {
      sessionId: "s1",
      findings: [finding({ id: "now", timing: "immediate" })],
      now: 0,
    });

    expect(payload.findings?.map((entry) => entry.id)).toEqual(["now"]);
    expect(accumulator.pendingCount("s1")).toBe(0);
  });

  it("delivers a batch once the interval has elapsed", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    decideDelivery(accumulator, { sessionId: "s1", findings: [finding({ id: "a" })], now: 0 });

    const early = decideDelivery(accumulator, { sessionId: "s1", now: 999 });
    expect(early.digest, "not due one millisecond early").toBeUndefined();

    const due = decideDelivery(accumulator, { sessionId: "s1", now: 1000 });
    expect(due.digest?.findings.map((entry) => entry.id)).toEqual(["a"]);
  });

  // Ordering: hold this call's findings, then take. Taking first would
  // produce a batch that omitted what the caller had just done - an omission
  // obvious to anyone comparing the digest against their own actions, and
  // the finding would then wait another full interval for a batch it had
  // already missed.
  it("includes a finding noticed on this very call in the batch it delivers", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    decideDelivery(accumulator, { sessionId: "s1", findings: [finding({ id: "first" })], now: 0 });

    const payload = decideDelivery(accumulator, {
      sessionId: "s1",
      findings: [finding({ id: "second" })],
      now: 1000,
    });

    expect(payload.digest?.findings.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  // `DigestAccumulator.add` answers false at its bound, and its own contract
  // says a caller is then free to deliver it immediately rather than lose
  // it. A caller that ignored the answer would deliver it neither now nor
  // later, and it would vanish silently.
  it("delivers a finding the accumulator refused at its bound rather than dropping it", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 10_000, maxPending: 1 });
    decideDelivery(accumulator, { sessionId: "s1", findings: [finding({ id: "held" })], now: 0 });

    const payload = decideDelivery(accumulator, {
      sessionId: "s1",
      findings: [finding({ id: "overflow" })],
      now: 1,
    });

    expect(payload.findings?.map((entry) => entry.id)).toEqual(["overflow"]);
    expect(accumulator.pendingCount("s1")).toBe(1);
  });

  it("keeps one session's findings out of another's batch", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    decideDelivery(accumulator, { sessionId: "s1", findings: [finding({ id: "mine" })], now: 0 });
    decideDelivery(accumulator, { sessionId: "s2", findings: [finding({ id: "theirs" })], now: 0 });

    const first = decideDelivery(accumulator, { sessionId: "s1", now: 1000 });
    expect(first.digest?.findings.map((entry) => entry.id)).toEqual(["mine"]);
  });

  // No session id means no key to batch under. A shared bucket would deliver
  // one session's findings to another, which is worse than not batching.
  it("batches nothing for a call that names no session, but still delivers immediately", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    const payload = decideDelivery(accumulator, {
      findings: [finding({ id: "now", timing: "immediate" }), finding({ id: "later" })],
      now: 0,
    });

    expect(payload.findings?.map((entry) => entry.id)).toEqual(["now"]);
    expect(payload.digest).toBeUndefined();
  });

  it("says nothing at all when nothing triggered", () => {
    const accumulator = new DigestAccumulator({ intervalMs: 1000 });
    expect(decideDelivery(accumulator, { sessionId: "s1", findings: [], now: 0 })).toEqual({});
  });
});

describe("attaching the payload to a result", () => {
  // The property that makes this safe on every response in the system: a
  // call that triggered nothing returns the value it always returned, by
  // identity. Anything else would change the shape every existing caller,
  // adapter and test reads.
  it("returns the original value unchanged, by identity, when nothing triggered", () => {
    const result = { id: "item-1" };
    expect(attachInterventions(result, {})).toBe(result);
  });

  it("does not wrap a payload whose only digest is empty", () => {
    const result = { id: "item-1" };
    expect(attachInterventions(result, { digest: { findings: [], from: 0, to: 1 } })).toBe(result);
  });

  it("nests the result rather than spreading it, so an array survives", () => {
    const result = [1, 2, 3];
    const wrapped = envelope(attachInterventions(result, { findings: [finding()] }));
    expect(wrapped.result).toEqual([1, 2, 3]);
  });

  it("carries both message forms so a surface can still choose prominence", () => {
    const wrapped = envelope(attachInterventions({}, { findings: [finding()] }));
    expect(wrapped.interventions.findings?.[0]?.messages).toEqual({
      plain: "plain text",
      prominent: "PROMINENT TEXT",
    });
  });

  it("treats an empty findings array as nothing to say", () => {
    expect(hasAnything({ findings: [] })).toBe(false);
    expect(hasAnything({ findings: [finding()] })).toBe(true);
  });
});

describe("rendering a payload for a surface that wants one string", () => {
  const render = (batch: { findings: readonly InterventionFinding[] }) =>
    `digest:${batch.findings.length}`;

  it("is null when there is nothing to say", () => {
    expect(renderPayload({}, render)).toBeNull();
  });

  it("omits a nothing-level finding, which is recorded but silent", () => {
    expect(renderPayload({ findings: [finding({ level: "nothing" })] }, render)).toBeNull();
  });

  it("puts the immediate finding before the digest", () => {
    const text = renderPayload(
      {
        findings: [finding({ level: "nudge", messages: { plain: "act now", prominent: "!" } })],
        digest: { findings: [finding()], from: 0, to: 1 },
      },
      render,
    );
    expect(text).toBe("act now\ndigest:1");
  });
});

describe("the deliverer the runtime is given", () => {
  it("returns the result untouched for a call naming no session", () => {
    const deliver = createServiceDeliverer({ now: () => 0 });
    const result = { id: "item-1" };
    expect(deliver(result, {})).toBe(result);
  });

  it("returns the result untouched when the session has nothing pending", () => {
    const deliver = createServiceDeliverer({ now: () => 0 });
    const result = { id: "item-1" };
    expect(deliver(result, { sessionId: "s1" })).toBe(result);
  });

  // The whole point of the feature, end to end: something notices a
  // situation, and the session is told about it on the next ordinary
  // service call it makes - not through the hook.
  it("delivers held findings on a later ordinary call, once due", () => {
    let now = 0;
    const deliver = createServiceDeliverer({
      accumulator: new DigestAccumulator({ intervalMs: 1000 }),
      now: () => now,
    });

    deliver.hold("s1", [finding({ id: "quiet-agent" })], 0);
    expect(deliver.pendingCount("s1")).toBe(1);

    now = 999;
    expect(deliver({ id: "item-1" }, { sessionId: "s1" })).toEqual({ id: "item-1" });

    now = 1000;
    const wrapped = envelope(deliver({ id: "item-1" }, { sessionId: "s1" }));
    expect(wrapped.result).toEqual({ id: "item-1" });
    expect(wrapped.interventions.digest?.findings.map((entry) => entry.id)).toEqual([
      "quiet-agent",
    ]);
  });

  it("holds nothing for a finding whose timing is immediate", () => {
    const deliver = createServiceDeliverer({ now: () => 0 });
    deliver.hold("s1", [finding({ timing: "immediate" })], 0);
    expect(deliver.pendingCount("s1")).toBe(0);
  });

  it("forgets a session that has ended", () => {
    const deliver = createServiceDeliverer({ now: () => 0 });
    deliver.hold("s1", [finding()], 0);
    deliver.forget("s1");
    expect(deliver.pendingCount("s1")).toBe(0);
  });

  it("clears a batch once delivered, so it is not repeated in every later one", () => {
    let now = 0;
    const deliver = createServiceDeliverer({
      accumulator: new DigestAccumulator({ intervalMs: 1000 }),
      now: () => now,
    });

    deliver.hold("s1", [finding({ id: "once" })], 0);
    now = 1000;
    envelope(deliver({}, { sessionId: "s1" }));

    now = 5000;
    expect(deliver({ id: "item-1" }, { sessionId: "s1" })).toEqual({ id: "item-1" });
  });
});
