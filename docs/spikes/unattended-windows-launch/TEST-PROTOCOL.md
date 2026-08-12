# Test protocol: unattended launch through a lock and through display sleep

A human step. Nothing in this repository registers the scheduled task or locks the machine — see
`SPIKE.md` for why, and for what's already settled versus what this protocol exists to check.

Two risks, kept deliberately separate throughout: **lock** (the input desktop switches to Winlogon's
secure desktop) and **display sleep** (a power event — the monitor and/or GPU go to a low-power
state). They are not the same event, they do not happen on the same schedule, and a screenshot that
succeeds right after lock says nothing about whether one still succeeds after display sleep too.

## 0. Before you start

1. **Note the machine's display-sleep timeout.** Settings → System → Power & sleep → "Screen" while
   plugged in (and while on battery, if relevant). Write the number down — step 5 depends on it.
2. **Node.js** must already be on `PATH` (`node --version`) — this repository already requires it.
3. **One-time Playwright setup**, from this directory:

   ```powershell
   cd docs\spikes\unattended-windows-launch
   npm install --prefix . --no-save --no-package-lock playwright
   npx playwright install chromium
   ```

   **`--prefix .` is load-bearing, not optional.** This folder has no `package.json` of its own, so
   without `--prefix .` npm walks _up_ to the repository root and installs there instead —
   `--no-package-lock` then disables lockfile-pinned resolution for that install **tree-wide**,
   silently drifting the repository's real `node_modules/` away from what `package-lock.json`
   describes. `git status` does not catch this: `--no-package-lock` also means `package-lock.json`
   itself is never rewritten, so nothing shows as modified even though the actually-installed
   `node_modules/` tree can quietly diverge from it — invisible to git, because `node_modules/` is
   itself git-ignored. `--prefix .` genuinely isolates the install to a local `node_modules/`
   inside this folder only — confirmed directly: run it, then check that
   `docs\spikes\unattended-windows-launch\node_modules\playwright` exists and that
   `node_modules\playwright` at the repository root does **not**. It does not touch this repository's
   own `package.json` or `package-lock.json`, and the local `node_modules/` it creates is git-ignored
   (the repository-wide `node_modules/` rule in `.gitignore` already covers any depth, so nothing
   extra was needed there).

   **If you already ran this command without `--prefix .`** — check whether
   `node_modules\playwright` exists at the repository root (not `git status`, per the paragraph
   above — it won't show anything). If it does, restore the root install with `npm ci` from the
   repository root before doing anything else. `npm ci` reinstalls strictly from
   `package-lock.json`, discarding whatever the stray install left behind.

## 1. Baseline — before locking anything

Run the launcher once, by hand, logged in and unlocked:

`powershell -NoProfile -ExecutionPolicy Bypass -File .\launcher.ps1 -LogPath .\spike.log` <!-- external-ref-ok: this repository's own launcher script, the command a reader runs directly -->

Open `spike.log` and confirm four lines: `TICK`, `PARSE-OK`, `INVOKING`, and then the probe script's
own two lines, `CONSOLE-CHECK OK` and `SCREENSHOT-CHECK OK: <path> (<ms>)`. Open the screenshot at
`<path>` and confirm it actually shows the page (not a blank or corrupt file). If any of this fails
unlocked, stop — the rest of the protocol only tells you something new once the baseline works.

Delete `spike.log` and the `screenshots\` folder before continuing, so step 6's log is only this run.

## 2. Register the task

`powershell -NoProfile -ExecutionPolicy Bypass -File .\register-task.ps1` <!-- external-ref-ok: this repository's own registration script, the command a reader runs directly -->

Defaults to a 2-minute interval, `LogonType: Interactive`, `RunLevel: Limited`, logging to
`spike.log` next to the scripts. Confirm it registered:

```powershell
Get-ScheduledTask -TaskName AgentStandupSpike-UnattendedLaunch
```

## 3. Lock — not log off, not idle

Press **Win+L**. Confirm the lock screen is actually showing (not just the display timing out, not
just the session left idle unlocked — the lock screen, specifically). Do not sign out.

## 4. Wait through 2–3 fire cycles, still locked

At the default 2-minute interval, that's roughly 4–6 minutes. Don't touch the machine.

## 5. Keep waiting, past display sleep, still locked

Continue waiting until you're past the display-sleep timeout you noted in step 0. If the monitor
visibly goes dark, that's expected and is the point — stay locked, don't wake it on purpose. Let a
couple more fire cycles pass once you're past that timeout, so there's at least one tick from before
display sleep and at least one from after it to compare in step 6.

## 6. Unlock, then read the log

Sign back in and open `spike.log` (and the `screenshots\` folder). Confirm, in order:

1. **Every expected tick fired, with no gap.** Count `TICK` lines against elapsed time ÷ interval —
   a missing tick means the task didn't fire that cycle, which is itself a finding, not just a
   missing data point.
2. **Every tick parse-checked clean.** Every `TICK` should be followed by a `PARSE-OK`, never a
   `PARSE-FAILED`.
3. **Every `CONSOLE-CHECK` reads `OK`.** This channel doesn't touch a window station or a desktop at
   all — if this ever fails, something broke that's more fundamental than the headed-browser
   question below (the logon session itself, the task not attaching, etc.), and that's worth
   reporting on its own.
4. **The `SCREENSHOT-CHECK` lines, split into two groups and compared separately:**
   - The ones from **before** the display-sleep timeout (still locked, display still awake).
   - The ones from **after** it (still locked, display asleep or having been asleep).

   Open the actual PNG for at least one screenshot in each group. `OK` in the log is necessary but
   not sufficient — a corrupt, black, or partially-rendered image with a `0` exit code would still
   log `OK`, so look at the files, not just the log line.

## 7. What a result means

- **All four checks pass in both groups** → the headed-browser risk this spike flagged as open does
  not reproduce on this hardware for this scenario. Still not a guarantee for every machine agent
  standup will run on — different GPU drivers exist — but it closes the question for the one tested.
- **`CONSOLE-CHECK` or ticking itself fails** → the mechanism table's core claim is wrong for this
  machine, which is a bigger finding than the browser question and should be reported first.
- **Screenshots succeed before display sleep but fail (or come back corrupt/black) after it** → this
  is exactly the risk `SPIKE.md` named: display sleep, not lock, is what breaks it. That's the
  scenario headless is the mitigation for.
- **Screenshots fail even before display sleep, immediately after lock** → a stronger result than
  expected; worth its own report, since it would mean the risk is lock itself, not just the
  display-sleep/GPU-wake interaction this spike singled out.

## 8. Clean up

```powershell
Unregister-ScheduledTask -TaskName AgentStandupSpike-UnattendedLaunch -Confirm:$false
```

This is a spike task, not meant to persist. Leave `spike.log` and the screenshots in place (or copy
them out) until you've reported the result — both are git-ignored, so they won't show up as changes
to commit.

**Also remove the local Playwright install from step 0**, since it's a throwaway spike dependency,
not something this folder should keep around indefinitely:

```powershell
Remove-Item -Recurse -Force docs\spikes\unattended-windows-launch\node_modules
```

Safe regardless of which form of the install command was used, because it only ever removes the
`node_modules/` directory inside this spike folder. If step 0's restore check found a stray install
at the repository root and you already ran `npm ci` there, there is nothing further to undo — `npm ci`
is the complete recovery for that side.
