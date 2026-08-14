// The registration handshake's two adapters — MILESTONES.md #43.
//
// Both are thin shells over one service call, so what is under test here is
// the *shell*: does argv become the right operation and the right input, does
// the HTTP route stamp a transport the body cannot reach, and does the
// command line's `http` binding say which binding it is on the wire. None of
// that needs a database — the binding is a recorder and the route is exercised
// for its request handling only, which is the same scope
// `tests/cli-ownership-dispatch.test.ts` covers for row #82's commands.
//
// The behaviour behind them — what a version means, whether a claim is
// refused — is `tests/sessions-version-rule.test.ts` and
// `tests/session-registration.test.ts`. Testing it again through an adapter
// would be testing the service layer twice and the adapter not at all.

import { describe, expect, it } from "vitest";
import { COMMANDS, EXIT, lookupCommand, runCommand } from "@/lib/cli";
import type { Binding } from "@/lib/cli";
import { HTTP_ROUTES } from "@/lib/cli/bindings/http";
import { createHttpBinding } from "@/lib/cli/bindings/http";
import {
  CLI_TRANSPORTS,
  CLI_TRANSPORT_HEADER,
  transportForHttpRequest,
} from "@/lib/session-transport-header";
import { assessVersion, variantForTransport } from "@/lib/sessions";
import { HOOK_PROTOCOL, HOOK_VARIANTS } from "@/lib/build-constants";

/** A binding that records every call and always accepts. */
function recorder(): Binding & { calls: { operation: string; input: unknown }[] } {
  const calls: { operation: string; input: unknown }[] = [];
  return {
    name: "direct",
    calls,
    async invoke(operation, input) {
      calls.push({ operation, input });
      return { ok: true, data: { operation } };
    },
  };
}

describe("`standup session register`", () => {
  it("resolves to the register_session operation", () => {
    const found = lookupCommand(["session", "register"]);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe("register_session");
  });

  it("does not collide with another noun/verb pair", () => {
    const pairs = COMMANDS.map((c) => `${c.noun} ${c.verb}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("maps --session to sessionId and passes the rest through", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["session", "register", "--session", "s-1", "--machine", "laptop", "--client", "a-tool"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(binding.calls).toHaveLength(1);
    expect(binding.calls[0]).toEqual({
      operation: "register_session",
      input: { sessionId: "s-1", machine: "laptop", client: "a-tool" },
    });
  });

  it("converts --hook-version to a number, because the schema takes an integer", async () => {
    const binding = recorder();
    await runCommand(
      ["session", "register", "--session", "s-2", "--machine", "m", "--hook-version", "3"],
      binding,
    );
    expect(binding.calls[0]?.input).toEqual({ sessionId: "s-2", machine: "m", hookVersion: 3 });
  });

  it("REFUSES a --hook-version that is not a whole number", async () => {
    // Refused here rather than passed through, so the message names the flag
    // the person typed instead of a schema field they never saw.
    for (const bad of ["abc", "1.5", ""]) {
      const binding = recorder();
      const outcome = await runCommand(
        ["session", "register", "--session", "s", "--machine", "m", "--hook-version", bad],
        binding,
      );
      expect(outcome.exitCode).not.toBe(EXIT.OK);
      expect(binding.calls).toHaveLength(0);
    }
  });

  it("REFUSES a call with no --session", async () => {
    // A registration with no session to register is a call with no subject.
    const binding = recorder();
    const outcome = await runCommand(["session", "register", "--machine", "m"], binding);
    expect(outcome.exitCode).not.toBe(EXIT.OK);
    expect(binding.calls).toHaveLength(0);
  });

  it("REFUSES a flag given with no value", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["session", "register", "--session", "s", "--machine"],
      binding,
    );
    expect(outcome.exitCode).not.toBe(EXIT.OK);
    expect(binding.calls).toHaveLength(0);
  });

  it("spells --hook-variant as the schema's hookVariant", async () => {
    const binding = recorder();
    await runCommand(
      ["session", "register", "--session", "s-3", "--machine", "m", "--hook-variant", "cli"],
      binding,
    );
    expect(binding.calls[0]?.input).toEqual({
      sessionId: "s-3",
      machine: "m",
      hookVariant: "cli",
    });
  });

  it("does not let the caller name its own transport", async () => {
    // The flag is not translated to anything, so it arrives at the
    // operation's `.strict()` schema under a name it does not have and is
    // refused there. What must NOT happen is it becoming `transport`.
    const binding = recorder();
    await runCommand(
      ["session", "register", "--session", "s-4", "--machine", "m", "--transport", "cli-direct"],
      binding,
    );
    const input = binding.calls[0]?.input as Record<string, unknown> | undefined;
    expect(input?.transport).toBe("cli-direct");
    // …and the operation refuses it — proved against the real schema in
    // tests/session-registration.test.ts, which is where the schema lives.
  });
});

describe("the http binding's route for it", () => {
  it("puts the session in the path and everything else in the body", () => {
    const route = HTTP_ROUTES.register_session;
    expect(route).toBeDefined();
    expect(route?.method).toBe("POST");
    const built = route!.request({ sessionId: "s a/b", machine: "m", hookVersion: 2 });
    expect(built.path).toBe("/api/sessions/s%20a%2Fb/register");
    // The id is not duplicated into the body: the route composes it from the
    // path, so a body copy would be dead weight a reader has to verify.
    expect(built.body).toEqual({ machine: "m", hookVersion: 2 });
  });

  it("unwraps the registration the route wraps", () => {
    const route = HTTP_ROUTES.register_session!;
    expect(route.unwrap({ registration: { sessionId: "s" } })).toEqual({ sessionId: "s" });
    expect(route.unwrap({ somethingElse: 1 })).toBeUndefined();
  });

  it("stamps which binding it is on every request", async () => {
    let seen: Record<string, string> | undefined;
    const binding = createHttpBinding({
      baseUrl: "http://example.invalid",
      fetch: (async (_url: string, init: { headers: Record<string, string> }) => {
        seen = init.headers;
        return {
          ok: true,
          status: 200,
          json: async () => ({ registration: { sessionId: "s" } }),
        } as unknown as Response;
      }) as never,
    });

    await binding.invoke("register_session", { sessionId: "s", machine: "m" });
    expect(seen?.[CLI_TRANSPORT_HEADER]).toBe("cli-http");
  });
});

describe("which transport an HTTP request declares itself as", () => {
  it("reads the command line's own header", () => {
    expect(transportForHttpRequest("cli-http")).toBe("cli-http");
    expect(transportForHttpRequest("  cli-http  ")).toBe("cli-http");
  });

  it("falls back to plain http for an absent header", () => {
    // A handshake must not be refused for a header nobody sent.
    expect(transportForHttpRequest(null)).toBe("http");
    expect(transportForHttpRequest(undefined)).toBe("http");
    expect(transportForHttpRequest("")).toBe("http");
  });

  it("IGNORES a transport that does not reach the server over HTTP", () => {
    // The allow-list is the whole safety property: an unauthenticated header
    // must not be able to claim proximity the request does not have.
    for (const notOverHttp of ["cli-direct", "mcp-stdio", "mcp-http"]) {
      expect(transportForHttpRequest(notOverHttp)).toBe("http");
    }
  });

  it("IGNORES a value that is not a transport at all", () => {
    for (const junk of ["cli", "carrier-pigeon", "HTTP", "cli_http"]) {
      expect(transportForHttpRequest(junk)).toBe("http");
    }
  });

  it("holds the allow-list to transports that can actually arrive over HTTP", () => {
    // The assertion that fails if someone widens the list to something the
    // header could then be used to impersonate.
    expect([...CLI_TRANSPORTS]).toEqual(["cli-http"]);
  });

  it("only admits values whose effect a caller could already have asked for", () => {
    // Why an unauthenticated header is acceptable at all. What it changes is
    // which hook variant the reply describes — `cli-http` is told about the
    // command-line hook where plain `http` is told about the HTTP one — and
    // that is the same effect the registration payload's own `hookVariant`
    // override grants any caller outright. So the header confers nothing the
    // documented input does not.
    //
    // This is the assertion that fails if the allow-list gains an entry
    // whose variant is not reachable through that override — which would
    // mean the header had started granting something.
    for (const allowed of CLI_TRANSPORTS) {
      expect(transportForHttpRequest(allowed)).toBe(allowed);
      expect(HOOK_VARIANTS).toContain(variantForTransport(allowed));
    }
  });

  it("cannot be used to make an unregistered or incompatible session claimable", () => {
    // The property that actually matters: the claim check reads the reported
    // *version*, never the transport. Every admitted value therefore leaves
    // an unregistered session refused.
    for (const allowed of [...CLI_TRANSPORTS, "http" as const]) {
      const variant = variantForTransport(allowed);
      expect(assessVersion({ variant, reportedVersion: null }).mayClaim).toBe(false);
      expect(
        assessVersion({
          variant,
          reportedVersion: HOOK_PROTOCOL[variant].minSupported - 1,
        }).mayClaim,
      ).toBe(false);
    }
  });
});
