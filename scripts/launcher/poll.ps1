<#
.SYNOPSIS
    The poller. Asks the server what to start, starts it, logs what
    happened. Makes no decisions of its own.

.DESCRIPTION
    The milestone this belongs to is finished when "each machine runs
    nothing but a ~30-line poller on a scheduled task, and every decision
    it acts on was made server-side". That sentence is the specification
    for this file, and the length is a symptom rather than the goal: this
    script is short because there is nothing for it to decide.

    What it does NOT do, deliberately, because each of these is a decision
    and every one of them is already made by the server:

      - It does not choose what to work on. The response says.
      - It does not compose a prompt. The response carries one, composed
        server-side so that every machine launches identically.
      - It does not check budget, headroom, priority or ordering.
      - It does not decide whether a launch failed. A dispatch with no
        matching claim, past its threshold, is a query the server runs.
      - It does not retry. The next tick is the retry, and a tick that
        does nothing costs one request.

    If this file grows a rule, that rule is in the wrong place: it cannot
    see item state, claim state, review artifacts or budget, and it is the
    one component that cannot be updated without touching every machine.

    The machine always initiates -- nothing reaches in from outside. That
    is why the whole mechanism is a poller and not a listener, and it is
    what lets it work through a home connection with no inbound path.

.PARAMETER LogPath
    Where to append. Passed by the launcher so both halves share one file.
#>
param(
    [string]$LogPath = (Join-Path $PSScriptRoot "launcher.log")
)

function Write-PollLine {
    param([string]$Message)
    Add-Content -Path $LogPath -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message)
}

# Configuration comes from the environment, never from this file: a path or
# a machine name written here would be true on exactly one machine, and this
# script is meant to be identical on all of them.
$serverUrl = $env:STANDUP_URL
$token = $env:STANDUP_TOKEN
$machine = $env:STANDUP_MACHINE

if (-not $serverUrl -or -not $token -or -not $machine) {
    # Named individually: "configuration missing" sends the reader to a file
    # to work out which, which this already knows.
    $missing = @()
    if (-not $serverUrl) { $missing += "STANDUP_URL" }
    if (-not $token) { $missing += "STANDUP_TOKEN" }
    if (-not $machine) { $missing += "STANDUP_MACHINE" }
    Write-PollLine ("CONFIG-MISSING " + ($missing -join ", "))
    return
}

try {
    $response = Invoke-RestMethod -Method Post -Uri "$serverUrl/api/poll" `
        -Headers @{ Authorization = "Bearer $token" } `
        -ContentType "application/json" `
        -Body (@{ machine = $machine } | ConvertTo-Json -Compress) `
        -TimeoutSec 30
} catch {
    # An unreachable server is an ordinary outcome, not an incident: the
    # machine may be asleep, the server restarting, the network down. It is
    # logged and the next tick asks again.
    Write-PollLine "POLL-FAILED $($_.Exception.Message)"
    return
}

$dispatches = @($response.dispatches)
if ($dispatches.Count -eq 0) {
    Write-PollLine "NOTHING-TO-DO"
    return
}

foreach ($dispatch in $dispatches) {
    try {
        # The prompt is passed on standard input rather than as an argument:
        # an argument lands in the process list and in shell history, and a
        # composed prompt can be long enough to hit a command-line limit.
        $dispatch.prompt | & $dispatch.command @($dispatch.args)
        Write-PollLine "LAUNCHED $($dispatch.dispatchId)"
    } catch {
        # One failed launch must not stop the others: they are independent
        # pieces of work that happened to arrive in one response.
        Write-PollLine "LAUNCH-FAILED $($dispatch.dispatchId) $($_.Exception.Message)"
    }
}
