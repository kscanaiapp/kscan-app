# VTO + Elise device validation runbook (Build 35 line)

Purpose: the only evidence still missing is physical-device evidence. This is
the exact list of what to run once a build from the merged source is authorized.
Nothing here has been run. No build exists from the current source (APK38
predates ELISE-010/011). Skipped is not passed; a screenshot or log is the
evidence, not a statement.

Preconditions (all owner-controlled, not done by this document):
- An authorized build from an exact merged SHA; record that SHA and the build id.
- Live Camera VTO stays OFF in the customer build (`EXPO_PUBLIC_LIVE_VTO_ENABLED`
  unset). Live testing needs a separate internal-only build and is section D.
- A Free test account and a K+ test account, each with at least one Closet item.
- Photo VTO is Production-enabled; each Generate is a paid provider call. Cap the
  session (suggested: 6 Generates total) and log each one.

Record for every item: device model, OS version, build SHA, account tier, result
(PASS / FAIL / BLOCKED), and a screenshot or screen recording filename.

## A. Elise keyboard and composer (ELISE-010)
Devices: one small-screen Android, one tall Android, one iPhone.
1. Open Elise, tap the composer: the input row sits fully above the keyboard.
2. Send a message with the keyboard up; the last message stays visible.
3. Rotate not required (portrait only). Dismiss keyboard by tapping outside: layout returns without a gap.
4. Repeat with the weather disclosure message visible (ELISE-010 footer).
Fail if any part of the composer is hidden or a gap remains after dismissal.

## B. Elise mouth transitions (ELISE-011)
1. Speak a reply with audio on; watch idle to speaking and back at normal speed.
2. Record 10 s of screen video; look for a visible pop between mouth shapes.
3. Reduce Motion ON with audible speech: no unexpected motion.
`transitionMs` 160 is a candidate; if it looks wrong record it, do not retune on
the device. Tuning budget used: 0 of 3.

## C. Customer journeys (Photo VTO)
For each entry: open, choose photo, consent, Generate, result, Save to Dressing
Room, close, reopen. Entries: Home Try-On Studio, Visual Search result, Closet
item, Elise contextual offer, product card.
1. Free account: Elise offer shows "TRY IT ON · K+" BEFORE the tap; K+ account: no K+ label.
2. While a Generate is running, minimize; restore from the pill; the result is for the garment tapped.
3. Open a try-on, then change the product behind it (scroll/re-sort the shelf): the sheet keeps the tapped garment.
4. Sign out (or switch account) with a try-on open and with it minimized: the sheet and pill are gone and the next account sees no photo or result (PR #619, if merged).
5. Elise offer, tap, return: you land back in the same Elise conversation, message list intact.
6. Result quality: judge the image, not just "it returned". Record a human verdict (acceptable / not) per entry.
7. Recent Looks and Resume are NOT built; do not test for them.

## D. Live camera (internal build only, never customer-facing)
Android (Samsung SM-S936U and one other device):
1. Attach the device; start `adb logcat -c`, then reproduce once.
2. Open Live; record whether frames arrive. Historical failure: front camera opens, no frames, `ETIMEDOUT -110` (Camera2-FrameProcessorBase, cameraserver).
3. Save the logcat for the single session; bounded to ONE session, no repeated retries.
iOS (one iPhone):
4. Open Live; confirm camera permission prompt, frames, portrait pin, and that no frame, mask or landmark leaves the device (network capture on).
Pass requires frames end to end AND a physical screenshot of the renderer (it once never painted); simulator or compile success is not evidence.

## E. Binary impact (when a build exists)
Record the app size delta against the previous build per platform; expect
about 5.78 MB of model per platform plus CameraX/MediaPipe or the iOS equivalents.

## Stop conditions
Stop and report on any crash, any frame or photo seen leaving the device outside
the Generate call, any charge beyond the cap, or Live appearing in the customer UI.
