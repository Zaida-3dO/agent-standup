// Talks to the items API (#26, #27) directly over HTTP — its own small
// fetch wrapper rather than `src/lib/cli/bindings/http.ts`'s `HTTP_ROUTES`.
// That map is keyed on the service's *operation* names and is being extended
// by rows building the standup command line's own item verbs in parallel;
// this surface calls the same routes those operations sit behind, but reads
// and writes the reduced `ShimTask` shape (`contract.ts`), never the
// service's operation names or its full item record. Two callers wanting two
// different shapes off the same routes is exactly what stays simple by not
// sharing one binding between them.
import { toShimTask, type ShimTask } from "./contract";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ShimClientOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
}

export type ShimResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly message: string };

function property(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function errorMessage(body: unknown, status: number): string {
  const message = property(property(body, "error"), "message");
  if (typeof message === "string" && message.length > 0) return message;
  return `The server refused (HTTP ${status}).`;
}

async function request(
  options: ShimClientOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<ShimResult<unknown>> {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const root = options.baseUrl.replace(/\/+$/, "");

  let response: Response;
  try {
    response = await doFetch(`${root}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // Deliberately fixed text — see `bindings/http.ts`'s own reasoning for
    // why a connect failure's message is never interpolated: it routinely
    // carries the host and port of `baseUrl`, which is this surface's
    // equivalent of a connection string.
    return { ok: false, message: "Could not reach the server." };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    return { ok: false, message: errorMessage(parsed, response.status) };
  }

  return { ok: true, data: parsed };
}

function toShimResult(result: ShimResult<unknown>, key: string): ShimResult<ShimTask> {
  if (!result.ok) return result;
  const item = property(result.data, key);
  if (typeof item !== "object" || item === null) {
    return { ok: false, message: "The server answered with a body this build does not recognise." };
  }
  return { ok: true, data: toShimTask(item as Record<string, unknown>) };
}

export async function createTask(
  options: ShimClientOptions,
  input: { title: string; body: string; area: string; repo?: string },
): Promise<ShimResult<ShimTask>> {
  const result = await request(options, "POST", "/api/items", {
    title: input.title,
    body: input.body,
    area: input.area,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    // Neither "a person" nor "the system" minted this — it arrived through
    // this surface, which is what `source` means on `originType`
    // (SCHEMA.md §1's "who or what created it"; the importer, #10, makes the
    // same choice for the same reason).
    originType: "source",
  });
  return toShimResult(result, "item");
}

export async function getTask(
  options: ShimClientOptions,
  id: string,
): Promise<ShimResult<ShimTask>> {
  const result = await request(options, "GET", `/api/items/${encodeURIComponent(id)}`);
  return toShimResult(result, "item");
}

export async function updateTask(
  options: ShimClientOptions,
  id: string,
  edits: { title?: string; body?: string; repo?: string; area?: string },
): Promise<ShimResult<ShimTask>> {
  const result = await request(options, "PATCH", `/api/items/${encodeURIComponent(id)}`, edits);
  return toShimResult(result, "item");
}

export interface ListTaskFilters {
  readonly state?: string;
  readonly repo?: string;
  readonly area?: string;
  /**
   * Ask for finished work too. The list endpoint excludes terminal states by
   * default, so without a way to say otherwise `task list` could show only
   * live work and offer no way to see the rest — a default the caller could
   * observe but not override.
   */
  readonly includeTerminal?: boolean;
}

export async function listTasks(
  options: ShimClientOptions,
  filters: ListTaskFilters,
): Promise<ShimResult<readonly ShimTask[]>> {
  const params = new URLSearchParams();
  if (filters.state !== undefined) params.set("state", filters.state);
  if (filters.repo !== undefined) params.set("repo", filters.repo);
  if (filters.area !== undefined) params.set("area", filters.area);
  // Sent only when asked for. The endpoint's own default is the same
  // `false`, so an unconditional `includeTerminal=false` would add a
  // parameter to every request to say what omitting it already says.
  if (filters.includeTerminal === true) params.set("includeTerminal", "true");
  const query = params.toString();

  const result = await request(options, "GET", `/api/items${query.length > 0 ? `?${query}` : ""}`);
  if (!result.ok) return result;
  const items = property(result.data, "items");
  if (!Array.isArray(items)) {
    return { ok: false, message: "The server answered with a body this build does not recognise." };
  }
  return { ok: true, data: items.map((item) => toShimTask(item as Record<string, unknown>)) };
}

export async function transitionTask(
  options: ShimClientOptions,
  id: string,
  to: string,
): Promise<ShimResult<ShimTask>> {
  const result = await request(options, "POST", `/api/items/${encodeURIComponent(id)}/transition`, {
    to,
  });
  return toShimResult(result, "item");
}
