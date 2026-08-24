// Creating a profile from the picker — T13: "An empty picker is a create
// form, not a message." §8a's picker is the literal first screen, and with
// zero profiles it had no action on it at all — just a sentence saying so.
//
// **Why this calls `PATCH /api/people/{id}` directly, not a `POST /people`.**
// `update-person.ts`'s header explains why `people` is spelled as one
// upsert like `machines`/`accounts` rather than a deliberate `POST` like
// `repos`: there is no id-collision risk worth guarding (unlike a
// repository, aiming nothing at the wrong id has any consequence), so a
// second creation verb would just be two paths to the same write. This
// generates the id itself instead — `crypto.randomUUID()`, the same
// generated-id pattern `create-core.ts` and `inbox-project.ts` already use
// — because nothing ever displays a person's `id`: the picker, the top bar
// and every card render `displayName` (and `avatar`/`colour`), so a random
// id costs nothing and sidesteps slugify-collision handling a human-typed
// id would need.
//
// Pure and DOM-free like `./state.ts`'s `fetchPeople`, for the same reason:
// this repo's test harness runs `environment: "node"` (`vitest.config.ts`).
import type { Profile } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";
import { personSwatch } from "@/lib/design/person-colour";

/** Generates a fresh person id. Exported so a test can assert the PATCH targets exactly what this returns, without depending on `crypto.randomUUID()`'s own format. */
export function generatePersonId(): string {
  return crypto.randomUUID();
}

/**
 * Creates a profile via `PATCH /api/people/{id}` with a freshly generated
 * id. Throws a message fit to show directly — never a raw `Response` or a
 * JSON-parse error, matching `fetchPeople`/`errorMessageFrom`.
 */
export async function createPerson(
  displayName: string,
  fetchImpl: typeof fetch = fetch,
  idImpl: () => string = generatePersonId,
): Promise<Profile> {
  const id = idImpl();
  const response = await fetchImpl(uiApiPath(`/api/people/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    // **`colour` is sent, not left to default — T22.** This request used to
    // carry `displayName` alone, so every profile created through the
    // picker (the primary flow, and the only one on first run) got
    // `colour: null` permanently unless someone later happened to open
    // `/admin/people`. Derived from the id rather than picked by the
    // reader, following the precedent `area-colour.ts` set for the same
    // problem: an unbounded, auto-created set gets a deterministic colour
    // instead of a form field nobody wants to fill in. The reader can still
    // change it in the admin grid — this only removes "no colour at all" as
    // a starting state.
    body: JSON.stringify({ displayName, colour: personSwatch(id) }),
  });
  if (!response.ok) {
    const message = await createErrorMessageFrom(response);
    throw new Error(message);
  }
  const body = (await response.json()) as { person: Profile };
  return body.person;
}

/**
 * Reads the service's own error sentence out of a failed response —
 * `update_person` refuses a blank display name by naming the field, and
 * that message is more useful beside the form than a bare status code.
 */
async function createErrorMessageFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Body was not JSON; fall through to the status-based message.
  }
  return `Could not create the profile (${response.status}).`;
}

/** Turns a caught value into the message the create form's error shows. */
export function createErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Could not create the profile.";
}
