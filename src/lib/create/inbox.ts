// The inbox sentinel, as the browser needs to know it — T18 quick create.
//
// **Why this is re-declared rather than imported.** The literal is defined
// by `create_task` itself, in `src/lib/service/operations/create-task.ts`,
// and that module is the authority on it. But that module imports `zod`,
// the service's `defineOperation`, the error types and `resolveInboxProject`
// — the whole service layer — and this one is imported by a React component
// that runs in a browser. Importing the operation to reach one string would
// pull the service (and transitively the database client) into the client
// bundle, which is the thing `src/lib/ui-proxy/path.ts` calls out about
// staying "free of anything server-only".
//
// A duplicated constant is a drift risk, so it is not left to trust:
// `tests/create-contract.test.ts` imports both this module and the
// operation and asserts they are the same string. The duplication is
// therefore checked rather than hoped for, which is the only form of it
// worth having.

/**
 * The literal a caller writes in `projectId` to mean "the configured inbox
 * project" — see `create-task.ts`, which owns it.
 *
 * It cannot collide with a real project: ids are generated as UUIDs.
 */
export const INBOX_PROJECT_ID = "inbox";
