// MCP over stdio (MILESTONES.md #84) and DECISIONS.md §13f, "MCP moves to
// stdio, which is the standard local transport anyway" — the substitute for
// a server in a no-server installation.
//
// **This is the only file in `src/lib/mcp/` that knows stdio exists**,
// exactly the property `./http.ts`'s header states for HTTP. The core
// (`./server.ts`) registers tools and calls the service; this module takes
// the server the core built and connects it to a transport that reads
// stdin and writes stdout. Nothing here duplicates a handler, an operation
// name, or a rejection shape — see `./server.ts`'s own header for what
// "transport-agnostic" rules out, and `tests/mcp-transport-agnostic.test.ts`
// for the structural proof that the core still holds no dependency on
// either transport.
//
// ── One long-lived connection, not one per message ───────────────────────
//
// `./http.ts` builds a fresh server and transport **per request**, because
// streamable HTTP serves many independent callers and statelessness is the
// point (its own header, "Stateless, and what that rules out"). Stdio has
// exactly one caller for the process's whole life — `mcp_stdio` is
// `embedded` in the adapter registry (`src/lib/adapters/registry.ts`), the
// same class as the CLI's own `direct` binding, not `network` like
// `mcp_http` — so this module builds **one** server and **one** transport
// and keeps them open for as long as stdin stays open. Building a fresh pair
// per message here would not buy statelessness; it would just add a
// reconnect handshake between every pair of calls a single agent makes.
//
// ── What ends the connection ──────────────────────────────────────────────
//
// MCP has no shutdown message of its own — how a connection ends is a
// transport decision, made once per transport. For streamable HTTP it is
// `DELETE` (`./http.ts`'s route forwards it). For stdio the natural signal
// is stdin reaching end-of-file: the client closed its write side, so there
// is nothing left to read and nothing more it will ask for.
//
// The SDK's own `StdioServerTransport` does **not** react to that signal —
// it only listens for `'data'` and `'error'` on the input stream, never
// `'end'` — so left alone it would sit open forever once its caller stopped
// writing. `serveMcpStdio` listens for `'end'` itself and closes the server
// when it fires, which is what makes this function resolve rather than hang,
// and what makes the whole thing testable without a subprocess or a signal:
// a test ends its fake input stream exactly the way a real client closing
// its pipe would.
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type ServiceCall } from "./server";

/** The transport name stamped on every call arriving this way (SCHEMA.md §21). */
export const MCP_STDIO_TRANSPORT = "mcp-stdio";

export interface StdioServeOptions {
  /** Defaults to `process.stdin`. A parameter so a test can feed framed messages without a subprocess. */
  readonly input?: Readable;
  /** Defaults to `process.stdout`. A parameter so a test can read framed responses back. */
  readonly output?: Writable;
}

/**
 * Serves one MCP connection over stdio.
 *
 * Resolves once the connection has closed — in production that is only when
 * the client closes its end of stdin, at which point there is nothing left
 * for this process to do. Until then the same server keeps answering every
 * call on the one transport; there is no per-call reconnect the way
 * `./http.ts` has a per-request one, because there is only one caller to
 * lose state between calls with.
 */
export function serveMcpStdio(call: ServiceCall, options: StdioServeOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const server = createMcpServer({ call, transport: MCP_STDIO_TRANSPORT });
  const transport = new StdioServerTransport(input, options.output ?? process.stdout);

  return new Promise((resolve, reject) => {
    // Set *before* `connect()`: the SDK's `Protocol.connect` captures
    // whatever `onclose` is already on the transport and wraps it, calling
    // ours first and then its own internal cleanup — set after `connect()`
    // this handler would silently replace the SDK's, rather than run
    // alongside it.
    transport.onclose = () => resolve();

    // The signal this module exists to add: stdin ending is what closes a
    // stdio connection, and closing the server is what turns that signal
    // into the `onclose` above, which is what resolves this promise.
    input.once("end", () => {
      server.close().catch(reject);
    });

    server.connect(transport).catch(reject);
  });
}
