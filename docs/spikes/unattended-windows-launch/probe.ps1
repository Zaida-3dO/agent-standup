<#
.SYNOPSIS
    Spike artefact. The "real logic" half of the two-stage launcher shape --
    only reached after the launcher has logged a TICK and parse-checked
    this file. Runs two independent checks per invocation and logs each
    result on its own line, so the two questions this spike exists to
    answer stay distinguishable from each other in the log.

.DESCRIPTION
    CONSOLE-CHECK
        Spawns a separate console-only process and reads its output back.
        Never touches a window station or a desktop, so per the findings
        this is the one channel expected to keep working through a lock
        and through display sleep -- a failure here means something more
        fundamental broke (the logon session itself, the task not
        attaching, etc.), not the headed-browser question below.

    SCREENSHOT-CHECK
        The genuinely unproven half. Launches a *headed* (non-headless)
        Chromium via Playwright's own Node API and screenshots a static
        page. Needs the `playwright` package resolvable -- this repository
        does not install it by default; see TEST-PROTOCOL.md for the
        one-time setup. If `screenshot.mjs` or `node` cannot be found, or
        the Playwright package has not been installed, this check logs
        SCREENSHOT-CHECK FAILED with the reason -- it does not throw and
        does not stop CONSOLE-CHECK from having already run.

.PARAMETER LogPath
    Where to append log lines (shared with the launcher's log).
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath
)

function Write-SpikeLogLine {
    param([string]$Message)
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message
    Add-Content -Path $LogPath -Value $line
}

# --- CONSOLE-CHECK ---------------------------------------------------------
# A pure console spawn: no GUI subsystem involved at all.
try {
    $marker = "console-check-ok:" + (Get-Date -Format o)
    $output = & powershell.exe -NoProfile -NonInteractive -Command "Write-Output '$marker'"
    if ($LASTEXITCODE -eq 0 -and $output -eq $marker) {
        Write-SpikeLogLine "CONSOLE-CHECK OK"
    } else {
        Write-SpikeLogLine "CONSOLE-CHECK FAILED: exit=$LASTEXITCODE output='$output'"
    }
} catch {
    Write-SpikeLogLine "CONSOLE-CHECK FAILED: $($_.Exception.Message)"
}

# --- SCREENSHOT-CHECK -------------------------------------------------------
# Headed Chromium through Playwright. This is the check the test protocol
# is built around: run it immediately after locking, and again after the
# machine's display-sleep timeout has passed, and compare.
try {
    $scriptDir = $PSScriptRoot
    $shotDir = Join-Path $scriptDir "screenshots"
    $nodeScript = Join-Path $scriptDir "screenshot.mjs"

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-SpikeLogLine "SCREENSHOT-CHECK FAILED: node not found on PATH"
    } elseif (-not (Test-Path $nodeScript)) {
        # external-ref-ok-next-line: this repository's own sibling scripts, named for a diagnostic message
        Write-SpikeLogLine "SCREENSHOT-CHECK FAILED: screenshot.mjs not found next to probe.ps1"
    } else {
        # stdout and stderr captured to separate files rather than merged
        # with 2>&1: PowerShell wraps a native process's stderr lines as
        # ErrorRecord objects interleaved into the *same* output collection
        # 2>&1 produces, so "the last line" of a merged stream is not
        # reliably the path screenshot.mjs printed -- a stray stderr line
        # emitted after that print would silently become "the last line"
        # instead. Keeping the streams apart makes $stdoutLines contain
        # nothing but real stdout, so parsing the path out of it is
        # unambiguous.
        $stdoutFile = [System.IO.Path]::GetTempFileName()
        $stderrFile = [System.IO.Path]::GetTempFileName()
        try {
            $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            & node $nodeScript $shotDir 1>$stdoutFile 2>$stderrFile
            $exitCode = $LASTEXITCODE
            $stopwatch.Stop()
            $stdoutLines = @(Get-Content -Path $stdoutFile -ErrorAction SilentlyContinue)
            $stderrText = Get-Content -Raw -Path $stderrFile -ErrorAction SilentlyContinue
        } finally {
            Remove-Item -Force -ErrorAction SilentlyContinue -Path $stdoutFile, $stderrFile
        }

        $finalPath = $stdoutLines | Select-Object -Last 1
        if ($exitCode -eq 0 -and $finalPath -and (Test-Path $finalPath)) {
            Write-SpikeLogLine "SCREENSHOT-CHECK OK: $finalPath ($($stopwatch.ElapsedMilliseconds)ms)"
        } else {
            Write-SpikeLogLine "SCREENSHOT-CHECK FAILED: exit=$exitCode stdout='$stdoutLines' stderr='$stderrText'"
        }
    }
} catch {
    Write-SpikeLogLine "SCREENSHOT-CHECK FAILED: $($_.Exception.Message)"
}
