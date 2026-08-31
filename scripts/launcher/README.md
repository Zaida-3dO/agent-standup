# The launcher

Two PowerShell files and a registration script. Together they are the whole
of what runs on a machine: a scheduled task fires the launcher, the launcher
hands over to the poller, the poller asks the server what to start and starts
it.

| File                | What it is                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `launcher.ps1`      | The frozen half. Logs a `TICK`, parse-checks the poller, invokes it. Holds no logic and talks to no server. | <!-- external-ref-ok: this repository's own launcher script, named in the table of files in this directory --> |
| `poll.ps1`          | The poller. Asks the server, starts what comes back, logs the outcome. Makes no decisions.                  | <!-- external-ref-ok: this repository's own poller script, named in the same table -->                         |
| `register-task.ps1` | Run once per machine to register the scheduled task. Idempotent.                                            | <!-- external-ref-ok: this repository's own registration script, named in the same table -->                   |

## Why it is split in two

A scheduled task is registered once and then forgotten, so anything in the
frozen half is a line that may one day need every installation updated. It is
kept to the smallest thing that answers the question a log has to answer:
**did this fire at all?**

That is also why the `TICK` line is written before anything that could throw.
A dead scheduled task produces silence in the log; a healthy but idle one
produces a `TICK` and then `NOTHING-TO-DO`. Without the unconditional line
first, those two states look identical from the log — and they call for
completely different responses.

The parse-check is the same argument one level down. A syntax error in the
poller would otherwise produce no output at all, which reads exactly like a
quiet tick with nothing to do.

## Every decision is made server-side

The poller does not choose what to work on, compose a prompt, check budget or
headroom, order anything, decide whether a launch failed, or retry. Each of
those is a decision, and each is made by the server, which can see item state,
claim state, review artifacts and budget — none of which a script on a machine
can see.

**If this script grows a rule, the rule is in the wrong place.** The length is
a symptom of that, not a target: it is short because there is nothing left for
it to decide.

## Configuration

Three environment variables, in the environment the scheduled task runs under.
No path, machine name or URL is written into any file here — each would be
true on exactly one machine, and these scripts are meant to be identical on
all of them.

| Variable          | What it is                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `STANDUP_URL`     | Where the server answers.                                                                                         |
| `STANDUP_TOKEN`   | This machine's bearer token. Never a command-line flag — an argument lands in shell history and the process list. |
| `STANDUP_MACHINE` | Which machine this is, matching a row the server knows.                                                           |

With any of them unset, every tick logs `CONFIG-MISSING` naming which — rather
than failing in a way that has to be traced back to a missing variable.

## Log lines

| Line             | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `TICK`           | The task fired. Always first.                                                    |
| `PARSE-FAILED`   | The poller has a syntax error and was not run.                                   |
| `CONFIG-MISSING` | One or more variables are unset, and which.                                      |
| `POLL-FAILED`    | The server could not be reached. An ordinary outcome — the next tick asks again. |
| `NOTHING-TO-DO`  | The server had nothing to start.                                                 |
| `LAUNCHED`       | A dispatch was started, with its id.                                             |
| `LAUNCH-FAILED`  | One dispatch could not be started. The rest are still attempted.                 |

## The response this expects

`poll.ps1` reads a response shaped like this: <!-- external-ref-ok: this repository's own poller script, whose expected response this documents -->

```json
{
  "dispatches": [
    {
      "dispatchId": "…",
      "command": "…",
      "args": ["…"],
      "prompt": "…"
    }
  ]
}
```

`prompt` is passed on standard input rather than as an argument: an argument
lands in the process list, and a composed prompt can be long enough to hit a
command-line length limit.

> **This shape is an assumption, and it is the one thing here most likely to
> need a small change.** The poll endpoint and the composition of the prompt
> are separate pieces of work, in flight at the same time as this. The
> contract this file depends on is only: a JSON body with a `dispatches`
> array, each entry carrying an id, something to execute, its arguments, and
> a prompt to feed it. If the endpoint settles on different field names, this
> is a one-line change in `poll.ps1` and nothing else here moves. <!-- external-ref-ok: this repository's own poller script, named as the file a contract change would touch -->

## Registering it

Run `register-task.ps1` from this directory, in a PowerShell session logged in as the user the work should run as. <!-- external-ref-ok: this repository's own registration script, named as the command to run -->

Registers with `LogonType Interactive` and `RunLevel Limited`: the task keeps
firing while the machine is locked, needs no elevation and stores no
credential. It stops firing once nobody is logged on, which is accepted — a
machine nobody is logged into is a machine with nothing to launch onto.

The tempting alternative, "run whether user is logged on or not", is a
different tool rather than a sturdier setting: it runs in Session 0, which has
no desktop or window station, so anything needing a real window fails there —
usually as a hang rather than a clean error — and it costs a stored credential
for a capability this does not need.
