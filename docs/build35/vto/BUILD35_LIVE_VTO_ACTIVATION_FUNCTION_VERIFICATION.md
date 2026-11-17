# Build 35 — Live Camera VTO Activation & Functional Verification

Date: 2026-10-16 · Branch: `build35/live-vto-activation-20261016` · Outcome: **Phase 1 HARD STOP**

**Decision (H): NOT READY — NAMED SOURCE/ASSET/ACTIVATION BLOCKERS.**
Live flags are **not** configured ON in any build profile and were **not** changed. No activation writes
were made (no `eas.json`, no `app_config`, no native capability change). This PR contains this report only.

Status labels used throughout: VERIFIED IN SOURCE, VERIFIED IN BACKEND, VERIFIED IN NATIVE TEST,
VERIFIED ON DEVICE, CONFIGURED ON, FAILED, BLOCKED — ACCESS, BLOCKED — ASSET AUTHORING REQUIRED,
DEFERRED TO EAS DEVICE CERTIFICATION, NOT EXECUTED (Phase 1 stop).

---

## A. Source-of-truth baseline

| Item | Value | Label |
|---|---|---|
| Mobile integration authority `integration/build35-v1-convergence` | `1e5918852c948759d2dbdd954daea0b44b475d1f` (= stated baseline; merge of #624) | VERIFIED IN SOURCE |
| Backend authority `rebuild/backend-authority-v2` | `54e9c27d9e39df99b167126382fe8ed9f5f01edb` (= stated baseline) | VERIFIED IN SOURCE |
| Head-divergence gate | Neither head advanced; no concurrent open Live VTO / Scanner PRs (open PRs: #582, #566, #190, #188, #187, dependabot) | PASSED |
| Activation branch | `build35/live-vto-activation-20261016` created from the integration head; name was unoccupied | VERIFIED IN SOURCE |
| Merged repairs in base | #621, #624 (ancestors of head); #622 on backend authority | VERIFIED IN SOURCE |
| CI on integration head | iOS source certification, Release Profile Guard, Dependency Reachability, Staging Security Gate, Security (Code/Deps, Promotion, ZAP API, ZAP Baseline), VTO Backend E2E: all success | VERIFIED IN SOURCE (GitHub Actions) |
| Prior "Build 35 Integration & Activation Audit (2026-10-16)" | Not found in any branch, worktree, or on disk. The findings quoted in the assignment were used as the inventory and each was re-checked below | Verification gap |
| Supabase MCP | Not authenticated this session. `app_config` read via the app's own public anon REST path (SELECT only) | Partial access |
| RevenueCat | Not checked (Phase 2, not executed) | NOT EXECUTED |
| Edge Function versions (scan-identify, vto-generate, stylist-speech, commerce-watch-refresh) | Not re-read; carried from assignment as "last observed" | Not re-read |
| Devices / emulator | None used | DEFERRED TO EAS DEVICE CERTIFICATION |

### Audit findings re-checked

| Finding | Status now |
|---|---|
| `EXPO_PUBLIC_LIVE_VTO_ENABLED` absent from every profile | **Reproduced**, all six profiles (see B) |
| Staging `vto_generation.live.enabled=true`; Production lacks nested `live`; Photo VTO `enabled=true` both | **Reproduced** |
| Only two bundled `.ksgarment` identities (`p4-multi-image-product`, `n1c-asym-marker`) | **Reproduced**: `services/vto/vtoLiveGarmentRegistry.ts:103-130` |
| Most Scanner products cannot resolve to either | **Reproduced and strengthened**: *no* real product can (see LVA-001) |
| `physicalCertificationApproved=false` blocks capability | **Reproduced** on both platforms (LVA-002) |
| #624 per-garment rendering (no single fixture for every product) | **Preserved**; not touched |

---

## B. Live activation truth table

### Build profiles (resolved through `extends`)

| Profile | Chain | `LIVE_VTO_ENABLED` | `VTO_UI_ENABLED` | `LIVE_VTO_HARNESS` | Backend |
|---|---|---|---|---|---|
| production | production | absent → OFF | true | absent | Production |
| build35-release | production › build35-release | absent → OFF | true | absent | Production |
| build35-testing | production › production-certification › build35-testing | absent → OFF | true | absent | Production |
| production-certification | production › production-certification | absent → OFF | true | absent | Production |
| staging-certification | staging › staging-certification | absent → OFF | true | absent | Staging |
| staging | staging | absent → OFF | absent | absent | Staging |

Label: VERIFIED IN SOURCE. Two guards also pin Live OFF and would both need to change during activation:
`__tests__/vtoLiveFeatureGate.test.js:89` ("no EAS profile sets it") and
`scripts/check-build35-release-profile.js:42` (`OPTIONAL_OFF`).

### Stage separation

| Stage | Android | iOS | Label |
|---|---|---|---|
| SOURCE ON (build flag) | OFF | OFF | VERIFIED IN SOURCE |
| OPERATOR ON (`vto_generation.live.enabled`) | Staging: true · Production: absent → false | same rows | VERIFIED IN BACKEND (anon REST read) |
| NATIVE ATTEMPTABLE (`capable && runtimeReady`) | false: hard-gated by `PHYSICAL_CERTIFICATION_APPROVED=false` | false: `physicalCertificationApproved=false` | VERIFIED IN SOURCE |
| Physical certification | not_approved | not_approved | VERIFIED IN SOURCE (correct, unchanged) |
| SUPPORTED DEMO | No customer-reachable path selects a fixture productRef | same | FAILED (no honest demo entry exists) |
| REAL PRODUCT MAPPED | None | None | BLOCKED — ASSET AUTHORING REQUIRED |
| DEVICE VERIFIED | — | — | DEFERRED TO EAS DEVICE CERTIFICATION |
| CUSTOMER CERTIFIED | — | — | Not reached |
| Customer UI entry | `TryItOnEntry` → `VirtualTryOnSheet` → `useVtoLiveCapability` → `resolveVtoCapability`; Live mode never offered because the first gate (`feature_disabled`) already fails | same | VERIFIED IN SOURCE |

Even with every flag ON, the router (`services/vto/vtoLiveCapability.ts:130-159`) would return
`device_unsupported` (native `capable=false`), and for every real product `garment_unsupported`
(`asset_not_found`). Flipping flags alone would produce zero additional Live sessions. That is why no flag was flipped.

---

## C. Functional evidence chain

| Step | Evidence | Label |
|---|---|---|
| Open (entry, router) | 241/241 existing Live tests pass at `1e591885` (feature gate, registry parity, resolver, native-view mount, readiness stages, router, session state/concurrency, privacy boundary, contract promotion, Phase-4 asset gate, release profile) | VERIFIED IN SOURCE (node --test) |
| Camera | Not started; Live is never attemptable (LVA-002) | DEFERRED TO EAS DEVICE CERTIFICATION |
| Frames | — | DEFERRED TO EAS DEVICE CERTIFICATION |
| Pose | iOS verifies model SHA-256 at `initialize()`. Android checks presence only (LVA-003) | VERIFIED IN SOURCE (partial) |
| Asset | Registry ↔ bundled manifests/textures parity on both platforms (`vtoLiveGarmentRegistryParity.test.js`) | VERIFIED IN SOURCE |
| Render | iOS SwiftPM `LiveVtoCore` host tests + simulator `xcodebuild` passed on PR #624 CI (run 38933469062). Android Gradle not re-run this session | VERIFIED IN NATIVE TEST (iOS, prior run) |
| Capture | — | DEFERRED TO EAS DEVICE CERTIFICATION |
| Commerce handoff | — | NOT EXECUTED (Phase 1 stop) |

No later stage is inferred from an earlier one.

---

## D. Feature reachability matrix

**Phase 2 was not executed** because Phase 1 hard-stopped. Only the Live-critical path facts gathered during Phase 1 are recorded:

| Path segment | Finding | Label |
|---|---|---|
| Scanner → commerce product | Production commerce record `id = makeId('serper', productUrl)` (backend `supabase/functions/scan-identify/shoppingProvider.ts:384`); also `makeId('brave', …)` `:514` | VERIFIED IN SOURCE (backend authority) |
| Product → `VtoGarmentInput.productRef` | `record.id \|\| purchaseUrl \|\| imageUrl` (`services/vto/vtoCommerceGarment.ts:94-97`) | VERIFIED IN SOURCE |
| productRef → Live resolver | Exact match against two fixture productRefs → `NOT_FOUND` for every real listing | VERIFIED IN SOURCE |
| Try It On → Photo VTO | Photo VTO remains the fallback; untouched | VERIFIED IN SOURCE |
| K+ eligibility / paywall / RevenueCat keys / offering | — | NOT EXECUTED |
| Adjacent (Elise, Photo VTO, Packing, Watchlist, Closet, Dressing Rooms, Voice Scan, TextScan, deletion, multi-image) | — | NOT EXECUTED |
| Today with Elise (parent/greeting/weather) | Kept OFF; separate open product decision, not a Live blocker | Tracked, unchanged |

---

## E. Defect and failure ledger

| ID | Sev | Finding | Location | Recommended fix | Lane | EAS blocker? |
|---|---|---|---|---|---|---|
| LVA-001 | P1 | **No real product can map to a governed `.ksgarment`.** Commerce productRef is a per-scan URL hash, not a catalog identity, and the registry holds only two synthetic fixture refs. | `vtoLiveGarmentRegistry.ts:103-130`; `vtoCommerceGarment.ts:94`; backend `shoppingProvider.ts:384` | **BLOCKED — ASSET AUTHORING REQUIRED.** Needs (1) a stable product identity source: either a canonical product ID from the Canonical Product Identity work or a curated SKU list keyed by retailer product URL; (2) a Phase 4 pipeline run (`vto-phase4-pipeline/`) per chosen product producing a QA-passed `manifest.json`/`texture.png`/`alpha.png`; (3) bundling under `modules/kscan-live-vto-native/{android/src/main/assets,ios/Assets}/<assetKey>/`; (4) `LIVE_VTO_ASSET_KEY_ALLOWLIST` + `LIVE_VTO_GOVERNED_ASSETS` entries (assetKey, assetId, assetVersion, ksgarmentSchemaVersion, productRef, canonicalCategory, templateFamily, eligible, qaPassed, sourceSha256); (5) parity test extended. The resolver must match on that stable identity, not the Serper hash. | Product owner (which products) + VTO asset lane (pipeline/QA) | Yes, for any customer Live claim |
| LVA-002 | P1 | **Capability bootstrap deadlock.** `capable`/`runtimeReady` require the physical-certification constant, but certification needs a device session that can never start. | Android `LiveVtoCapabilityStages.kt:34,58`; iOS `Core/LiveVtoCapabilityStages.swift:25,53` | Separate attemptability from certification: `capable` = platform ∧ front camera ∧ verified model hash ∧ renderer prerequisite; keep `physicalCertification` as its own stage and add a release-side gate (e.g. an internal-testing allowance) that the router consults separately. Never hardcode true. Not implemented because of the Phase 1 stop (activation writes halted). | VTO native lane | Yes |
| LVA-003 | P2 | Android `modelAssetPresent` checks file presence only; no SHA-256 check at `getCapability` or pose `initialize` (iOS checks at `initialize()`). Parity gap. | `KScanLiveVtoNativeModule.kt:42-46`; `LiveVtoMediaPipePoseProvider.kt` | Verify against `config/on-device-model-authority.json` `approvedModels[0].sha256` on Android, fail closed with a specific reason | VTO native lane | Yes, before attemptability is enabled |
| LVA-004 | P2 | No static renderer-construction prerequisite in readiness stages (either platform) | Both `LiveVtoCapabilityStages` | Add a `rendererPrerequisite` stage (GL/Metal availability), unknown → false | VTO native lane | Yes, with LVA-002 |
| LVA-005 | P2 | No honest, customer-reachable supported-demo entry selects a fixture productRef | `app/`, `components/vto/` (none found) | Product decision: an explicit, labeled "Live preview garment" entry, or none. Building one is new product surface and outside this campaign | Product owner | No (only if demo is chosen) |
| LVA-006 | Config | Live build flag absent in all profiles; OFF pins in `vtoLiveFeatureGate.test.js:89` and `check-build35-release-profile.js:42` | `eas.json` | Change only after LVA-001/002 are closed; update both guards to explicit approved-profile expectations | Activation lane | n/a (correctly OFF) |
| LVA-007 | Config | Production `vto_generation` has no `live` block | Production `app_config` | Add `live.enabled` only through the governed operator route after the source blockers are closed; snapshot first; roll back only the nested key | Owner/operator | n/a (correctly OFF) |
| LVA-008 | Gap | Android native unit tests not re-run this session; no device or emulator evidence on either platform | — | Re-run Gradle `testDebugUnitTest` (assert JUnit counts) on the repair branch; device run under owner-approved certification | VTO native lane | Deferred |
| LVA-009 | Gap | Prior activation audit doc not located | — | Owner to share or commit it | Owner | No |
| ELISE-TODAY | Product | Today with Elise parent/greeting/weather flags remain OFF | `eas.json` | Separate product decision | Product owner | No |

---

## F. Repairs / CI / PR

- Source changes: **none** (Phase 1 hard stop). Changed files: this report only.
- Operator writes: **none**. Reads: `app_config?key=eq.vto_generation` on Staging and Production via the public anon REST path.
- Tests run: 12 Live/release suites, 241 pass / 0 fail / 0 skipped, at `1e591885` (`node --test`).
- Not run: TypeScript, Gradle, Swift (no source change to validate); RevenueCat, K+ and adjacent features (Phase 2 not executed).
- PR: draft, docs-only, not for merge as an activation.

## G. Rollback

Nothing was activated, so there is nothing to roll back. For a future activation PR:
`git revert -m 1 <merge-sha>`; leave `EXPO_PUBLIC_LIVE_VTO_ENABLED` unset on future builds; reset only
`vto_generation.value.live` to its prior JSON (Staging prior: `{"enabled": true, "supportedCategories": ["top"]}`;
Production prior: key absent); never touch top-level `enabled` (Photo VTO); leave backend deployments as they are.

## H. Decision

**NOT READY — NAMED SOURCE/ASSET/ACTIVATION BLOCKERS** (LVA-001 asset authoring, LVA-002 capability
deadlock, plus LVA-003/004 before attemptability). Flags are **not** configured ON, and no device certification exists.

### Owner decision matrix

| Option | What it takes | Result |
|---|---|---|
| 1. Real-product Live (customer-ready) | Choose N real products and a stable identity source; run Phase 4 per product + QA; bundle on both platforms; fix LVA-002/003/004; then flags | Earliest honest "READY FOR OWNER EAS BUILD APPROVAL" |
| 2. Supported demo only | Fix LVA-002/003/004; approve a labeled demo entry that selects an existing fixture; flags ON for an internal/testing profile only | "SUPPORTED DEMO ONLY": device testing becomes possible; not customer Live |
| 3. Defer Live from Build 35 | Nothing; Photo VTO ships as today | No regression; Live stays dark |

Recommendation: **Option 2 now, Option 1 in parallel.** Option 2 is the only way to get real-device
evidence (which Option 1 also needs) without inventing product coverage.
