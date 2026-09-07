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
| `.github/workflows/vto-e2e.yml` | The VTO lane's own certification workflow, and now the single execution point where this boundary is enforced (job `scope-guard`, see "How the boundary is enforced" below). The guard refused this file when the enforcement wiring was added, which is the guard working — so it is declared here with a justification rather than let through. Declared as an EXACT path, never as `.github/workflows/**`: `security-code.yml`, `staging-controlled-deploy.yml` and every other workflow stay refused, and `__tests__/vtoLiveIntegrationScope.test.js` asserts that they do. | VTO scope-guard CI blocker repair §7 (wire the enforcement signal into the authoritative VTO workflow; do not make normal PR workflows declare themselves VTO lanes) |
| `scripts/vto-e2e/lib/dryrun.mjs` | VTO-CERT-012: the zero-spend certification control matrix's duplicate-suppression control was nondeterministic (it raced two HTTP requests against a fixture that releases its own reservation), so it could fail a correct implementation and pass a broken one. Repaired to seed the reservation through the governed reserve RPC and prove it in_flight before one real request. Declared as an exact path rather than by widening to `scripts/vto-e2e/**`: the guard refused it, which is the guard working. | Owner-authorized narrow Control 12 repair; live evidence staging-dryrun run `vto-dryrun-20260904T191038Z-3a3db107` at authority `3c00804` (12/13 controls, 0 provider submits, 0 paid requests, 0 residual) |
| `app/_layout.tsx` | Final pre-build hostile audit P2 repair: install the previously unwired push-token refresh listener at the app root. This is an exact application path, not an `app/**` grant. | Owner-authorized final hostile audit repair `AUD-P2-R01` (2026-09-06) |
| `services/onboardingCompletion.ts` | Final pre-build hostile audit P1 repair: reject a legacy local boolean as proof of the current legal acknowledgment. This is an exact service path, not a `services/**` grant. | Owner-authorized final hostile audit repair `AUD-P1-R01` (2026-09-06) |
| `services/analytics/posthogClient.core.ts` | Final pre-build hostile audit P2 privacy repair: explicitly disable GeoIP at the sole PostHog SDK boundary. This is an exact service path, not an analytics-directory grant. | Owner-authorized final hostile audit repair `AUD-P2-R02` (2026-09-06) |
| `services/analytics/posthogIdentitySync.ts` | Final pre-build hostile audit P1 privacy repair: reset any restored anonymous SDK identity before synchronizing. This is an exact service path, not an analytics-directory grant. | Owner-authorized final hostile audit repair `AUD-P1-R02` (2026-09-06) |
| `scripts/check-dependency-reachability.js` | Final pre-build hostile audit P3 repair: make the bounded dependency gate invoke npm through Node on Windows. This is an exact script path, not a `scripts/**` grant. | Owner-authorized final hostile audit repair `AUD-P3-R01` (2026-09-06) |
| `__tests__/dependencyReachabilityGate.test.js` | Regression proof for exact repair `AUD-P3-R01`; does not authorize non-VTO tests generally. | Owner-authorized final hostile audit repair `AUD-P3-R01` (2026-09-06) |
| `__tests__/notificationsClosureConvergence.test.js` | Regression proof for exact repair `AUD-P2-R01`; does not authorize non-VTO tests generally. | Owner-authorized final hostile audit repair `AUD-P2-R01` (2026-09-06) |
| `__tests__/onboardingCompletion.test.js` | Regression proof for exact repair `AUD-P1-R01`; does not authorize non-VTO tests generally. | Owner-authorized final hostile audit repair `AUD-P1-R01` (2026-09-06) |
| `__tests__/posthogAnalyticsGovernance.test.js` | Regression proof for exact repair `AUD-P2-R02`; does not authorize non-VTO tests generally. | Owner-authorized final hostile audit repair `AUD-P2-R02` (2026-09-06) |
| `__tests__/posthogIdentitySync.test.js` | Regression proof for exact repair `AUD-P1-R02`; does not authorize non-VTO tests generally. | Owner-authorized final hostile audit repair `AUD-P1-R02` (2026-09-06) |
| `docs/audits/final-prebuild-hostile-audit.md` | The owner-required final hostile-audit ledger and P0-P3 repair record. Declared exactly rather than by widening `docs/audits/**`. | Final hostile audit brief (mandatory P4-P10 ledger; 2026-09-06) |
| `docs/audits/evidence/android-onboarding-account-form.png` | Sanitized Android emulator evidence supporting the exact final hostile-audit ledger; no credentials or user data. Declared exactly rather than by widening an evidence directory. | Final hostile audit brief (Android runtime evidence; 2026-09-06) |
| `services/privacyImageUpload.ts` | `RP-107` (C1/C2): the shared sanitizer's `maxDimension` bounded only the WIDTH, so a VTO person photo was submitted far over the bound on its long edge and a small photo was upscaled. The defect is in this file — it cannot be repaired from inside `services/vto/**`. The change is additive and opt-in: `boundedResizeActions()` engages the true longest-edge bound only when a caller supplies the source dimensions (VTO does; Scanner and Elise do not), so every non-VTO caller keeps byte-identical behaviour in a frozen build. This is an exact service path, not a `services/**` grant. | Owner-authorized Build 34 repair `RP-107` (2026-09-06), Lane C §2-§3 |
| `scripts/vto-e2e/run.mjs` | `RP-106`: `--mode=contract` could not run on Windows — it located its own test files with a file URL's `.pathname`, which is `/C:/...` there, so all three failed to LOAD and the mode reported `pass: 0, fail: 3`. A certification harness that cannot run on the platform the repair is performed on cannot certify the repair. Repaired with `fileURLToPath`; Linux CI behaviour is unchanged. Declared as an exact path rather than by widening to `scripts/vto-e2e/**`, exactly as `lib/dryrun.mjs` above was — the guard refused it, which is the guard working. | Owner-authorized Build 34 repair `RP-106` (2026-09-06), Lane D §15; contract mode 86/86 after repair |
| `config/migration-authority-manifest.json` | `RP-106` / `VTO-MIG-001`: the staging environment declared `20260902150000` `GENUINELY_UNAPPLIED` on evidence captured 2026-09-03. By 2026-09-07 that was false — the ledger carried the version and `release_vto_generation` existed with a byte-identical body. A governance manifest asserting a false fact about staging is worse than one asserting nothing, so the entry moves to `appliedSinceReconciliation` with the certification evidence. Descriptive correction only: no gate consumes `genuinelyUnapplied` for a blocking decision. | Owner-authorized Build 34 repair `RP-106` (2026-09-06), Lane D §11, §18 |
| `__tests__/staging/stagingMigrationReconciliation.test.js` | Regression proof for the `RP-106` manifest correction above — it pinned the now-false `GENUINELY_UNAPPLIED` shape by name and count. Updated to pin the corrected shape while keeping the structural invariant it exists for (nothing declared both unapplied and reconciled; every declared version still on disk). Does not authorize non-VTO tests generally. | Owner-authorized Build 34 repair `RP-106` (2026-09-06), Lane D §18 |
| `docs/audits/rp106-vto-attempt-release-promotion.md` | The production promotion record `RP-106` §23 requires: what was certified on staging, the evidence, and the explicit statement that production remains frozen during Apple review. Declared exactly rather than by widening `docs/audits/**`. | Owner-authorized Build 34 repair `RP-106` (2026-09-06), Lane D §23 |
| `modules/kscan-live-vto-native/**` | The N1 native Android Live VTO runtime module (`KScanLiveVto`) this lane exists to build. New directory, autolinked via the existing Expo Modules mechanism -- same pattern as the pre-existing `modules/kscan-voice-native`. | Live VTO Native Runtime N1 mission §4-§9, amendment B3 |
| `docs/vto-live-native-runtime-n1.md` | N1's own gate-by-gate tracking document, required by the mission. | N1 mission §64 |
| `docs/vto-live-native-n1-defect-ledger.md` | N1's own defect/divergence ledger, required by the mission. | N1 mission §64 |
| `docs/vto-live-native-n1-environment.md` | N1's own environment-precheck record, required by the mission. | N1 mission §0.5, §64 |
| `docs/vto-live-native-n1-conformance.md` | The N1-B/N1-C cross-runtime conformance record: reference provenance (SHAs of the compiled oracle actually executed), the golden BodyFrame set, the per-control-point and per-mesh-vertex delta tables, and the FROZEN tolerance with its measured justification. Split out of the gate document rather than appended to it because the amendment requires the frozen tolerance and the evidence behind it to be citable as one artifact, and because it is regenerated wholesale by the two tools rather than edited gate by gate. | N1 mission §8-§9, §64; amendments D3, D4, D5, D7 |
| `docs/vto-live-native-n1-runtime-architecture.md` | The frozen N1-D runtime record a hostile audit has to check without reverse-engineering the code: renderer backend and its migration trigger, thread topology, replay state machine, backpressure numbers, the privacy boundary and how it is mechanically enforced, fixture provenance, and the prepared hostile-audit scope. | N1 mission §18, §22-§26, §38; amendments D9, D10, D11, D18, D24 |
| `docs/vto-live-native-n1-perception.md` | N1-E provider provenance (MediaPipe Tasks Vision 1.0.0, verified current via Google Maven metadata), model bundling/no-silent-download evidence, the BodyFrame adapter boundary, and real-device inference/backpressure/privacy measurements. Split out for the same reason as the N1-C/N1-D companion docs -- regenerated from device evidence, not edited gate by gate. | N1-E mission sections 7-14, 18, 20, 23-28 |
| `docs/vto-live-native-n1-camera.md` | N1-F's own record: CameraX (Preview/ImageAnalysis) wiring design, the once-only front-camera mirror decision, the camera-boundary backpressure design (`LatestStateSlot` reused, not reinvented), the updated bridge surface, known prototype-scope constraints, and evidence tiers. Split out for the same reason as the N1-C/N1-D/N1-E companion docs. | Live VTO Native Working Prototype mission §7-§13; N1 mission §64 |
| `config/on-device-model-authority.json` | The governed registry that replaced a blanket "no model asset may exist anywhere" rule (`__tests__/mirrorExtractionContainment.test.js`), which N1-E's REQUIRED bundled offline pose model made impossible to satisfy. Byte-bound, per-artifact, DENY-by-default; also declares `modules/kscan-pii-native` categorically model-free, which the blanket rule only protected incidentally. | PR #308 CI-green repair; N1-E mission sections 10-12 (model provenance, bundled locally, no runtime download) |
| `scripts/check-on-device-model-authority.js` | The gate enforcing that registry. Pure `auditModelAssets` core so the negative controls run against synthetic fixtures instead of committing a rogue model to prove one is rejected. | PR #308 CI-green repair |
| `__tests__/onDeviceModelAuthority.test.js` | The negative controls for that gate (NC-1..NC-11): unregistered model, mutated bytes, malformed checksum, moved path, duplicate copy, wildcard approval, gutted policy, dangling record, model-free-module bypass, relaxed on-device invariants, unapproved status. Named for what it governs (repository-wide model assets) rather than squeezed under the pre-authorized `__tests__/vto*` pattern, since inaccurate naming to avoid a manifest row would defeat the point of the manifest. | PR #308 CI-green repair |
| `__tests__/mirrorExtractionContainment.test.js` | One test evolved: `no model asset was added to the repository` -> `no UNAPPROVED model asset exists in the repository`, delegating to the authority gate above. The Mirror Selfie containment contract itself is unchanged and is now enforced more strictly (the module is declared model-free, so the registry cannot authorize a bundled model for it). No other assertion in this suite was touched. | PR #308 CI-green repair |
| `app/dev-n1-diagnostic.tsx` | Temporary, `__DEV__`-only runtime-evidence probe reached via the app's existing `EXPO_PUBLIC_DEV_INITIAL_ROUTE` harness -- proves "JS finds module, getCapability() reaches Kotlin" (N1-A gate) without routing through the real auth-gated Scan Results path. Not a product surface. | N1 mission §7-§8 (N1-A required proof) |
| `package.json` | One additive dependency line, `"kscan-live-vto-native": "file:./modules/kscan-live-vto-native"` -- links the new local module for Expo autolinking, same pattern as the existing `kscan-voice-native` entry. | N1 mission §5 |
| `package-lock.json` | Lockfile update generated by `npm install` for the `package.json` change above. Not hand-edited. | N1 mission §5 |
| `android/app/src/main/AndroidManifest.xml` | N1-A build-infrastructure repair: a literal `--` inside an XML comment (line 31, the mailto `<queries>` rationale) is forbidden by the XML spec and rejected by Android's strict manifest-merger parser (`SAXParseException`, "The string \"--\" is not permitted within comments"). Blocked every local Gradle Android build, not specific to this lane's own module. Comment prose only; no permission, activity, or intent-filter changed. | N1 mission §59 (build-infrastructure repair authority); reproduced via `./gradlew :app:processDebugMainManifest --stacktrace` |
| `android/app/src/certification/AndroidManifest.xml` | Same defect class, same root cause, found by inspection once the main manifest's instance was diagnosed: six more literal `--` occurrences inside one comment block (lines 13-41). Comment prose only; no permission or manifest-merger directive changed. | N1 mission §59 |
| `evidence/vto-live-native-n1/**` | N1's own runtime-evidence set (getCapability() round-trip captures, first-render screenshots, cross-runtime conformance results as later gates close) -- derived diagnostic data only, no person imagery. Declared as its own row rather than by widening `evidence/**`, matching the `evidence/vto-phase4-gate-e/**` precedent. | N1 mission §63 |
| `docs/vto-live-bridge-contract.md` | The iOS native-runtime catch-up lane's derived shared bridge contract (module identity, real bridge surface, state enums, error taxonomy, BodyFrame policy, perception/model governance, privacy boundary) -- required by that lane's own mission before any Swift port could begin. | iOS Live VTO Native Runtime Catch-Up mission §10 |
| `.github/workflows/live-vto-ios-native-catchup.yml` | The ONE dedicated macOS CI workflow the iOS catch-up mission explicitly authorizes (`swift test` for the pure-logic Core package, `pod lib lint` for the full module) -- the only execution authority available in an environment with no local Swift/Xcode/Mac/iPhone. No deployment or submission step exists in it. | iOS Live VTO Native Runtime Catch-Up mission §9 (Tier 3) |
| `__tests__/kscanPiiNativeReleaseTargetScope.test.js` | One additive entry in its `KNOWN_PODSPECS` allowlist for the new `modules/kscan-live-vto-native/ios/KScanLiveVtoNative.podspec` -- the same governance purpose already served for `kscan-voice-native`'s podspec, applied to this lane's own new native target rather than widening the check. No other assertion in this suite was touched. | iOS Live VTO Native Runtime Catch-Up mission §14 (module registration) |

### Explicitly NOT authorized, and not touched

`supabase/functions/vto-generate/**` (read only), the Commerce
implementation, the scan/identification pipeline, checkout, closet, packing,
Elise, analytics infrastructure except the two exact audit repair files above, unrelated hooks/services/components,
deployment workflows, release credentials, and staging/production backend
configuration. `eas.json` was **read and not modified** — the Live flag is
default-OFF by absence, which needs no profile entry.

---

## How the boundary is enforced, and on which lanes

`scripts/check-vto-live-integration-scope.js` has two halves, and they bind
different things.

**The static half** — the manifest parser (every row needs a path, a reason
and a source authority), the matcher, the protected-path refusals, and the
research-workspace dependency check — is a policy control about this
repository. It is true on every branch, so it runs on every branch, inside
`Project checks` (`scripts/run-all-tests.js` →
`__tests__/vtoLiveIntegrationScope.test.js`). Nothing about it is
lane-specific and nothing about it is optional.

**The live half** — diffing a branch against the base authority above and
refusing every changed path this table does not authorize — is only a
meaningful question on a lane derived from, and answerable to, that base.

That distinction used to be missing. The guard chose its base ref by trying
`origin/integration/backend-kplus-complimentary-staging-v1`, then the local
branch, then `f2ef091`, and diffing against the first that resolved. Every
branch in this repository contains that commit, so every branch was judged
against this manifest, and every branch doing unrelated work failed for it.
That is not the boundary being strict; it is the boundary being pointed at
lanes it was never about.

Lane membership is therefore **declared, never discovered**:

```
KSCAN_VTO_SCOPE_ENFORCE=1                 this execution is a VTO lane
KSCAN_VTO_SCOPE_BASE_REF=<approved base>  the base authority to judge against
```

| SIGNAL | LIVE DIFF | STATIC CONTROLS |
| --- | --- | --- |
| absent, `0`, or `false` | reported `NOT APPLICABLE`, with the reason | run, and must pass |
| `1` or `true`, base ref resolves | **runs**; any unauthorized path FAILS | run, and must pass |
| `1` or `true`, base ref missing or empty | **FAILS** | run |
| `1` or `true`, base ref unresolvable | **FAILS** | run |
| set to anything else (`ture`, `yes`, …) | **FAILS** | run |

Enforcement fails closed in every direction. "The base ref could not be
resolved, so we are fine" is specifically not available: it would let a real
VTO lane escape its own mutation boundary by breaking one ref, and an
unrecognised value of the enforcement variable is refused rather than read as
OFF so that a typo cannot disarm the guard silently. A base ref named on the
command line still works for local use (`node
scripts/check-vto-live-integration-scope.js origin/integration/...`) and is
fail-closed the same way.

**Where enforcement happens: `.github/workflows/vto-e2e.yml`, job
`scope-guard` ("VTO scope guard (enforced)").** That job classifies the ref
and, on a VTO lane, runs both the guard CLI and
`__tests__/vtoLiveIntegrationScope.test.js` with the signal declared — so the
two live assertions are proven to *execute*, not merely to be skippable. A
pull request is a VTO lane when its branch name carries `vto`, when it
targets the integration branch named under **Base authority** above, or when
its own diff touches a VTO-owned path regardless of what the branch is
called. `__tests__/vtoScopeGuardEnforcementMode.test.js` asserts that the
integration branch the workflow compares against and the one recorded above
cannot drift apart.

That job runs on **pull requests only**, and that is a correctness
requirement rather than a cost saving. The base authority of a change is the
branch it is proposed *into*, and that only exists on a pull request. A push
is proposed into nothing, so any base chosen for it is a guess — which is the
defect being repaired. The first revision of this wiring made exactly that
mistake: on a push it fell back to the integration branch and failed a branch
for work it had legitimately inherited from its real base. Merging is gated
on the pull request, so that is where the boundary is enforced.

The general PR workflow (`.github/workflows/security-code.yml`, `Project
checks`) deliberately does **not** declare the signal. It runs on every
branch, so declaring enforcement there would restore exactly the failure this
separation exists to remove.

`__tests__/vtoScopeGuardEnforcementMode.test.js` proves both modes, every
fail-closed branch, that enforcement can never resolve to a skip, that the
discovery list cannot return, and that the CI wiring above is still present.

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
