<#
.SYNOPSIS
    The frozen half of the launcher. Proves the scheduled task fired, then
    hands over to the poller.

.DESCRIPTION
    This file exists to change as rarely as possible. A scheduled task is
    registered on a machine once and then forgotten, so every line here is
    a line that may one day need every installation to be updated -- the
    same argument the hook script is kept thin by. It therefore holds no
    logic about what to launch, talks to no server, and makes no decision.

    Three steps, in this order:

      1. Append an unconditional TICK line, before anything that could
         throw. A dead scheduled task produces silence; a healthy but idle
         one produces a TICK every fire. Without this line first, those two
         states are indistinguishable from the log alone -- which is the
         entire reason this file is separate from the poller rather than
         being the poller.
      2. Parse-check the poller without running it. A syntax error must
         appear as its own line (PARSE-FAILED), never as a silent no-op
         that reads exactly like "nothing to do this tick".
      3. Only on a clean parse, invoke it.

    Paths are parameters with repository-relative defaults; nothing here
    hard-codes a location on any machine.

.PARAMETER LogPath
    Where to append. The directory is created if missing. Defaults to a
    log file beside this script.

.PARAMETER PollerScript
    The script to parse-check and invoke. Defaults to the poller next to
    this file.
#>
param(
    [string]$LogPath = (Join-Path $PSScriptRoot "launcher.log"),

    # external-ref-ok-next-line: this repository's own poller script, resolved next to this one
    [string]$PollerScript = (Join-Path $PSScriptRoot "poll.ps1")
)

function Write-LauncherLine {
    param([string]$Message)
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message
    $logDir = Split-Path -Parent $LogPath
    if ($logDir -and -not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }
    Add-Content -Path $LogPath -Value $line
}

# Step 1 -- unconditional, first, before anything that could throw.
Write-LauncherLine "TICK"

# Step 2 -- parse without executing.
try {
    $source = Get-Content -Raw -Path $PollerScript -ErrorAction Stop
    [ScriptBlock]::Create($source) | Out-Null
} catch {
    Write-LauncherLine "PARSE-FAILED $PollerScript`: $($_.Exception.Message)"
    return
}

# Step 3 -- only reached on a clean parse.
& $PollerScript -LogPath $LogPath
