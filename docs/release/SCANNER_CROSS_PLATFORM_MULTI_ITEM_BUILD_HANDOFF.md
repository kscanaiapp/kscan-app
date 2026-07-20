# K Scan Scanner — Cross-Platform Multi-Item Final Build Handoff

Branch: `integration/scanner-cross-platform-multi-item-final`
Base: `integration/android-v24-elise-welcome-ready` @ c7e6bd2af7a83cd10e80932a51a4b24027bc762a
Status: build stage complete for source, tests, TypeScript, Deno, and both
platform JS exports. Android QA artifact, developer smoke, and the origin
push are pending an owner environment with EAS credentials and a device
(see "Open gates"). This branch is NOT hostile-validated and NOT approved
for release.

## Architecture (as built)

1–5 source images → each prepared once (compress once → privacy adapter once)
→ parallel per-image `multi_item_detection` (Promise.allSettled; partial
source failure keeps surviving candidates behind one nonblocking notice)
→ normalize/aggregate/dedupe/cap 5 (`services/multiImageScan.ts`)
→ deliberate multi-select review in `ScanResultV2` (zero commerce calls,
zero auto-selection; N=1 uses the same flow)
→ count-aware CTA ("Select items to match" / "Find Matches for N Item(s)")
→ automatic sequential `selected_item` queue in `hooks/useKScan.js`
(FIFO, one active request, per-candidate session/digest/image continuity,
quota halt preserves completed results + remaining selections with
explicit resume only)
→ progressive result rendering (first ready item displays immediately).

Selection and queue authority live only in `hooks/useKScan.js`; `app.js`
renders hook state and wires actions.

## Backend

Project wyyuqfdxucjksghsmhry, function `scan-identify`, production version 119
(verified ACTIVE during the build). Request modes used: `multi_item_detection`
and `selected_item`. Backend source changed: NO. Deployment required: NO.
`selectedItemBoundary.ts` untouched and imported nowhere.

## Privacy

Cross-platform adapter (`services/privacyImageAdapter.{types,android,ios}.ts`)
in truthful passthrough posture: `localPrivacyFiltered: false`, no
`privacyProof`, fail-closed input validation, no native imports, no
import-time work. The previous hardcoded `localPrivacyFiltered: true` claim
was removed. Production privacy readiness remains gated.

## Gates at handoff

PASS: focused Scanner tests (186), full Node suite (1635/0), tsc (0
diagnostics), deno check + tests (8/0), `git diff --check`, expo export
android (1383 modules) and ios (1387 modules).
PENDING (owner environment): Android QA artifact via the repository-standard
EAS preview profile; physical/emulator developer smoke; independent hostile
validation including latency measurement; origin push.

## Areas the hostile auditor should attack

- Rapid toggle storms during review and immediately around CTA confirmation.
- Backgrounding/resuming mid-queue (no duplicate active request permitted).
- Source-set mutation after a quota halt; resume must not reuse stale context.
- Quota halt/resume across actor switch or sign-out.
- Legacy single-item responses (no detectedGarments) inside a multi-image set.
- Reduced-motion behavior on both result-UI flag configurations.
- Latency: candidate review must appear earlier than the prior automatic
  fan-out flow; no artificial post-response delay.

Full builder evidence: `C:\src\qa-evidence\scanner-multi-item-build\`
(baseline, final validation, export logs, hashes).
