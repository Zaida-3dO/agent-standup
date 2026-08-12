<#
.SYNOPSIS
    Spike artefact. Registers the scheduled task the test protocol runs
    against. Not executed by this repository or by any automated check --
    a human runs this by hand, per TEST-PROTOCOL.md.

.DESCRIPTION
    Registers this directory's launcher script with:

      - LogonType Interactive: attaches to the caller's existing logon
        session rather than starting a fresh one. This is what fires while
        the machine is locked and does not fire once nobody is logged on.
      - RunLevel Limited: no elevation, no stored credential. Sufficient
        because nothing this spike launches needs admin rights -- Highest
        would only be justified if the launched process itself did (e.g.
        binding a privileged listener), which is not the case here.

    Deliberately NOT the "run whether user is logged on or not" alternative
    (LogonType Password, or an S4U credential) -- that variant runs in
    Session 0, which has had no desktop or window-station access since
    Vista's Session 0 isolation. It sounds more robust because it survives
    a full logoff, but it cannot open a window at all, so it is the wrong
    tool for anything that needs a real desktop, not a safer version of
    this one. See SPIKE.md for the full comparison.

.PARAMETER TaskName
    Name to register the task under.

.PARAMETER IntervalMinutes
    Repetition interval. TEST-PROTOCOL.md uses the default (~2 minutes) so
    a few fire cycles fit inside a short observation window.

.PARAMETER LogPath
    Log file the launcher and probe scripts append to. Defaults to a
    `spike.log` file next to this script.
#>
param(
    [string]$TaskName = "AgentStandupSpike-UnattendedLaunch",
    [int]$IntervalMinutes = 2,
    [string]$LogPath = (Join-Path $PSScriptRoot "spike.log")
)

# external-ref-ok-next-line: this repository's own launcher script, resolved next to this one
$launcherPath = Join-Path $PSScriptRoot "launcher.ps1"
if (-not (Test-Path $launcherPath)) {
    # external-ref-ok-next-line: this repository's own launcher script, named in the error it raises
    throw "launcher.ps1 not found next to this script at $launcherPath"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -LogPath `"$LogPath`""

$trigger = New-ScheduledTaskTrigger `
    -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# The mechanism this whole spike is about: attach to the existing
# interactive logon, no elevation, no stored credential.
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "agent-standup spike (#55): unattended-launch test protocol. Safe to unregister at any time -- see TEST-PROTOCOL.md."

Write-Output "Registered '$TaskName'. Logging to $LogPath every $IntervalMinutes minute(s)."
Write-Output "To remove it afterwards: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
