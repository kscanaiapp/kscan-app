# Live VTO — P3-C Integration Manifest

The authoritative record of what this lane is allowed to touch, what it
actually touched, and why. `scripts/check-vto-live-integration-scope.js`
parses the **Authorized mutation boundary** table below and fails if the
branch's diff reaches outside it, so this document is a control rather than a
description.

---

## Base authority

```
INTEGRATION_BRANCH:  integration/backend-kplus-complimentary-staging-v1
INTEGRATION_SHA:     f2ef091aae0f270a8b966dc03d7c18198070b42f
MASTER_SHA:          688dc35e5bc19bed603eea9835d3f8f12afba3be
PR291_SHA:           769db5002dff9dbc58eade514bd613488efb1a71   (research/evidence authority — NOT modified)
PR295_SHA:           266ab1a8538ed73b91a50e58f7089ae41b784c2b   (research/evidence authority — NOT modified)
```

`integration/backend-kplus-complimentary-staging-v1` carries the full VTO
client. It has advanced since PR #295 recorded it at `f5ff48c8`; this lane is
based on its current tip, not on that older SHA.

**Production enablement: NO.** **Production/staging deployment: NO.**
**Generative backend mutation: NO.**

---

## Authorized mutation boundary

Every row needs a path, a reason, and a source authority. The guard refuses a
row missing any of the three, so a path cannot become authorized by being
added to a list without a justification.

| AUTHORIZED PATH | WHY MUTATION IS REQUIRED | SOURCE AUTHORITY |
| --- | --- | --- |
| `types/vtoLive.ts` | The promoted Live contract has to live somewhere the app can import; the research workspace is deliberately not an app dependency. | P3-C §29 (contract promotion), amendment §20 |
| `types/vto.ts` | One additive union member (`VtoPersonInputSource`) so a clean Live capture can enter the existing generative contract without a parallel type. | P3-C §21, amendment §9 (additive extension) |
| `services/vto/**` | The capability router, native adapter, Live garment rule, camera-permission read, harness, session reducer and Photoreal bridge are all VTO services. | Amendment §4 (authorized VTO mutation boundary) |
| `hooks/useVirtualTryOn*` | One additive action (`adoptPerson`) so the Live handoff reuses the existing store entry point instead of opening a second generative path. | Amendment §4, §9 |
| `hooks/useVtoAvailability*` | Additively surfaces the Live half of the remote row it already reads, so the router does not issue a second config query. | Amendment §4, §9 |
| `hooks/useVtoLive*` | React bindings for the router and the Live session. | Amendment §4 |
| `components/vto/**` | The existing Try It On entry and sheet gain a second MODE; the three new components are the Live surface, its selector, and its failure boundary. | P3-C §10, §11, §19, §20; amendment §4 |
| `constants/featureFlags.ts` | The separate default-OFF Live gate, the native module name, and the dev-harness lock. Narrowly scoped app configuration directly required by the integration. | P3-C §6; amendment §4 (default-OFF feature value) |
| `docs/vto-live-integration-manifest.md` | This file. | Amendment §7, §30 |
| `docs/vto-integration-defect-ledger.md` | The required defect ledger. | Amendment §26 |
| `docs/vto-hostile-audit-ledger.md` | The full-program hostile audit's own defect ledger (P0-P3 repairs, P4-P10 findings, A-T state matrix, human/device holds). Declared here rather than granted by widening a pattern: the guard refused it, which is the guard working. | Hostile audit brief §41; amendment §26 |
| `scripts/check-vto-live-integration-scope.js` | The P3-C scope guard itself. | Amendment §7 |
| `__tests__/vto*` | VTO-specific tests, including the strengthened VTO-NC-010 dependency guard. | P3-C §30, §31; amendment §4 |
| `vto-phase4-pipeline/**` | Phase 4's garment-asset automation pipeline — an isolated, local/batch Node.js tool that turns a product source image into a `.ksgarment`-shaped asset or an explicit rejection. Not a runtime dependency of the app: nothing under `services/`, `components/`, `hooks/`, or `app/` imports from it, and it is not listed in the root `package.json`. | K Scan AI Live VTO Phase 4 brief §5, §27; `docs/vto-phase4-source-authority.md` |
| `docs/vto-phase4-*` | Phase 4's own source-authority, corpus-discovery, corpus-request, and defect-ledger documentation, required by the Phase 4 brief's own reporting sections. | Phase 4 brief §3, §7, §9, §50 |
| `fixtures/vto-phase4/**` | Generated `.ksgarment` asset bundles (manifest + texture + alpha), every one derived from a SYNTHETIC (procedurally drawn) or already-committed AUTHORIZED_FIXTURE source — never uncommitted real retailer imagery. | Phase 4 brief §27 (local/generated development artifacts storage location) |
| `evidence/vto-phase4-assets/**` | The batch-run report, Gate E economics report, and automated-correction log the Phase 4 brief requires as review evidence. | Phase 4 brief §27, §38, §45 |
| `evidence/vto-phase4-gate-e/**` | The Gate E (real catalog economics) certification evidence set the Gate E brief requires by exact path: `cohort-manifest.json`, `results.jsonl`, `summary.json`, plus the access-probe image-format census. Derived metadata only — content hashes, formats, dimensions, byte counts and host names. No source image bytes, no product titles, no store names: retailer-imagery rights are UNKNOWN, so nothing beyond the hash/diagnostic class permitted by the brief is retained. Declared as its own row rather than by widening `evidence/**`. | K Scan AI Live VTO Phase 4 Gate E brief §50 (required machine-readable evidence), §19-§20 (retention limits); `docs/vto-phase4-gate-e-rights.md` |
| `evidence/vto-phase4-2/**` | Phase 4.2's catalog-addressability evidence set: the large-corpus characterization summary and per-product JSONL, the provider query log (HTTP statuses and timings, proving rate limits were honoured rather than evaded), the segmentation benchmark, and the addressable-slice results. Derived metadata only — content hashes, dimensions, formats, shot classes, preflight measurements and timings. No source image bytes, no product titles, no store names, and no image URLs: the transient corpus cache that holds URLs is written outside the repository and gitignored. Declared as its own row rather than by widening `evidence/**`, matching the `evidence/vto-phase4-gate-e/**` precedent. | Phase 4.2 brief §2, §7, §13, §19, §57, §64 |
| `.gitignore` | One additive entry (`vto-phase4-pipeline/.corpus-cache/`) so the transient Commerce corpus cache — which holds real retailer image URLs — cannot be committed. Additive only; no existing entry is modified or removed. | Phase 4.2 brief §57 (real source bytes remain transient; do not commit third-party images) |
| `tsconfig.json` | One additive `exclude` entry (`vto-phase4-pipeline/**`), alongside the two that already exist for `supabase/functions/**` and `qa/**`, so the root TypeScript project does not try to compile Phase 4's isolated package against its own separate `node_modules`. | `docs/vto-phase4-defect-ledger.md` PHASE4-009 |
| `scripts/vto-e2e/lib/dryrun.mjs` | VTO-CERT-012: the zero-spend certification control matrix's duplicate-suppression control was nondeterministic (it raced two HTTP requests against a fixture that releases its own reservation), so it could fail a correct implementation and pass a broken one. Repaired to seed the reservation through the governed reserve RPC and prove it in_flight before one real request. Declared as an exact path rather than by widening to `scripts/vto-e2e/**`: the guard refused it, which is the guard working. | Owner-authorized narrow Control 12 repair; live evidence staging-dryrun run `vto-dryrun-20260904T191038Z-3a3db107` at authority `3c00804` (12/13 controls, 0 provider submits, 0 paid requests, 0 residual) |
| `modules/kscan-live-vto-native/**` | The N1 native Android Live VTO runtime module (`KScanLiveVto`) this lane exists to build. New directory, autolinked via the existing Expo Modules mechanism -- same pattern as the pre-existing `modules/kscan-voice-native`. | Live VTO Native Runtime N1 mission §4-§9, amendment B3 |
| `docs/vto-live-native-runtime-n1.md` | N1's own gate-by-gate tracking document, required by the mission. | N1 mission §64 |
| `docs/vto-live-native-n1-defect-ledger.md` | N1's own defect/divergence ledger, required by the mission. | N1 mission §64 |
| `docs/vto-live-native-n1-environment.md` | N1's own environment-precheck record, required by the mission. | N1 mission §0.5, §64 |
| `docs/vto-live-native-n1-conformance.md` | The N1-B/N1-C cross-runtime conformance record: reference provenance (SHAs of the compiled oracle actually executed), the golden BodyFrame set, the per-control-point and per-mesh-vertex delta tables, and the FROZEN tolerance with its measured justification. Split out of the gate document rather than appended to it because the amendment requires the frozen tolerance and the evidence behind it to be citable as one artifact, and because it is regenerated wholesale by the two tools rather than edited gate by gate. | N1 mission §8-§9, §64; amendments D3, D4, D5, D7 |
| `docs/vto-live-native-n1-runtime-architecture.md` | The frozen N1-D runtime record a hostile audit has to check without reverse-engineering the code: renderer backend and its migration trigger, thread topology, replay state machine, backpressure numbers, the privacy boundary and how it is mechanically enforced, fixture provenance, and the prepared hostile-audit scope. | N1 mission §18, §22-§26, §38; amendments D9, D10, D11, D18, D24 |
| `docs/vto-live-native-n1-perception.md` | N1-E provider provenance (MediaPipe Tasks Vision 1.0.0, verified current via Google Maven metadata), model bundling/no-silent-download evidence, the BodyFrame adapter boundary, and real-device inference/backpressure/privacy measurements. Split out for the same reason as the N1-C/N1-D companion docs -- regenerated from device evidence, not edited gate by gate. | N1-E mission sections 7-14, 18, 20, 23-28 |
| `app/dev-n1-diagnostic.tsx` | Temporary, `__DEV__`-only runtime-evidence probe reached via the app's existing `EXPO_PUBLIC_DEV_INITIAL_ROUTE` harness -- proves "JS finds module, getCapability() reaches Kotlin" (N1-A gate) without routing through the real auth-gated Scan Results path. Not a product surface. | N1 mission §7-§8 (N1-A required proof) |
| `package.json` | One additive dependency line, `"kscan-live-vto-native": "file:./modules/kscan-live-vto-native"` -- links the new local module for Expo autolinking, same pattern as the existing `kscan-voice-native` entry. | N1 mission §5 |
| `package-lock.json` | Lockfile update generated by `npm install` for the `package.json` change above. Not hand-edited. | N1 mission §5 |
| `android/app/src/main/AndroidManifest.xml` | N1-A build-infrastructure repair: a literal `--` inside an XML comment (line 31, the mailto `<queries>` rationale) is forbidden by the XML spec and rejected by Android's strict manifest-merger parser (`SAXParseException`, "The string \"--\" is not permitted within comments"). Blocked every local Gradle Android build, not specific to this lane's own module. Comment prose only; no permission, activity, or intent-filter changed. | N1 mission §59 (build-infrastructure repair authority); reproduced via `./gradlew :app:processDebugMainManifest --stacktrace` |
| `android/app/src/certification/AndroidManifest.xml` | Same defect class, same root cause, found by inspection once the main manifest's instance was diagnosed: six more literal `--` occurrences inside one comment block (lines 13-41). Comment prose only; no permission or manifest-merger directive changed. | N1 mission §59 |
| `evidence/vto-live-native-n1/**` | N1's own runtime-evidence set (getCapability() round-trip captures, first-render screenshots, cross-runtime conformance results as later gates close) -- derived diagnostic data only, no person imagery. Declared as its own row rather than by widening `evidence/**`, matching the `evidence/vto-phase4-gate-e/**` precedent. | N1 mission §63 |

### Explicitly NOT authorized, and not touched

`supabase/functions/vto-generate/**` (read only), the Commerce
implementation, the scan/identification pipeline, checkout, closet, packing,
Elise, analytics infrastructure, unrelated hooks/services/components,
deployment workflows, release credentials, and staging/production backend
configuration. `eas.json` was **read and not modified** — the Live flag is
default-OFF by absence, which needs no profile entry.

---

## Files this lane actually changed

### New

```
types/vtoLive.ts
services/vto/liveVtoNativeModule.ts
services/vto/vtoLiveCapability.ts
services/vto/vtoLiveGarment.ts
services/vto/vtoLiveCameraPermission.ts
services/vto/vtoLiveHarness.ts
services/vto/vtoLiveSession.ts
services/vto/vtoPhotorealHandoff.ts
hooks/useVtoLiveCapability.ts
hooks/useVtoLiveSession.ts
components/vto/VtoModeSelector.tsx
components/vto/VtoLivePanel.tsx
components/vto/VtoLiveErrorBoundary.tsx
scripts/check-vto-live-integration-scope.js
docs/vto-live-integration-manifest.md
docs/vto-integration-defect-ledger.md
__tests__/vtoLiveCapabilityRouter.test.js
__tests__/vtoLivePrivacyBoundary.test.js
__tests__/vtoLivePhotorealHandoff.test.js
__tests__/vtoLiveFeatureGate.test.js
__tests__/vtoLiveSessionState.test.js
__tests__/vtoAiPhotoRegression.test.js
__tests__/vtoLiveIntegrationScope.test.js
```

### Modified

```
types/vto.ts                          one additive union member
constants/featureFlags.ts             three additive constants, all default-OFF
services/vto/vtoFeatureControl.ts     additive nested `live` block in the existing row
services/vto/vtoTelemetry.ts          one allowlisted event + one property
hooks/useVirtualTryOn.ts              one additive action
hooks/useVtoAvailability.ts           two additive result fields
components/vto/TryItOnEntry.tsx       asks the router once, passes the answer down
components/vto/VirtualTryOnSheet.tsx  gated mode selector + Live panel
__tests__/vtoPrivacyAndWiring.test.js VTO-NC-010 enrollment + a new lazy-require guard
```

No existing export was removed, renamed, or narrowed.

---

## Promoted contracts

Only the minimum stable definitions the real client needs. The research
workspace (`kscan-live-vto/`) is **not** a dependency of this app, is not
imported anywhere, and adds nothing to the production bundle.

| PROMOTED DEFINITION | SOURCE PR | SOURCE SHA | SOURCE FILE | WHY REQUIRED |
| --- | --- | --- | --- | --- |
| `LIVE_VTO_COMMANDS` | #291 / #295 | `769db50` / `266ab1a` | `packages/live-vto-contract/src/nativeView.ts`, `packages/native-runtime-contract/src/capturePipeline.ts` | The app must know exactly which messages it may send a Live runtime. Reconciled to #295's later `capturePersonFrame`/`capturePreview` split rather than #291's single `capture()`. |
| `LIVE_VTO_EVENTS` | #291 / #295 | `769db50` / `266ab1a` | `nativeView.ts`, `performanceEvent.ts` | The session reducer's entire input vocabulary. Adopts `privacyStateChanged`/`performanceChanged` per P3-C §8 over #291's `privacyState`/`qualityChanged`+`thermalChanged`. |
| `FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS` + `findForbiddenLiveDataKey` | #291 | `769db50` | `nativeView.ts` (`FORBIDDEN_EVENT_PAYLOAD_KEYS`), `privacy.ts` (`LOCAL_ONLY_DURING_LIVE`) | The raw-data boundary has to be enforceable in app code, at the one point native events enter. Widened to a SUPERSET of the union of both lists (plus the plural/byte spellings `frames`, `masks`, `imageBytes`) and made recursive. **VTO-HA-001**: as originally written this row was inaccurate -- the list omitted `lightingAnalysis` from `LOCAL_ONLY_DURING_LIVE`, so it was not the union it claimed to be. The union is now asserted mechanically against #291 source by `__tests__/vtoLiveContractPromotion.test.js` rather than maintained by hand. |
| `LiveVtoCapturedFrame`, `assertCleanPersonFrame` | #295 | `266ab1a` | `packages/native-runtime-contract/src/capturePipeline.ts` | The clean-frame rule is the privacy guarantee of the whole Photoreal handoff; it must be enforced in the app, not only in research. |
| `PhotorealIntentState` + transitions + `handlePhotorealFailure` | #295 | `266ab1a` | `packages/photoreal-bridge/src/photorealIntent.ts`, `failureModes.ts` | Proves the handoff is explicit and that no failure ends the Live session. |
| `LiveVtoPrivacyPhase` | #291 | `769db50` | `packages/live-vto-contract/src/privacy.ts` | The local/cloud fence the UI's processing copy depends on. |
| `LiveVtoRuntimeErrorState` + `toLiveVtoRuntimeError` | #295 | `266ab1a` | `packages/native-runtime-contract/src/performanceEvent.ts` (`RuntimeErrorState`, `toRuntimeErrorEvent`) | Keeps provider/ML-native error text off the screen. Extended with the six initialization failures P3-C §16 requires. |
| `LIVE_SUPPORTED_TEMPLATE_FAMILIES` | #291 | `769db50` | `packages/garment-contract/src/garmentDescriptor.ts` | The hard allow-list of what Live can render, which is what makes the Live category set honestly narrower than AI Photo's. |
| `LiveVtoGarmentDescriptor` | #291 | `769db50` | `garmentDescriptor.ts` (strict subset) | The runtime needs identity + image + template family. The rendering fields (silhouette, neckline, closure, texture, material) were NOT promoted: this app has no source of truth for them, and inventing them is exactly the metadata fabrication the research contract forbids. |

**Deliberately not promoted:** `BodyFrame`, segmentation masks, pose
landmarks, the body proxy, the MLS deformation and renderer, and the
device-capability thresholds. Those stay native.

---

## Feature flags

| FLAG | DEFAULT | DEV | STAGING | PRODUCTION |
| --- | --- | --- | --- | --- |
| `EXPO_PUBLIC_VTO_UI_ENABLED` (pre-existing, unchanged) | off | not set | not set — except `staging-certification` = `"true"` | **not set** |
| `EXPO_PUBLIC_LIVE_VTO_ENABLED` (new) | **off** | not set | **not set** | **not set** |
| `EXPO_PUBLIC_LIVE_VTO_HARNESS` (new, dev-only) | off | not set | **not set** | **not set** |

Source-controlled state read from `eas.json` at `f2ef091`, not assumed.
`__tests__/vtoLiveFeatureGate.test.js` asserts no profile defines either new
variable, and that the pre-existing VTO flag's posture is unchanged.

The operator kill switch is the existing `vto_generation` `app_config` row,
extended with an additive nested `live` block. A row written before this
lane — which is every row in every environment — parses to `liveEnabled:
false`. No new control provider was introduced, and no backend row was
written by this lane.

---

## Capability router

`services/vto/vtoLiveCapability.ts#resolveVtoCapability`. Pure, synchronous,
total, fail-closed. Evidence in, decision out; no I/O, so it cannot report
"available" while a probe is outstanding.

Reason ladder, first match wins:

```
feature_disabled      build flag off, or the remote live switch off
device_unsupported    platform is not ios/android, or the module says the device can't
native_module_missing no module registered
runtime_unavailable   module present and device capable, but its runtime isn't ready
garment_unsupported   Live can't render this category (AI Photo still can)
permission_unavailable camera explicitly denied, or no camera
```

`cameraPermission: 'undetermined'` is **not** disqualifying — the prompt
belongs to the Live entry action, not to capability resolution.

`shouldOfferModeChoice` is true only when both modes genuinely work, which is
what keeps a disabled Live tab off a normal customer's screen.

---

## Native adapter expectation

A future module registers as `KScanLiveVto` and exposes `getCapability()`,
`addListener()`, and the ten commands. It is discovered with
`requireOptionalNativeModule` (returns `null` for a missing module rather
than throwing), lazily, so nothing native participates in app startup.

**Registration is not capability.** `describeLiveVtoNativeCapability`
requires the module's own self-check to return `capable === true` **and**
`runtimeReady === true`. Truthy-but-not-true, a throw, a malformed shape, or
a missing method all resolve to "not capable".

**Not compiled, not mounted, not executed.** No Live native module exists in
this repository or in any build; every Live path in this lane is exercised
against the contract and the reducer, never against a runtime.

---

## Backend contract read (read-only)

`supabase/functions/vto-generate/**` @ `f2ef091`, read and not modified.

- **Request:** `{ requestId, origin, person: { dataUri }, garment: { productRef, imageUrl, category, brand, commerceSource }, requestGeneration?, devScenario? }`
- **Response:** `{ requestId, provider, result: { dataUri, mediaType, width, height, latencyMs } }`, or `{ error: { code } }` from the K Scan failure taxonomy.
- **Async model:** synchronous invoke, 45s server generation timeout inside a 55s client ceiling, so a server-classified `provider_timeout` wins the race.
- **Entitlement:** K+ from `user_entitlements`, server-side, identity from the verified JWT only.
- **Quota / reservation / idempotency:** reservation taken before the provider call; `buildVtoIdempotencyKey` keyed on the client's `requestGeneration` intent sequence; `billable: false` releases the attempt.
- **Feature controls:** the `vto_generation` `app_config` row, re-read server-side with the service role.
- **Validation:** person data-URI pattern + size bound, `assertSafeRemoteMediaUrl` (SSRF) on the garment URL, and result media validation.
- **Failure taxonomy:** the 16 `VTO_FAILURE_CODES`, mapped to HTTP status server-side.

The Live → Photoreal handoff produces a `VtoPersonInput` and hands it to the
**existing** store → client → Edge Function chain. It adds no field, no
header, and no alternative shape. The server cannot tell which mode produced
the image, and must not be able to.

---

## P0–P3 repairs

See `docs/vto-integration-defect-ledger.md`. Two P2s and one P3, all inside
the VTO boundary, all fixed with tests.

## P4–P10 findings

Recorded in the ledger, **document-only** per amendment §1. None implemented.

---

## Production enablement

```
NO
```

The PR is safe to merge without exposing Live: the flag is off by default and
set in no profile, the remote switch is off in every existing row, and no
native module exists to satisfy the capability check even if both were on.
