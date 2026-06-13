# K Scan — Runtime Diagnostic Command Pack (Windows host) — v2 (safety-corrected)

Run from **Windows PowerShell** in `C:\Users\jsmit\KScan`. Read-only/diagnostic only. Artifacts save into `qa\runtime-audit\` (mounted into Cowork), so after each block Cowork reads them back and appends runtime findings to `STATIC_AUDIT_REPORT.md`.

**Rules:** no source edits, no commit/push/build/deploy, no destructive confirmations, no data/user deletion, no second account-deletion request. On any destructive dialog (Delete Room/Account, Remove Item, Revoke/Disable Share, Delete chat): tap **Cancel/Back** only. The human enters any QA password locally — it is never typed into these commands or printed.

**Do NOT clear app data** (`pm clear`). Because state is not reset:
- First-run permission/auth/onboarding screens may not appear. If so, capture the current state and mark those items **"requires fresh-install validation."**
- If camera permission was already granted, `02_camera_permission` may show no prompt — that is acceptable; note it in runtime findings.

## Setup block (run once, first PowerShell window)
```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$pkg = "com.kscanai.app"
$out = "C:\Users\jsmit\KScan\qa\runtime-audit"
New-Item -ItemType Directory -Force -Path $out | Out-Null

function Shot($n) {
  & $adb shell screencap -p "/sdcard/$n.png" | Out-Null
  & $adb pull "/sdcard/$n.png" "$out\$n.png" | Out-Null
  Write-Host "saved $n.png"
}
function Dump($n) {
  & $adb shell uiautomator dump /sdcard/u.xml | Out-Null
  & $adb pull /sdcard/u.xml "$out\$n.xml" | Out-Null
  Write-Host "saved $n.xml"
}
function LaunchApp {
  & $adb shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 | Out-Null
}
```

## Logs (second PowerShell window — leave running the whole pass)
```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$out = "C:\Users\jsmit\KScan\qa\runtime-audit"
New-Item -ItemType Directory -Force -Path $out | Out-Null
& $adb logcat -c
& $adb logcat "*:W" "ReactNativeJS:V" "ReactNative:W" "AndroidRuntime:E" | Tee-Object "$out\logcat_session.txt"
# watch for: redbox, "Unhandled", AndroidRuntime FATAL, repeated network failures, raw backend strings
```

## Baseline (run once)
```powershell
git branch --show-current; git status --short | Select-Object -First 20
& $adb devices
& $adb shell getprop ro.product.model; & $adb shell getprop ro.build.version.release
& $adb shell wm size; & $adb shell wm density
& $adb shell dumpsys window | Select-String "mCurrentFocus"
```

---

## Priority 1 — Core scan + cold backend  *(C1, P1-6, P1-10)*
```powershell
& $adb shell am force-stop $pkg
Start-Sleep 2
LaunchApp
Start-Sleep 5
Shot "01_launch"
Dump "01_launch"
# First-run camera permission prompt — capture BEFORE accepting:
Shot "02_camera_permission"
# Grant, then land on camera/home:
Start-Sleep 2
Shot "03_home_or_camera"
```
Then, **manually with a stopwatch**, do the FIRST scan (cold-backend test):
1. Tap the capture button → preview.
2. Tap **Analyze Style**. Start timing. A few seconds in: `Shot "04_scan_processing"`.
3. Note when result/error appears; write seconds into `notes.txt`.
4. `Shot "05_scan_result"` — capture category/color/silhouette + product shelf.
5. Second (warm) scan immediately: `Shot "06_scan_result_warm"`, record seconds.
6. Non-fashion control (QA fixture or a gallery image; the emulator camera scene is not valid for fashion): `Shot "07_non_fashion"`.

**`notes.txt`:** first-scan seconds, warm-scan seconds, did first scan error?, is a double loading treatment (panel + HUD) visible in `04`?

## Priority 2 — Dressing Rooms + share  *(P1-3, share/revoke)*
```powershell
Shot "10_rooms_list"
# Tap New Dressing Room, type a title:
Shot "11_room_create_keyboard"
# Save, open the room:
Shot "12_room_detail"
# Add the scan to the room, then:
Shot "13_room_with_item"
# Tap Share -> native share sheet (confirm relevant apps + complete, non-truncated link):
Shot "14_share_sheet"
# Back out. Tap Revoke/Disable link -> CONFIRM DIALOG: screenshot, then tap CANCEL:
Shot "15_revoke_confirm"
# Note persistence: edit room note, go back to rooms list, reopen:
Shot "16_room_note_persist"
```

## Priority 3 — StyleChat  *(C2 keyboard, error/empty)*
```powershell
Shot "20_stylechat_empty"
# Tap input, type a message — capture WHILE keyboard is open (does it cover input/send?):
Shot "21_stylechat_keyboard"
# Send -> thinking state:
Shot "22_stylechat_thinking"
Shot "23_stylechat_reply"
```
Optional error-state capture (network toggle) — **skip if it destabilizes the session**:
```powershell
# & $adb shell svc wifi disable; & $adb shell svc data disable
# Shot "24_stylechat_error"
# & $adb shell svc wifi enable;  & $adb shell svc data enable
```
```powershell
# Delete conversation -> CONFIRM DIALOG: screenshot, then tap CANCEL:
Shot "25_chat_delete_confirm"
```

## Priority 4 — Auth + OAuth round-trip  *(C2, C4, session restore)*
> Sign in with the QA account **demo@kscan.app**. The human types the password locally — do not put it in any command or file.
```powershell
# Sign out if needed (Home -> Log Out). On the auth screen:
Shot "30_auth_signin"
# Tap email field — capture keyboard type (should be email keyboard); password masked:
Shot "31_auth_keyboard"
# After the human completes email sign-in -> landed home:
Shot "32_auth_signed_in"
# Google OAuth: tap Continue with Google -> custom tab:
Shot "33_oauth_customtab"
# Complete or Cancel; confirm the app returns (authenticated, or graceful cancel):
Shot "34_oauth_return"
# Session restore: force-stop + relaunch while signed in:
& $adb shell am force-stop $pkg
Start-Sleep 2
LaunchApp
Start-Sleep 5
Shot "35_session_restore"
```

## Priority 5 — Privacy + safe-area/contrast  *(P1-1/2/5, C3, deletion = Cancel only)*
```powershell
Shot "40_privacy_top"          # jargon copy + sync chip + muted/gold label contrast
Shot "41_privacy_actions"      # export/correction/delete buttons + "Edge Function" hint text
# Tap Delete Account -> CONFIRM MODAL (30-day copy): screenshot, then tap CANCEL (never Delete):
Shot "42_deletion_confirm"
# Safe-area sweep on the tall device:
Shot "43_safearea_home"; Dump "43_safearea_home"
# Compare header top inset vs status bar across 01_launch, 30_auth_signin, 40_privacy_top.
```

---

## After each priority block
Tell Cowork "priority N saved" — Cowork reads `qa\runtime-audit\*.png / *.xml / notes.txt / logcat_session.txt` and appends a **Runtime Findings** section to `STATIC_AUDIT_REPORT.md`, mapping captures to C1–C4 / P1 items and flagging any new P0.

## Emulator-only caveats (flag separately in findings)
- Emulator camera shows a synthetic scene — not valid for fashion-result quality; use QA fixtures or a gallery image. Real camera quality = requires physical device.
- Performance/gestures/jank on emulator ≠ real device.
- OAuth custom-tab behavior can differ from a real device / Play install.
- Network-toggle error capture (Priority 3) is optional; skip if it destabilizes the run and note "not tested."
