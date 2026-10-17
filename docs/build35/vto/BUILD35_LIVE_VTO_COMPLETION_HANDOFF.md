# Build 35 Live VTO completion handoff

## Executive verdict

**SOURCE READY FOR OWNER EAS APPROVAL**. Native engine, one genuine product, customer UI, commerce identity, capture contract and Live activation are integrated. Every executable source check passed at the engineering HEAD. Physical certification remains pending. No EAS build, release archive, submission, TestFlight or Play upload was executed.

One genuine product is integrated: AS Colour Staple Tee 5001, Black. The other two bundled assets remain explicitly identified engineering fixtures. This is a supported-top pilot, not general retailer catalog coverage or a fit/photorealism certification.

## Exact source authority

- Repository: kscanaiapp/kscan-app.
- Base integration: integration/build35-v1-convergence at 1e5918852c948759d2dbdd954daea0b44b475d1f.
- Backend authority: rebuild/backend-authority-v2 at 54e9c27d9e39df99b167126382fe8ed9f5f01edb. Both heads were re-read after implementation and remain unchanged.
- Dedicated worktree branch: build35/live-vto-completion-20261016.
- Engineering HEAD: 1a3fbe3e18a0a9731d8a6101b32a4eb79f9d7da2.
- Implementation PR: [#626](https://github.com/kscanaiapp/kscan-app/pull/626), engineering HEAD is fully green. The final report/evidence commit follows that SHA; the PR records its final exact SHA, exact-head checks and governed merge outcome.
- PR #625 remains documentation-only. Its activation findings were read, preserved, and repaired here; its previous hard stop was not reused as an implementation rule.

| Commit | Repair |
| --- | --- |
| 75242bd6 | Genuine static capability, integrity, native camera/capture/render lifecycle |
| ac6fd7b2 | Phase 4 genuine garment, provenance and variant-specific registry |
| 5fb5dff9 | Customer Live stage, functional controls, cancellation and Photo review |
| ee15d345 | Stable Scanner/commerce identity through real session-controller contract |
| 1ccdc1ed | Approved Build 35 Live source activation and guards |
| 81fe105a | Reachable retailer product card and native/commerce CI coverage |
| 0ce3a678 | Scope-table repair, camera/provider teardown and transport isolation |
| 84414a69 | UIKit texture coordinates, tracking recovery and release guard alignment |
| 1a3fbe3e | Native model initialization off UI queues, cancellation and truthful Photo action |

Engineering exact-head CI at 1a3fbe3e18a0a9731d8a6101b32a4eb79f9d7da2 is green. Full check inventory and job metadata are in evidence/build35-live-completion/engineering-ci.json. The final documentation/evidence HEAD is rechecked before merge; no source changed after the engineering HEAD.

| CI job | Result / evidence |
| --- | --- |
| Live source/commerce/release contracts | [PASS](https://github.com/kscanaiapp/kscan-app/actions/runs/38984316111/job/117252114803) |
| Android native compile/pixel tests | [PASS, 97 tests](https://github.com/kscanaiapp/kscan-app/actions/runs/38984316111/job/117252114902) |
| SwiftPM Core/Rendering | [PASS, 86 tests](https://github.com/kscanaiapp/kscan-app/actions/runs/38984316111/job/117252115040) |
| iOS simulator Debug compile | [PASS](https://github.com/kscanaiapp/kscan-app/actions/runs/38984316111/job/117252484303) |
| Full repository / backend / TS / parity | [PASS, 11,125 executed JS tests](https://github.com/kscanaiapp/kscan-app/actions/runs/38984316112/job/117252328859) |
| Apple source, release profiles, VTO scope, backend contracts, security and promotion | PASS; URLs/results preserved in engineering-ci.json |
| Paid-provider VTO E2E | SKIPPED by existing governance; no paid generation was executed |

No protection bypass, force push or backend authority modification was used.

## What actually works and the evidence boundary

| Stage | Classification | Evidence and limits |
| --- | --- | --- |
| Native module/capability | VERIFIED IN SOURCE; VERIFIED IN NATIVE TEST | Android/iOS platform, front camera, model SHA, native raster prerequisite, permission status; unknown static inputs fail closed with bounded diagnostic reasons. Physical certification is a separate false state, never a startup dependency. |
| Camera | VERIFIED IN SOURCE; native compilation | CameraX compatible preview/software draw configuration retained; AVFoundation configuration committed before startRunning; teardown generation prevents late reopen. Ten-second no-frame deadline releases camera and reports recoverable failure. Model load runs on native worker; stale completion disposes itself. No camera frames have been delivered on a physical device in this sprint. |
| Frames | VERIFIED IN SOURCE; VERIFIED IN NATIVE TEST | Bounded latest frame/geometry slots, native-only data, separate clean capture slot; controlled input sequences exercise production perception/session boundaries. Physical CameraX/AVFoundation callback delivery remains DEFERRED TO DEVICE CERTIFICATION. |
| Pose | VERIFIED IN SOURCE; VERIFIED IN NATIVE TEST | Approved model hash checked at capability and actual initialization; real provider linked by native compilation. Controlled provider tests exercise adapter, geometry, loss clearing and recovery. Actual MediaPipe inference on a camera image is DEFERRED TO DEVICE CERTIFICATION. |
| Garment | VERIFIED IN NATIVE TEST; VERIFIED IN INTEGRATION TEST | Three real bundled manifests/textures/alphas pinned on both platforms. Wrong variant/image, unknown asset, invalid identity and corrupt bytes rejected; no fixture substitution for a selected product. |
| Render | VERIFIED IN NATIVE TEST | Production Canvas and Core Graphics rasterizers produce nonempty, garment-distinct PNGs from governed assets and controlled poses. Empty/malformed output and identity warp tested. Native images in evidence/build35-live-completion/android-render and ios-render were inspected. These are offscreen native artifacts, not person-camera previews. |
| Capture | VERIFIED IN SOURCE; VERIFIED IN NATIVE TEST; VERIFIED IN INTEGRATION TEST | Native raster PNG output and real controller capture contract tested. Clean frame uses separate latest camera slot; composited capture explicitly draws person plus garment, avoiding camera-layer screenshot omissions. Actual clean/composite camera capture remains DEFERRED TO DEVICE CERTIFICATION. |
| Shop | VERIFIED IN INTEGRATION TEST | Existing TryItOnEntry and return-to-shopping callback preserve original commerce product and safe retailer URL. Actual external retailer navigation/availability remains a device/network check. |

No full-size camera image, raw pose or per-frame geometry crosses the JS bridge. Only high-level bounded state and local capture file handles cross it. Android diagnostic logging of raw landmark samples was removed.

## Asset inventory

| Asset key | Product identity | Manifest assetId | Category | QA | Bundle |
| --- | --- | --- | --- | --- | --- |
| n1b-fixture | p4-multi-image-product | 081350cef7f5c83e05c3e6c1 | top | QA passed; live2d true | Android + iOS |
| n1c-asym-fixture | n1c-asym-marker | n1c-asym-marker-fixture | top | QA passed; live2d true | Android + iOS |
| ascolour-5001-black-v1 | https://ascolour.com/staple-tee-5001/?Colour=Black | 524ab66a3f16bda5c3d7f9fe | top | QA passed; live2d true | Android + iOS |

All use asset version 1/schema 1.0 and a valid top template. Exact QA payload, provenance hashes and bundle presence are in [source-verification.json](../../../evidence/build35-live-completion/source-verification.json). The two fixtures are research/test assets, never retailer coverage evidence.

**n1b-fixture**

- manifest.json: `32f311c39566b448b1a37c4f9e9286437f245ffdad25b4876e4d3a1ae21bce2d`
- texture.png: `5deca90a677b8ab31f01108b865641eccafb2f3f8f3c21083944acc9adec4393`
- alpha.png: `709dda03727503c3cccfd9ad8193b35cc576703a01cf4661f9215aa2ce312c00`

**n1c-asym-fixture**

- manifest.json: `3d8aafb41bcbfb444312a95741ef41c1c5a59577ab118a96171982f7e7ac1347`
- texture.png: `9c0e24fd94f10477c80677061ad7c49fbcd2237959dd0e30565fc840cbdb67f8`
- alpha.png: `709dda03727503c3cccfd9ad8193b35cc576703a01cf4661f9215aa2ce312c00`

**ascolour-5001-black-v1**

- manifest.json: `da3fa1a0613f0923d26acbde8aca401759fc6909521ea97083acb005310cdf79`
- texture.png: `c5ff5abfa5898fabe4ec1ae1d8a43cebad282ad570ae966d81fcbdddf983afe6`
- alpha.png: `2c189b257d48fdbbe7614fb381fb755f6320d73af168da25954726101c6ca7ba`

The genuine product uses the retailer's [currently offered Black variant](https://ascolour.com/staple-tee-5001/?Colour=Black) and publicly provided [downloadable product imagery](https://ascolour.com/downloads), checked 2026-10-16. [Pilot provenance and reproduction](BUILD35_LIVE_GARMENT_PILOT.md) records the exact image URL, SHA and Phase 4 correction. Default extraction FAILED with EXTRACTION_UNRELIABLE; the pipeline's existing threshold-50 correction passed QA and Live eligibility. No QA acceptance thresholds were reduced. Independent fidelity references are absent for color/logo/pattern; QA does not certify its own visual fidelity.

One real product meets the minimum. Additional four tops are DEFERRED TO ASSET AUTHORING/QA, not silently filled with fixtures. Rights beyond the owner's authorized engineering use and retailer's published imagery conditions are not claimed.

## UI and Scanner integration

The existing Scanner/commerce product Try It On surfaces still feed VirtualTryOnSheet. The eligible selected product retains its deterministic provider/product URL-derived productRef. A narrow advisory productUrl supports variant-specific asset matching; canonical Scanner IDs and paid Photo request transport are unchanged.

The Live resolver accepts only the approved retailer host/path/Black colour plus exact source-image identity. Known tracking parameters are ignored; missing/duplicate colour, other image or retailer is refused. Descriptor and native active garment retain the selected productRef. Switch regression tests preserve PR #611/#624 identity behavior. Unsupported Live products retain Photo availability where otherwise eligible.

The existing Try-On Studio additionally exposes a genuine supported product card inside its existing Live/member/native/operator gate. Its TryItOnEntry and retailer link use existing account, K+ and commerce behavior, with no second session controller.

Working controls: Start Live after native view layout; pause/resume; recoverable restart through stop/start; selected product switching through existing sheet props/controller; preview capture with visible local result; Continue to AI Photo using clean person frame; AI Photo mode choice; return shopping; close Live. Portrait native stage is visible and sized 3:4 with minimum 320 points. Initializing/loading/search/tracking/lost/error/permission feedback is bounded and accessible. Capture is disabled while paused or not tracking.

Continue to AI Photo adopts a clean frame into the existing Photo review. It never auto-generates. Photo consent, quota, provider, billing and final Generate action remain separate. No Live preview/capture action issues a paid request.

Existing K+ admission/upgrade experience is reused. Surface withdrawal, account changes, sign-out and entitlement loss dispose Live, revoke camera lease and invalidate pending permission/capture. Tests reject late callbacks under a new actor.

## Activation and operator configuration

CONFIGURED ON in source: production, build35-release, build35-testing, production-certification, staging and staging-certification. Raw Live=true is explicit in production, build35-release and staging; the other three inherit their approved parent. Preview/development remain OFF. Simulated harness remains OFF/absent everywhere; unrelated profile guards remain intact. No EAS action was executed.

Operator public.app_config / vto_generation was re-read on both K Scan projects. Snapshot: evidence/build35-live-completion/operator-before.json. Staging has nested live.enabled=true with supportedCategories=[top]. Before the write, Production had no live member and was OFF. Top-level Photo enabled=true and provider=ailabtools_tryon_clothes_pro on both. After all native checks passed, Production was re-read unchanged and a compare-and-set updated exactly one row, adding only live={enabled:true,supportedCategories:[top]}. Both projects were re-read afterwards: Live is ON for tops in Staging and Production. Existing Photo fields are byte-for-byte unchanged. Evidence: operator-after.json; exact forward/rollback SQL: operator-forward.sql and operator-rollback.sql. This is CONFIGURED ON, not proof of physical camera behavior. Existing deployed builds with a compiled Live flag OFF remain OFF; the next owner-approved Build 35 source candidate carries Live ON.

## Test evidence

| Check | Result |
| --- | --- |
| Android local Gradle native compile + testDebugUnitTest | PASS: 97 tests, zero failures/skips, including real Canvas pixel/capture/integrity and present/lost/recovered sequence; CI XML preserved under evidence/build35-live-completion/native-test-results/android |
| Affected JS/RN/regression suites | PASS: 979 total, 975 passed, 4 explicitly skipped, zero failures (two bash controls not applicable on Windows and two scope checks run separately in enforced mode) |
| Enforced VTO scope suite | PASS: all 10 tests, with KSCAN_VTO_SCOPE_ENFORCE=1 and integration base |
| TypeScript --noEmit | PASS |
| Phase 4 tests | PASS: 87/87; pilot CLI reproduction pins texture/alpha hashes |
| Build 35 production/build35-release guard | PASS; feature flags and original unrelated protections checked |
| SwiftPM host Core/Rendering | PASS at engineering HEAD: 86 tests, zero failures, including production CG pixels and tracking recovery |
| iOS app simulator Debug compile | PASS at engineering HEAD: real Expo autolink/MediaPipe, no codesign |
| Engineering exact-head CI | PASS: all non-skipped checks green; full repository 11,221 total / 11,125 passed / 96 skipped / zero failures; governed Deno suite 1,422 passed / zero failures |
| TestSprite | CLI 0.5.0 and credentials verified. Only linked project is Build 29 staging backend API; no native/mobile project is linked. No irrelevant backend/browser run is presented as native proof. Native customer flow remains unverified on deployed/device build. |
| Physical Android / iPhone | DEFERRED TO DEVICE CERTIFICATION; no VERIFIED ON DEVICE claim |

Repeat local source checks with node --test __tests__/vto*.test.js __tests__/build35ReleaseProfile.test.js __tests__/nativeConfigParityGate.test.js __tests__/easConfigIntegrity.test.js __tests__/commerceMatchTierContract.test.js; tsc --noEmit. Run the module Gradle testDebugUnitTest/compileDebugKotlin tasks. On macOS run swift test --enable-code-coverage from the native module. Native CI builds the app for iOS simulator Debug without signing or release artifact. The commerce completion test starts with a real supported deterministic commerce contract, resolves its genuine registered asset, executes the production JS controller against a controlled native adapter, reaches capture/disposal and returns the unchanged commerce product. It is not a physical-camera test.

## Defect ledger and remaining acceptance work

| ID / severity | Location / reproduction | Root cause / fix | Blocking / owner |
| --- | --- | --- | --- |
| LVA-001 P1 | Registry originally offered only n1b/n1c fixtures; real Scanner product could not resolve | FIXED: genuine Phase 4 Black tee bundle, variant/image mapping, stable selected identity and real customer entry | Source repaired; native/contract evidence |
| LVA-002 P0 | Capability required physical certification before session could start | FIXED: static capability/readiness independent of physical acceptance, unknown prerequisites closed | Source/native tests verified |
| LVA-003 P1 | Model presence did not prove approved bytes at capability | FIXED: shared approved SHA validation at capability/provider initialization | Native integrity tests verified |
| LVA-004 P1 | Renderer prerequisite unknown; no truthful preflight | FIXED: actual raster allocation/draw probe and bounded reason; real production raster tests | Native tests verified; physical preview pending |
| LV-CAMERA-SAMSUNG P1 | Historical Samsung CameraX session ETIMEDOUT -110, camera HAL unconfigured | Cause unresolved on physical device. Keep COMPATIBLE/software-layer draw repair; do not claim host tests fix HAL behavior | Device acceptance blocker; owner Android device certification after approved build |
| LV-DEVICE-IOS P1 | Front camera/MediaPipe/mirroring/composite path not exercised on a physical iPhone in this sprint | Source, native raster and simulator compilation available; run physical matrix below | Device acceptance blocker; owner iPhone certification |
| LV-PILOT-COVERAGE P2 | Any top except approved Black tee is unsupported in Live | Asset authoring/variant QA required; honest Photo fallback remains | Does not block one-product source pilot; asset owner |
| LV-FIDELITY P2 | Independent product fidelity/fit references unavailable | Current QA reports NO_REFERENCE honestly; obtain independent reference data and device visual review | Blocks fidelity claim, not controlled source pilot; asset QA owner |
| LV-CI P1 (resolved at engineering HEAD) | Earlier release/scope guards and native CI setup failed | Fixed obsolete OFF assertions and scope table parsing, preserved unrelated guards; native/full source CI now green | Final report/evidence HEAD must also be green before governed merge; Codex |

## Physical device certification after owner EAS approval

1. Android, including the historical affected Samsung: install separately owner-approved build, verify real native module/model hashes, supported camera/static diagnostics, deny then grant permission, cold start/restart and actual frame/inference counts. Keep Samsung defect open until reproducible success evidence replaces the timeout.
2. iPhone: verify AVFoundation front camera, actual frame/model inference, portrait orientation, mirroring and aspect alignment; confirm upright garment and correct Black variant. Exercise rotation/background/foreground and interruption/re-entry as supported by the app.
3. Both: select real pilot through commerce and scan product contract; preserve productRef; render visible top while moving; loss removes stale garment, recovery restores it; verify pause/resume/restart; change supported asset in authorized engineering coverage, reject invalid/unsupported variants without substitution.
4. Capture both clean person and composited preview, inspect actual files/garment presence, verify preview has real camera imagery, and ensure clean Photo input has no overlay. Continue to Photo review and require its normal explicit consent/quota/billing/Generate behavior. Return retailer shopping and confirm original selected product.
5. Sign out/change account/revoke K+/close/background during initialization and capture. Verify no late adoption, camera indicator/resource leak, stale session or frame disclosure. Check repeated start/stop, no-frame deadline, recoverable errors, remote Live-only kill and fresh-mount behavior while Photo remains available. Measure sustained FPS/thermal/memory and capture quality on representative supported devices.

No physical acceptance, fit guarantee, real-camera performance metric, TestFlight result or store readiness is inferred from source tests.

## Rollback

Before merge, revert the narrow completion commits in reverse order on the integration branch only through a governed PR. After a merge commit, revert that merge with git revert -m 1 <merge-sha> and run source/native guards. Never reset/force-push the integration or backend authority.

For operator rollback, preserve unrelated concurrent fields: restore exactly the previous nested live member (or remove it when previously absent), guarded by the observed current nested Live value. Do not change enabled, provider, Photo categories, auth, storage or backend deployment. Snapshot/forward/rollback evidence lives beside this report; customer Live can be independently disabled with live.enabled=false without disabling Photo.
