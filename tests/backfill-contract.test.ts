// The backfill payload contract (`src/lib/backfill/contract.ts`) — the
// public interface an outside converter has to satisfy.
//
// **Why this file exists.** The r06 review of PR #79 found that nothing
// under `tests/` imported `backfillPayloadSchema`, and that `contract.ts`
// had *grown* untested surface: the `originPersonId` refine landed with no
// test of either branch. The schema is the one thing a converter author
// writes against, so its refusals are the contract — an accidental
// loosening is a silently wider interface, not a local bug.
//
// Pure — a schema and its inputs, no database and no I/O. Every fixture is
// invented; this repository is public (CLAUDE.md).
import { describe, expect, it } from "vitest";
import {
  BACKFILL_CONTRACT_VERSION,
  backfillPayloadSchema,
  ITEM_STATES,
  VERDICT_VALUES,
} from "@/lib/backfill/contract";

const TASK_ID = "T-19700101-example-one";

/** A minimal task the schema accepts — the four genuinely required fields. */
function task(overrides: Record<string, unknown> = {}) {
  return { id: TASK_ID, title: "Title", body: "# Brief\n", status: "executing", ...overrides };
}

/** A minimal payload the schema accepts. */
function payload(overrides: Record<string, unknown> = {}) {
  return { version: BACKFILL_CONTRACT_VERSION, defaultArea: "imported", tasks: [], ...overrides };
}

/** The `path` of the first issue mentioning `segment`, for asserting *where* a refusal was raised. */
function issuePaths(result: ReturnType<typeof backfillPayloadSchema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

// ---------------------------------------------------------------------------
// `originPersonId` — the refine the review named. AC2.
// ---------------------------------------------------------------------------

describe("a task's originType/originPersonId pairing", () => {
  it("requires originPersonId when originType is person", () => {
    // The rejection path. `originType: "person"` asserts a *person* created
    // the item — the claim the trust badge and the merge-authority reading
    // both rest on — so it may not be made without naming who.
    const result = backfillPayloadSchema.safeParse(
      payload({ tasks: [task({ originType: "person" })] }),
    );

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("tasks.0.originPersonId");
    expect(JSON.stringify(result.success ? {} : result.error.issues)).toContain(
      "originPersonId is required when originType is person",
    );
  });

  it("accepts originType person when originPersonId names someone", () => {
    const result = backfillPayloadSchema.safeParse(
      payload({ tasks: [task({ originType: "person", originPersonId: "user-a" })] }),
    );

    expect(result.success).toBe(true);
  });

  it("still requires it when originPersonId is present but empty", () => {
    // An empty string is a name that identifies nobody. Caught by the
    // field's own `min(1)` rather than the refine, but the contract's
    // promise is the same either way and worth pinning.
    const result = backfillPayloadSchema.safeParse(
      payload({ tasks: [task({ originType: "person", originPersonId: "" })] }),
    );

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("tasks.0.originPersonId");
  });

  it.each(["source", "auto"] as const)(
    "does not require originPersonId when originType is %s",
    (originType) => {
      // The other half of the branch. A refine written as "originPersonId is
      // always required" would pass the rejection test above and fail here,
      // so both directions are needed to pin the condition.
      const result = backfillPayloadSchema.safeParse(payload({ tasks: [task({ originType })] }));

      expect(result.success).toBe(true);
    },
  );

  it("does not require originPersonId when originType is omitted entirely", () => {
    // Omitted defaults to `source` (the field's own doc), so the refine must
    // not fire on `undefined` — the case a `!==` written against the wrong
    // value would get backwards.
    expect(backfillPayloadSchema.safeParse(payload({ tasks: [task()] })).success).toBe(true);
  });

  it("allows originPersonId alongside a non-person originType", () => {
    // The refine constrains one direction only: it says person needs an id,
    // not that an id implies person. Asserted so a later tightening is a
    // deliberate contract change rather than an accident.
    const result = backfillPayloadSchema.safeParse(
      payload({ tasks: [task({ originType: "auto", originPersonId: "user-a" })] }),
    );

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two properties that make this a contract rather than a convenience.
// ---------------------------------------------------------------------------

describe("the contract's version", () => {
  it("accepts the version this build declares", () => {
    expect(backfillPayloadSchema.safeParse(payload()).success).toBe(true);
  });

  it("refuses any other version by name rather than half-working", () => {
    const result = backfillPayloadSchema.safeParse(payload({ version: 2 }));

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("version");
  });

  it("refuses a missing version", () => {
    const withoutVersion = { ...payload() } as Record<string, unknown>;
    delete withoutVersion.version;
    expect(backfillPayloadSchema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe("strictness — an unrecognised key is refused, never ignored", () => {
  it("refuses an unknown key at the payload root", () => {
    const result = backfillPayloadSchema.safeParse(payload({ taskz: [] }));

    expect(result.success).toBe(false);
  });

  it("refuses a typo'd field on a task instead of silently dropping the data", () => {
    // The failure this property exists to prevent: a converter writing
    // `titel` would otherwise import every task with the wrong title and
    // report success.
    const result = backfillPayloadSchema.safeParse(
      payload({ tasks: [{ ...task(), titel: "Typo" }] }),
    );

    expect(result.success).toBe(false);
  });

  it("refuses an unknown key on a nested history entry", () => {
    const result = backfillPayloadSchema.safeParse(
      payload({
        tasks: [
          task({
            history: [
              { id: "h1", actor: "system", at: "1970-01-01T00:00:00Z", note: "n", extra: 1 },
            ],
          }),
        ],
      }),
    );

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `defaultArea` — validated on the schema on purpose (see the field's doc:
// it is what makes the MCP adapter's waiver legal).
// ---------------------------------------------------------------------------

describe("defaultArea", () => {
  it("accepts an ordinary area name", () => {
    expect(backfillPayloadSchema.safeParse(payload({ defaultArea: "imported" })).success).toBe(
      true,
    );
  });

  it("refuses an empty area", () => {
    expect(backfillPayloadSchema.safeParse(payload({ defaultArea: "" })).success).toBe(false);
  });

  it("refuses one made only of separators, which would normalise to nothing", () => {
    // `" - _ / "` trims to a non-empty string, so `min(1)` alone passes it —
    // the extra refine is what catches a value that becomes empty once the
    // area resolver strips separators.
    const result = backfillPayloadSchema.safeParse(payload({ defaultArea: " - _ / " }));

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("defaultArea");
  });

  it("accepts a name that contains separators alongside real characters", () => {
    expect(backfillPayloadSchema.safeParse(payload({ defaultArea: "web-app" })).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The alias maps' target vocabularies — this application's own words.
// ---------------------------------------------------------------------------

describe("statusAliases", () => {
  it("accepts a mapping onto one of this application's states", () => {
    const result = backfillPayloadSchema.safeParse(
      payload({ statusAliases: { "in-flight": "executing" } }),
    );

    expect(result.success).toBe(true);
  });

  it("refuses a mapping onto a state this application does not have", () => {
    // The target vocabulary is closed. A converter aiming at `done` has to
    // find out here, not by importing every task into a state that does not
    // exist.
    const result = backfillPayloadSchema.safeParse(payload({ statusAliases: { done: "done" } }));

    expect(result.success).toBe(false);
  });

  it("covers every declared state as a legal target", () => {
    // Guards the enum against drifting from ITEM_STATES: a state added to
    // the list but not reachable through the alias map is unimportable.
    for (const state of ITEM_STATES) {
      const result = backfillPayloadSchema.safeParse(payload({ statusAliases: { src: state } }));
      expect(result.success, `statusAliases should accept ${state}`).toBe(true);
    }
  });
});

describe("verdictAliases", () => {
  it("maps a source's punctuation onto this application's spelling", () => {
    // The stated reason this map exists: `lgtm-with-nits` is not
    // `lgtm_with_nits`, and the application will not guess that a hyphen
    // was meant to be an underscore.
    const result = backfillPayloadSchema.safeParse(
      payload({ verdictAliases: { "lgtm-with-nits": "lgtm_with_nits" } }),
    );

    expect(result.success).toBe(true);
  });

  it("refuses a verdict this application does not store", () => {
    expect(
      backfillPayloadSchema.safeParse(payload({ verdictAliases: { nope: "rejected" } })).success,
    ).toBe(false);
  });

  it("covers every declared verdict as a legal target", () => {
    for (const verdict of VERDICT_VALUES) {
      const result = backfillPayloadSchema.safeParse(payload({ verdictAliases: { src: verdict } }));
      expect(result.success, `verdictAliases should accept ${verdict}`).toBe(true);
    }
  });
});

describe("severityAliases", () => {
  it("accepts a mapping onto one of this application's levels", () => {
    expect(
      backfillPayloadSchema.safeParse(payload({ severityAliases: { HIGH: "high" } })).success,
    ).toBe(true);
  });

  it("refuses a level this application does not have, rather than case-folding into one", () => {
    // The field's doc is explicit that there is no case-folding fallback: a
    // transform would silently accept a hedge by mangling it into a level
    // nobody chose.
    expect(
      backfillPayloadSchema.safeParse(payload({ severityAliases: { HIGH: "HIGH" } })).success,
    ).toBe(false);
  });
});

describe("actorAliases", () => {
  it("accepts a null actorId for a system actor", () => {
    const result = backfillPayloadSchema.safeParse(
      payload({ actorAliases: { cron: { actorType: "system", actorId: null } } }),
    );

    expect(result.success).toBe(true);
  });

  it("refuses a null actorId for a person or an agent", () => {
    // The refine's whole content: only `system` may be attributed to
    // nobody. A person alias with no id records an attribution that names
    // no one.
    const result = backfillPayloadSchema.safeParse(
      payload({ actorAliases: { someone: { actorType: "person", actorId: null } } }),
    );

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? {} : result.error.issues)).toContain(
      "actorId is required unless actorType is system",
    );
  });

  it("accepts a named agent", () => {
    const result = backfillPayloadSchema.safeParse(
      payload({ actorAliases: { bot: { actorType: "agent", actorId: "agent-a" } } }),
    );

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timestamps and findings.
// ---------------------------------------------------------------------------

describe("timestamps", () => {
  it("accepts a parseable timestamp", () => {
    expect(
      backfillPayloadSchema.safeParse(
        payload({ tasks: [task({ createdAt: "1970-01-01T00:00:00Z" })] }),
      ).success,
    ).toBe(true);
  });

  it("refuses a string that is not a date at all", () => {
    const result = backfillPayloadSchema.safeParse(
      payload({ tasks: [task({ createdAt: "not-a-date" })] }),
    );

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("tasks.0.createdAt");
  });
});

describe("a review's findings", () => {
  const base = {
    id: "a1",
    kind: "code_review",
    createdByType: "agent" as const,
    createdById: "agent-a",
    createdAt: "1970-01-01T00:00:00Z",
  };

  it("accepts a finding with no severity — ungraded is a distinct claim from graded low", () => {
    const result = backfillPayloadSchema.safeParse(
      payload({ tasks: [task({ reviews: [{ ...base, findings: [{ text: "A finding" }] }] })] }),
    );

    expect(result.success).toBe(true);
  });

  it("refuses a finding whose text is only whitespace", () => {
    // `text` is trimmed before the length check, so a blank finding cannot
    // be stored as though it said something.
    const result = backfillPayloadSchema.safeParse(
      payload({ tasks: [task({ reviews: [{ ...base, findings: [{ text: "   " }] }] })] }),
    );

    expect(result.success).toBe(false);
  });

  it("takes severity as a free string, leaving the ladder check to the importer", () => {
    // Deliberate: the translation table lives at the payload's root and Zod
    // cannot reach across to it, so the refusal happens in the importer
    // where the value, the review and the index can all be named.
    const result = backfillPayloadSchema.safeParse(
      payload({
        tasks: [
          task({ reviews: [{ ...base, findings: [{ text: "A finding", severity: "HIGH" }] }] }),
        ],
      }),
    );

    expect(result.success).toBe(true);
  });
});
