# StyleChat Runtime Smoke - 2026-06-13

> ADB/UIAutomator-driven runtime smoke of the committed StyleChat stabilization patch
> (`b7a6cde fix(stylechat): stabilize runtime response and offline UX`) on a connected
> physical Android device, run with explicit owner authorization to drive the device via ADB.
> Tests that could not be automated confidently are marked **OWNER MANUAL CONFIRMATION REQUIRED**,
> not PASS. No code changed, nothing committed, deployed, or built.

## Branch / Commit
- Branch: `feature/purple-gold-electric-theme`
- HEAD: `b7a6cde fix(stylechat): stabilize runtime response and offline UX`
- Patch commit present: **YES** (it is HEAD)
- Test start time: ~22:06 / device clock 10:06 PM (2026-06-13)
- Test duration: ~20 min (device clock 10:06 → 10:26 PM)
- Commits or branch changes during test window: **No commits.** Branch was switched (by owner, from `release/android-1.0.0`) to `feature/purple-gold-electric-theme` *before* this test began; it stayed on `b7a6cde` throughout. No tracked files were modified during testing.

## Test Environment
- Device: Samsung **SM-S936U** (Galaxy S25+), serial `R5CY130589L`
- Android version: **16**
- Navigation mode: **3-button** (system navigationBars inset measured = 135px)
- App run mode: **Expo dev client** (Metro bundler — observed "Bundling…" on a prior cold launch; JS reloads observed as PID changes 28782 → 19384, no crash)
- App package: `com.kscanai.app`
- Edge Function runtime validation: **DEFERRED** — the app calls `supabase.functions.invoke('stylechat-generate')` against the remote `EXPO_PUBLIC_SUPABASE_URL` project (the *deployed* function). Owner confirmed the `b7a6cde` Edge Function is **not deployed**, and deploying is out of scope for this smoke. The deployed function is therefore pre-patch.
- Frontend runtime validation: **TESTED** (app is running the `b7a6cde` JS bundle).
- Notes: The device is also the owner's active phone; multiple third-party apps (FordPass, Walmart, ChatGPT) intermittently stole foreground focus during text entry, breaking several type/send attempts. This is **environmental contention, not a K-Scan defect** — it is the reason some send-dependent tests are owner-manual. FordPass etc. were not modified.

## Terminal Checks
- git branch: `feature/purple-gold-electric-theme` ✓
- git status: clean of tracked changes; only untracked QA artifacts (`qa/v5-release-candidate/`, `qa/v6-runtime-smoke*`, this report + its `screenshots/`) ✓
- TypeScript (`npx tsc --noEmit --pretty false`): **PASS** (exit 0) ✓
- Optional `assembleDebug`: not run (dev-client runtime smoke; owner did not request a fresh native build)

## Results
| Test | Result | Notes |
|---|---|---|
| 1 Launch / authenticated entry | **PASS** | Home reached, authenticated ("Welcome, Justin Smith") → StyleChat session list rendered. No crash, PID stable. |
| 2 Normal prompt | **OWNER MANUAL CONFIRMATION REQUIRED** | Response completeness is an **Edge-Function** behavior; edge is **DEFERRED** (not deployed). Frontend send/render works (proven by Tests 6/7). The *deployed pre-patch* edge produced **truncated** replies in the live thread (see Issues). The patch's completion fix cannot be validated until the function is deployed. |
| 3 Short yes/no prompt | **OWNER MANUAL CONFIRMATION REQUIRED** | Same as Test 2 — Edge DEFERRED. |
| 4 Longer outfit prompt | **OWNER MANUAL CONFIRMATION REQUIRED** | Same as Test 2 — Edge DEFERRED. |
| 5 Rapid-send duplicate protection | **OWNER MANUAL CONFIRMATION REQUIRED** | Automated rapid triple-tap was inconclusive: after the first send clears the input, blind repeat taps landed on the header DELETE control (a native confirm dialog appeared and was safely **cancelled — no deletion**). Send **gating confirmed** (send button `enabled=false` when input empty, `enabled=true` with text); `isSendingRef` in-flight lock present in code. Live duplicate behavior needs manual confirmation. |
| 6 Offline friendly error | **PASS** | Wi-Fi+data disabled (device offline: "Active default network: none"), sent "Can you help me style this?" → thread showed exactly **"Connection lost. Check your internet and try again."** No raw `TypeError`/"Network request failed"/stack trace/provider JSON. A **RETRY** control appeared. |
| 7 Recovery after reconnect | **PASS** | Re-enabled network (ping OK), tapped RETRY → "Connection lost" error cleared, message resent, a fresh assistant reply rendered, no duplicate stale error, no app restart. |
| 8 Android nav composer safe-area | **PASS** | Composer bottom edge at y=**2183**; nav bar inset=**135px** → nav top y=**2205** ⇒ **22px clearance, no overlap**, no excessive chin. In the **pre-patch** build the input bottom sat at y=**2307** (102px *into* the nav region — overlap). Code: `composerBottomPadding = insets.bottom + 8` confirms the fix mechanism. |
| 9 Session persistence / back nav | **PASS** | Left to Home and back; session + prior messages persisted (server-loaded on mount). Back from thread → Home with no crash, no raw session-list error, no restart. |
| 10 V6 visual check | **PASS** (1 note) | Warm pearl/ivory background; no activeVision cyan on the light surface; user (lavender) and assistant (charcoal) bubbles readable; composer input + SEND clearly visible. **Note:** the *enabled* SEND button uses a V6 **gold** accent on the dark composer bar (`rgba(214,179,106,…)`), not aubergine/plum as the test sheet wording suggested — readable and on-theme on a dark surface, not a defect. |
| 11 Non-StyleChat regression sniff | **PASS** | Home, Scan (Look Analyzer), and Library all opened with no crash and **no raw StyleChat/network error text** on any non-StyleChat surface. |
| Optional log review | **PASS** | `adb logcat` (ReactNativeJS + broad buffer) showed **no** message text, email, bearer/access/refresh token, auth cookie, base64, or PEM key. App-tagged lines are benign system entries (SurfaceFlinger / Samsung GameManager / Freecess). Dev-mode, buffer-limited check. |

## Issues Found

### I1 — Deployed (pre-patch) Edge Function returns truncated assistant responses
- **Severity:** P1 **functional — but addressed by this patch and not yet deployed** (i.e., not a regression introduced by `b7a6cde`).
- **Exact behavior:** Multiple assistant bubbles in the live thread end mid-sentence: e.g. "For a classic and effortless look," / "To complete the black jacket and jeans" / "For a basketball game, a stylish" / ": Casual and sporty. A graphic".
- **Expected behavior (post-patch):** Complete, punctuated responses (the patch adds a completion contract, 320-token budget, multi-part join, and one retry server-side).
- **Evidence:** `qa/stylechat-runtime-smoke/screenshots/t9-persistence-thread.png`, `t7-recovery.png`.
- **Why it's still open at runtime:** the `b7a6cde` Edge Function changes are **not deployed**; the app talks to the pre-patch deployed function. The fix is in the commit but unverified on-device.
- **Blocks merge to release:** Not strictly (the commit's frontend is safe and the edge *source* is corrected), **but** the "stabilize runtime response" half of the commit must be **deployed and re-tested** (Tests 2–4) before relying on it. See merge recommendation.

### I2 — Send-dependent tests not confidently automatable on this device
- **Severity:** P2 (test-process, not a product defect).
- **Exact behavior:** Foreground contention from other apps + the risk of blind repeat-taps hitting the header DELETE made Tests 2–5 unsafe/unreliable to fully automate.
- **Recommended:** Owner manually runs Tests 2–5 (ideally after deploying the edge function), or runs them on a dedicated/clean test device.
- **Blocks merge:** No.

No P0 found. No crash, no auth break, no privacy/secret leakage, no raw network error surfaced to the user, no composer overlap, no recovery failure.

## Fixes Applied
None. Observe-and-report only. No code modified, staged, committed, deployed, or built.

## Final Status
**PASS WITH NOTES**

- All automatable frontend behaviors of `b7a6cde` passed on the physical device: **offline friendly-error UX (Test 6), reconnect recovery (Test 7), composer 3-button safe-area (Test 8)** — these are the core frontend goals of the commit — plus launch/entry, persistence/back-nav, V6 visual, and a clean non-StyleChat regression sniff. Log review found no leakage. TypeScript passes.
- Notes: **Edge Function runtime validation is DEFERRED** (not deployed → response-completeness Tests 2–4 unverified, and the deployed pre-patch edge currently truncates replies — I1). **Test 5** (duplicate protection) is **owner-manual** (send-gating confirmed; live rapid-send not safely automatable here — I2). Dev-client/emulator-style caveats per environment.

## Merge Recommendation
**WAIT** (per status rules: PASS WITH NOTES → WAIT unless the owner explicitly accepts the notes)

- The **frontend** of `b7a6cde` is validated and safe to merge (offline UX + composer safe-area + error mapping all confirmed on-device; no P0/P1 introduced).
- **Before relying on the "stabilize runtime response" half**, the owner must: (1) **deploy** `supabase/functions/stylechat-generate` (commit `b7a6cde`) to the project the app uses, then (2) re-run **Tests 2–4** (normal / short / longer prompts) to confirm responses no longer truncate, and (3) manually confirm **Test 5** duplicate protection.
- If the owner explicitly accepts deploy-and-verify-edge as a tracked follow-up, this can move to **YES** for the frontend; otherwise **WAIT**.

## Reason
No P0 and no P1 attributable to the patch's frontend; the only P1-class behavior (truncated responses) is the pre-existing production bug this commit *fixes server-side*, and it is unverifiable at runtime because the Edge Function is not deployed. That, plus the owner-manual duplicate-protection check, keeps this at PASS WITH NOTES / merge-WAIT rather than full PASS.

## Evidence (untracked, gitignored under qa/**/screenshots/)
- `qa/stylechat-runtime-smoke/screenshots/t1-home.png` — Home, authenticated
- `qa/stylechat-runtime-smoke/screenshots/t1-sessionlist.png` — StyleChat session list
- `qa/stylechat-runtime-smoke/screenshots/t6-offline-error.png` — "Connection lost…" friendly error + RETRY
- `qa/stylechat-runtime-smoke/screenshots/t7-recovery.png` — recovered thread after reconnect
- `qa/stylechat-runtime-smoke/screenshots/t8-composer-safearea.png` — composer above 3-button nav
- `qa/stylechat-runtime-smoke/screenshots/t9-persistence-thread.png` — persisted session (also shows truncation)
- `qa/stylechat-runtime-smoke/screenshots/t10-visual.png` — V6 visual
