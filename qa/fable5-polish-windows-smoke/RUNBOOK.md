# Fable 5 Polish — Windows Smoke Runbook (2026-06-11)

Pre-verified (sandbox, read-only): branch `polish/audit-followups-fable5`, HEAD `ab84778`,
baseline commits 9091bc1 / 9aa351d / 9410cec / ab84778 all present, worktree content-clean
vs HEAD, `git fsck --no-reflogs` shows only harmless dangling/temp objects (do not clean).
`expo-image-picker ~17.0.11` is declared in package.json + lockfile; missing from node_modules.

## 1. Restore deps (PowerShell, Windows)
```powershell
cd C:\Users\jsmit\KScan
npm ci
git status --short
git diff --stat package.json package-lock.json   # must be empty
Test-Path .\node_modules\expo-image-picker        # must be True
```
STOP if package files changed or npm ci fails.

Note: `git status` may list a handful of modified files that are EOL/stat-cache noise from
the sandbox session (content matches HEAD). `git diff` should show no real hunks. If it shows
only ^M / line-ending churn, ignore — do not commit it.

## 2. Metro
```powershell
git branch --show-current        # polish/audit-followups-fable5
npx expo start --clear
```
Expect: no expo-image-picker plugin resolution error.

## 3. Device (second window)
```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices
& $adb shell pm list packages | findstr com.kscanai.app
& $adb shell dumpsys package com.kscanai.app | Select-String "versionName|versionCode"
& $adb reverse tcp:8081 tcp:8081
& $adb reverse --list
```
Confirm the dev client loads the localhost Metro bundle, not a stale installed bundle.

## 4. Smoke flows (cancel all destructive dialogs; never submit deletion)
1. Cold launch/Home — force-stop, relaunch; no redbox; safe-area/contrast OK.
2. Auth — sign-in loads; **Password Reset and Update Password screens now use gold
   accents (was cyan) and friendly errors** — these are the new ab84778 changes to verify.
   Trigger a reset error (e.g. airplane mode) → expect "We couldn't send the reset link
   right now. Please try again." or network copy; never raw Supabase text.
3. Privacy — no Edge Function/backend copy; deletion modal: tap Cancel only.
4. Dressing Rooms — list/detail opens; destructive dialogs have Cancel; cancel only.
5. StyleChat — opens; input focuses; **delete-failure copy is now friendly (ab84778)**;
   cancel delete dialogs.
6. Scan — camera/gallery entry opens, no crash.

## 5. Logs (redact before sharing)
```powershell
$pkg = "com.kscanai.app"
$appPid = (& $adb shell pidof -s $pkg).Trim()
if ($appPid) {
  & $adb logcat -d |
    Select-String -Pattern "ReactNative|ReactNativeJS|AndroidRuntime|FATAL|Exception|Unhandled|Error" |
    Select-Object -First 80 |
    Out-File .\qa\fable5-polish-windows-smoke\logcat_excerpt.txt
}
```

## 6. Final validation
```powershell
git status --short
git diff --check
npx tsc --noEmit
```
Expected tsc after npm ci: the 5 "Cannot find module" errors clear; the pre-existing
`app/auth/index.tsx(38)` TS2362 arithmetic error may remain — known baseline, not a blocker.

Known non-blockers to ignore:
- `.git\index.lock.stale*`, `.git\_renametest_b`, `.git\objects\**\tmp_obj_*` — sandbox
  leftovers, safe to delete later, not during this task.
- `__tests__/authPrivacy.test.js:295` — stale test asserting old raw-error passthrough.
- `app/_layout.tsx:81` — cyan ActivityIndicator, flagged for a future polish pass.
