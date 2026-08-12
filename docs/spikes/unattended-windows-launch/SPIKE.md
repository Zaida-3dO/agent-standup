# Spike: launching a session unattended on Windows, locked and logged in

Row #55. This spike settles the mechanism and writes down what still needs a human to actually
verify — it does not implement the production launcher (that's #61, gated on this row and on #60).

## What "unattended" means for this product

The heartbeat design (`DECISIONS.md` §5) is a poller, not a listener: each machine runs a scheduled
task that periodically asks the server what to launch and starts whatever comes back. Nothing ever
reaches into the machine from outside — the machine always initiates. "Unattended" therefore means
one thing very specifically: **the poller keeps firing on schedule with nobody at the keyboard**,
while the machine stays logged in. A machine that gets fully logged out stops polling; that is an
accepted limitation, not a bug, because the heartbeat is optional by design.

That framing is also why WinRM and SSH don't belong in the candidate list below at all — they're
mechanisms for something _outside_ the machine to trigger something _on_ it, which doesn't fit a
design where the machine is always the one asking. Whether those ports happen to be open is beside
the point; the shape doesn't match regardless.

## Mechanism table

| Approach                                                                                            | Survives lock?                                                                                                                                                      | Survives full logoff?                           | Desktop / window-station access?                                                                                      | Credential cost                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task Scheduler — `LogonType: Interactive`, `RunLevel: Limited`** (recommended)                    | Yes — attaches to the existing logon session; only the _input_ desktop switches to Winlogon's secure desktop, the logon session and `WinSta0`/`Default` stay intact | No — needs an active logon session to attach to | Yes                                                                                                                   | None — no elevation, no stored credential                                                                                                                                                      |
| Task Scheduler — `LogonType: Interactive`, `RunLevel: Highest`                                      | Yes (same mechanism)                                                                                                                                                | No                                              | Yes                                                                                                                   | None stored, but needs a one-time admin consent at registration. Only worth it if the launched process itself needs elevation (e.g. binding a privileged listener) — not the case here         |
| Task Scheduler — "run whether user is logged on or not" (`LogonType: Password` / an S4U credential) | Yes                                                                                                                                                                 | Yes                                             | **No** — Session 0 isolation since Vista: no desktop, no window station for anything that needs to open a real window | Requires a stored password or a machine-account handshake — a materially larger secret surface than the recommended option, for a capability (surviving full logoff) this product doesn't need |
| Windows Service                                                                                     | Yes                                                                                                                                                                 | Yes                                             | No — services run in Session 0, same isolation problem as above                                                       | Runs under a service account, no interactive credential, but installing the service itself needs admin                                                                                         |
| Startup folder / registry `Run` key                                                                 | N/A — only fires once, at the next logon                                                                                                                            | No — needs a fresh logon to fire at all         | Yes                                                                                                                   | None, but no retry, no timeout, and no idempotent-registration story: it fires once per logon, not on an interval                                                                              |
| WinRM / SSH (remote trigger)                                                                        | N/A                                                                                                                                                                 | N/A                                             | N/A                                                                                                                   | Not applicable — the product is pull-only (see above). A remote-trigger mechanism doesn't fit the architecture, independent of whether the ports are reachable                                 |

## The Session 0 trap

"Run whether user is logged on or not" is the instinctive choice — it _sounds_ like the more robust
setting, because it keeps working after a full logoff. That framing is exactly backwards for this
product. It is a different tool, not a safer variant of the interactive option: it runs in **Session
0**, which has had no desktop or window-station access since Session 0 isolation shipped. Anything
that needs to open a real window — including a headed browser — fails there, and it typically fails
as a hang or a silent no-op, not a clean, loggable crash. Reaching for "logged on or not" because it
sounds safer is the trap; the machines this dispatches to stay logged in, so the interactive option's
one real limitation (needs an active logon session) is one this product already designs around.

## Recommendation

**Task Scheduler, `LogonType: Interactive`, `RunLevel: Limited`.** Lowest secret surface of every
option that actually fits the architecture, and it is what the production launcher (#61) should
register.

**Shape: a frozen launcher plus real logic, in two files.** A tiny, rarely-touched launcher logs an
unconditional tick line on every fire — before anything else runs — so a dead scheduled task is
distinguishable in the log from a healthy-but-idle one. It then parse-checks the real script before
invoking it, so a syntax error in the real logic shows up as its own log line rather than as a silent
no-op indistinguishable from "nothing to do this tick." The launcher/probe pair below (see "Files in
this directory") implements that shape; the registration script wires it in with the principal
described above. This is a spike proving the shape, not the production script — #61 is where that
shape gets built out for real.

**Headless is the mitigation for anything that must be reliable unattended.** A pure console process
never touches a window station, a desktop, or a GPU-composited surface, so it sidesteps both the lock
question and the display-sleep question entirely. Where a real browser is genuinely needed
unattended, running it headless removes the one part of this spike that is still open.

## What is settled, and what is not

**Settled, by production precedent — not by a test run against this repository.** The scheduling
mechanism above (locked vs. logged-out behaviour, `RunLevel: Limited` sufficing, the Session 0 trap)
reflects how Windows session/desktop isolation is documented to behave and how it is reported to
behave in shipped tools that rely on it. Nobody has registered this task and locked this machine to
confirm it.

**Genuinely open: whether a _headed_ browser survives a real lock-and-display-sleep cycle.** Display
sleep is a separate power event from lock, and GPU-driver/DXGI swapchain recovery for a long-running,
GPU-accelerated process on wake is a documented rough edge, not a guarantee. Chromium's GPU process
usually recreates its device and recovers — "usually recovers" is a claim about behaviour observed
elsewhere, not a claim verified here. The probe script's `SCREENSHOT-CHECK` exists specifically to
close that gap; the test protocol in this directory is the human step that runs it for real.

## Files in this directory

Every filename below is this repository's own spike artefact, listed here so a reader of this
directory knows what each one is for.

- `launcher.ps1` — the frozen launcher (tick, parse-check, invoke). <!-- external-ref-ok: this repository's own launcher script, named in this list -->
- `probe.ps1` — the real logic: `CONSOLE-CHECK` (pure console spawn) and `SCREENSHOT-CHECK` (headed screenshot via `screenshot.mjs`). <!-- external-ref-ok: this repository's own probe script, named in this list -->
- `screenshot.mjs` — headed Chromium screenshot, via Playwright's Node API. Not wired into this
  repository's own dependency tree or CI — see `TEST-PROTOCOL.md` for the one-time setup it needs.
- `register-task.ps1` — registers the scheduled task with `LogonType: Interactive` and `RunLevel: Limited`. Not executed by this repository or by any automated check. <!-- external-ref-ok: this repository's own registration script, named in this list -->
- `TEST-PROTOCOL.md` — the written protocol for the human step: lock the machine, wait through
  several fire cycles and past display-sleep, read the log.
