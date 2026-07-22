# Emulator end-to-end results

Device: Android emulator `emulator-5554`, Pixel 8 Pro AVD, Android 17.

Build source: clean worktree commit `ea01c712…`, tree-equal to canonical merge `ffd25753…`.
Release-profile public environment values were loaded process-locally; credentials/tokens were not logged.

## Passed

- QA login completed and session persisted across APK updates/relaunches.
- Camera permission is granted and intentionally left granted for the demo account.
- System photo picker opened and retained selected-photo access.
- Scanner landing displayed `UPLOAD IMAGE`, not the former unavailable state.
- Non-sensitive gallery fixture reached Upload Review.
- `ANALYZE SCAN` completed and rendered a dress classification/result.
- Correlated Scanner event served `gemini-3.6-flash`, no fallback, valid, consumed.
- TextScan accepted a non-sensitive fashion description and rendered analysis/products in the earlier authenticated emulator run.
- Elise session history loaded, a new non-sensitive message produced one reply, and the composer remained usable.
- Correlated Elise event served `gemini-3.6-flash`, no fallback, one attempt, valid, consumed.

## Tooling failures, not product failures

- Initial build lacked `ANDROID_HOME`.
- Initial clean build lacked a debug keystore.
- Existing emulator APK had a different debug signature; only the emulator package/data was replaced.
- One all-architecture native build failed in x86_64 compilation; the bounded x86_64 rebuild succeeded.
- A PowerShell runtime harness stalled without evidence or state change.
- Live camera UI dumping was unreliable and the emulator cannot provide meaningful live-fashion imagery.

## Not completed during the LLM audit

- Physical/live camera fashion capture.
- Account switch and logout context-isolation journey.
- Scanner save → Recent Scans → Ask Elise chain.
- Saved Closet → Ask Elise chain.
- Populated Signature Style override journey.
- Dressing Room generation/navigation journey.
- Meta and Google XR hardware journeys.
- Optional ElevenLabs playback from this final build.

These gaps are not asserted as observed product failures. Under the 2026-07-22 closure amendment they are transferred to the deferred physical-device release gate in `15_PHYSICAL_DEVICE_RELEASE_GATE_DEFERRED.md` and no longer block the hostile LLM audit grade. Emulator PASS results must not be treated as physical-device verification.
