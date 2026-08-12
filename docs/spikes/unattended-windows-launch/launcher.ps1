<#
.SYNOPSIS
    Spike artefact. The "frozen" half of the two-stage launcher shape: this
    file should change as rarely as possible, because its only job is to
    prove the scheduled task fired at all, independently of whether
    anything downstream works.

.DESCRIPTION
    Three steps, in this order, deliberately:

      1. Append an unconditional "TICK" line to the log, before anything
         else runs. A dead scheduled task produces silence in the log; a
         healthy-but-idle one produces a TICK every fire. Without this
         line first, those two states are indistinguishable from the log
         alone -- which is the whole reason this file is split from the
         real logic instead of just calling it directly.
      2. Parse-check the target script with
         [ScriptBlock]::Create((Get-Content -Raw $TargetScript)) inside a
         try/catch. A syntax error in the real script must show up as its
         own log line (PARSE-FAILED), never as a silent no-op that looks
         identical to "nothing to do this tick".
      3. Only on a clean parse, invoke the target script and pass it the
         same log path.

    Not wired into a scheduled task by this repository -- see the
    registration script and the test protocol in this same directory for
    how a human registers and exercises this by hand.

.PARAMETER LogPath
    Where to append log lines. Created if it does not exist.

.PARAMETER TargetScript
    The "real logic" script to parse-check and invoke. Defaults to the
    probe script next to this file.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    # external-ref-ok-next-line: this repository's own probe script, the default target for this launcher
    [string]$TargetScript = (Join-Path $PSScriptRoot "probe.ps1")
)

function Write-SpikeLogLine {
    param([string]$Message)
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message
    $logDir = Split-Path -Parent $LogPath
    if ($logDir -and -not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }
    Add-Content -Path $LogPath -Value $line
}

# Step 1 -- unconditional, first, before anything that could throw.
Write-SpikeLogLine "TICK"

# Step 2 -- parse-check without executing.
try {
    $source = Get-Content -Raw -Path $TargetScript -ErrorAction Stop
    [ScriptBlock]::Create($source) | Out-Null
    Write-SpikeLogLine "PARSE-OK $TargetScript"
} catch {
    Write-SpikeLogLine "PARSE-FAILED $TargetScript`: $($_.Exception.Message)"
    return
}

# Step 3 -- only reached on a clean parse.
Write-SpikeLogLine "INVOKING $TargetScript"
& $TargetScript -LogPath $LogPath
