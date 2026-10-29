# Build35 privacy verification continuation

Source c86bf3d052806c6105ce7830a03ac2b1501d34a1, backend f4df2a5a525fb7ee1b22f16c9a4bc55c1c8831af. No newly confirmed P0-P3 finding. This is a bounded checkpoint, not full audit completion.

## H-001: UNCONFIRMED; source/privacy facts and legal gate

Actual seven bridged emitters enumerated108 declared explicit events, with property lists and136 direct named call sites in evidence/posthog-source-hostile-results.json. Vendor-generated lifecycle events are separate from these108 declarations.70 actual-source assertions PASS: each declared event reaches its captured sink, unknown names rejected, representative raw photo/chat/email/token/location/nested/audio-array/URL values rejected in arbitrary and declared property fields. This is representative negative coverage, not all-value/all-caller proof or provider ingestion. Reproduce: node docs/release/evidence/posthog-source-hostile.cjs C:/b35verify1029. No vendor or network dispatch.

posthogClient.core.ts:106 defaultOptIn=true when configured; no separate analytics-consent/opt-out authority, and sale-sharing preference intentionally not reinterpreted. Its SDK construction disables replay/error autocapture/GeoIP/remote flags/surveys; JSX Provider disables UI autocapture. posthogIdentitySync.ts resets before changed identity, including initial anonymous state. SDK local identity/persistence and all deletion propagation still need completion; no provider deletion request made.

Fresh read-only project571577 metadata: recording/performance/exception opt-ins true, anonymize_ipsfalse, recording retention30days. Client explicit disable settings and project defaults differ; this is not evidence a recording was made. Individual persons/events/recordings not fetched. Project business-knowledge search is not enabled; legal authority requested from owner. Current SDK documentation checked via connected docs-search: https://posthog.com/docs/references/posthog-react-native .

The app links https://kscan.app/legal/privacy . Current public page datedAugust24 describes broad operational/analytics purposes, provider processing and possible legal bases without naming PostHog. Its existence or lack of a vendor name is not enough to infer legal adequacy/illegality. Exact approved Build35 policy, processor terms/basis, applicable consent/objection model, retention and store declarations require legal confirmation. No binding policy rewritten. Remaining H001 is a specific legal/runtime binding gate plus unfinished SDK/payload work, not a confirmedP0 or a closed privacy certification.

## H-003: native accuracy/coverage NOT CERTIFIED

Scanner capture/gallery use hooks/useKScan.js:745/923 -> prepareScannerImageForDispatch -> privacyBoundary face/plate -> fresh bounded encoder -> scannerDispatchGuard registration -> runScannerIdentification:120 guard. Selected/correlated requests use session proof at useKScan.js:1192/1390; source guarantee is a derived-artifact/proof boundary, not automatic detector accuracy.

Elise header path hooks/useEliseVisualContext.ts:157 -> prepareImageForPrivacyUpload -> eliseVisualContextEvidence.ts:282/369. Direct Elise attachment also uses metadata-only preparation. privacyImageUpload.ts truthfully marks face/plate booleansfalse; these images must not inherit Scanner masking claims. Closet uses privacyBoundary default block-on-plate; PhotoVTO person/handoff use separate metadata-only, expressly consented processing. LiveVTO camera architecture is separate from cloud PhotoVTO.

Native iOS IOSPlateDetector uses text-region geometry, with explicit aspect/size/rotation limitations documented in NativePrivacyConstants. Pixel verifier checks opaque masked rectangles after decode; it cannot establish that an undetected plate/face was found. No runtime pixel/detection claim follows from TypeScript status fields or model instructions. Current public policy describes unmasked supported upload paths, so legal-agent reconciliation must distinguish these from the new Scanner source rather than invent a universal guarantee.

ADB devices -l returned0targets. No Mac/Simulator/signed binaries created or available for new evidence. Required device campaign: supported iPhone and Android, synthetic faces/plates including stacked/motorcycle, rotated, small/occluded/edge-of-frame cases; camera/gallery/crop/retry/alternative entries; record detector boxes, resulting actual pixels, metadata, exact pre-network bytes and no-dispatch on detector/encoder/cancel failure. Existing orchestrator tests remain valid bounded source evidence, not native accuracy. Universal face/plate removal cannot be certified. No feature flag changed; owner should retain release/privacy-claim hold until the required native evidence and path-specific disclosure are reviewed.

## B35-B-004 and runtime

Current actual scan-identify handler repro still throws TypeError for JSONnull,0provider/0write. Six-case targeted handler run5boundedPASS/1FAIL; log continuation-scanner-null.log. P4 unchanged, no scope escalation. Proposed repair remains early object/non-array check after JSON parsing, before legacy mode access; protected scan-identify safe-P4 condition fails, owner source approval required.

Read-only runtime proof continuation-runtime-readback.json: Production28functions/discovery absent, organic/badgefalse,sponsorship3flagsfalse, brand/imageflagstrue; Staging40functions/discoveryv5JWTtrue,organic/badgetrue. Both ledgers discovery migration present/permission migration absent; counts183Staging156Production. Boolean readback compares only exact booleans or exact SHA256 boolean digests; no arbitrary secret value persisted. No migrations/deployments/flags/purchases/customer writes performed.
