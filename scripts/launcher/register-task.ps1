<#
.SYNOPSIS
    Registers the scheduled task that runs the launcher. Run once per
    machine, by hand.

.DESCRIPTION
    Registers with LogonType Interactive and RunLevel Limited, which the
    unattended-launch spike settled as the right principal:

      - Interactive attaches to the existing logon session, so the task
        keeps firing while the machine is locked. It does not fire once
        nobody is logged on, which is an accepted limitation rather than a
        defect: this whole mechanism is optional, and a machine nobody is
        logged into is a machine with nothing to launch onto.

      - Limited means no elevation and no stored credential. The
        alternative worth naming is "run whether user is logged on or not"
        (a stored password, or an S4U handshake). It sounds like the more
        robust setting because it survives a full logoff, and it is
        actually a different tool: it runs in Session 0, which has had no
        desktop or window station since Session 0 isolation. Anything that
        needs to open a real window fails there, and typically fails as a
        hang rather than a clean error. It also costs a materially larger
        secret surface for a capability this does not need.

    Idempotent: re-running leaves exactly one registration, updated to
    whatever was passed, so it is safe to run again after changing an
    interval.

.PARAMETER TaskName
    Name to register under. Defaults to a name describing what it does.

.PARAMETER IntervalMinutes
    How often to poll.

.PARAMETER LogPath
    Log file both halves append to. Defaults to a file beside the scripts.
#>
param(
    [string]$TaskName = "AgentStandupLauncher",
    [int]$IntervalMinutes = 10,
    [string]$LogPath = (Join-Path $PSScriptRoot "launcher.log")
)

# external-ref-ok-next-line: this repository's own launcher script, resolved next to this one
$launcherPath = Join-Path $PSScriptRoot "launcher.ps1"
if (-not (Test-Path $launcherPath)) {
    # external-ref-ok-next-line: this repository's own launcher script, named in the error it raises
    throw "launcher.ps1 was not found next to this script at $launcherPath"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -LogPath `"$LogPath`""

$trigger = New-ScheduledTaskTrigger `
    -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# The mechanism the spike settled on: attach to the existing interactive
# logon, no elevation, no stored credential.
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

# StartWhenAvailable catches up a tick missed while the machine was asleep;
# without it a laptop that was closed over a poll simply skips it.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

Write-Host "Registered '$TaskName', polling every $IntervalMinutes minute(s)."
Write-Host "Logging to $LogPath"
Write-Host ""
Write-Host "This machine still needs STANDUP_URL, STANDUP_TOKEN and STANDUP_MACHINE"
Write-Host "in the environment the task runs under, or every tick will log CONFIG-MISSING."
