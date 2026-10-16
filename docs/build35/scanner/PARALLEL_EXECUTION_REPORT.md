# Scanner parallel execution report

## 2026-10-16 — authority and implementation checkpoint

Owner: Scanner Intelligence & Commerce Recovery. This is the Scanner-owned,
append-only report. VTO/Elise retains the shared integration and Staging window.
No shared merge, deployment, migration, runtime-flag mutation, paid certification,
Production action, or EAS build is authorized by this report.

### Authority ledger

| Component | Observed authority | Status |
|---|---|---|
| Mobile starting source | Live GitHub `integration/build35-v1-convergence` at `c413daa783356ea8db44be816f0dc68da3889e61` | Verified |
| Backend starting source | Live GitHub `rebuild/backend-authority-v2` at `c74c99c1ee74d71486347e27a744ad0dd22c8e1a`; manifest declares sole backend deployment authority | Verified |
| Mobile Scanner/backend Scanner source | No diff between those two authority commits under `supabase/functions/scan-identify` | Verified |
| Scanner workspace | `C:/Users/jsmit/KScan/.scanner-worktree-20261016`; newly created branch `repair/scanner-intelligence-commerce-20261016`; parent repository is bare and was not reconfigured | Verified |
| Staging `scan-identify` | Management API readback: ACTIVE v81, bundle SHA-256 `79678f229c9fa8adcebaef238ee28d0b2cc4751bca0dd8c748de9df9d152d5fb`, 42 source files | Verified baseline, repairs not deployed |
| Production `scan-identify` | Management API readback: ACTIVE v173, same bundle SHA-256 as Staging | Verified baseline, repairs not deployed |
| Actual Scanner route | `hooks/useKScan.js` → Scanner request/evidence adapters → `identifyScanImage` → Supabase `scan-identify`; shipping hook explicitly removed `/api/analyze` fallback | Verified source; installed binary Not Tested |
| Configured vision routing | Allowlist defaults `gemini-3.6-flash` → one `gemini-3.5-flash-lite` fallback; Production Scanner override digests match these identifiers; Staging has no Scanner model overrides | Verified configuration; model served for #612 Not Tested |
| Staging flag overrides | Digest comparisons confirm funnel v127, recheck, multi-item, selection contract, product-match and similar-item flags true | Verified metadata; no mutation |
| Production flag overrides | Multi-item true; no overrides for backend quality/intelligence/relevance/identity/retrieval/funnel in returned secret inventory | Verified metadata; no mutation |
| Effective backend defaults | Quality tune/intelligence/relevance ON; commercial identity and retrieval enrichment OFF; funnel evaluated from its existing config and environment | Verified source/metadata; no activation change |
| #612 | OPEN, live issue readback; owner-observed New Balance-style N ignored and unrelated retailer recommendations. No original structured response or authorized New Balance fixture is included in the issue | Verified issue; photograph reproduction Blocked |

The old `docs/BACKEND_DEPLOYMENT_AUTHORITY.md` prose names a retired authority.
The live branch and `config/backend-authority.json` govern this work. Neither
manifest nor deployment automation was edited to work around that stale prose.
Open VTO/Elise PRs #611/#614 and merged entry-point attribution #608 were inspected
read-only. Scanner does not use their feature branches as release authority.

### Confirmed defects and implementation

| ID / severity | Location and confirmed cause | Repair / remaining dependency | Status |
|---|---|---|---|
| SCAN-612-01 / P1 | Default selected-item response schema in `scan-identify/index.ts` excludes all brand fields while commercial identity flag is OFF | Add optional observed-logo and wordmark fields to default schema; retain optional exact identity routing | Fixed Not Deployed |
| SCAN-612-02 / P1 | `scannerQualityGate.ts` prefers `brand_guess` over a conflicting wordmark; any logo boolean verifies arbitrary guess | Scanner-owned evidence resolver binds a named high-confidence classified logo or legible wordmark to its brand; wordmark governs; no N→New Balance rule | Fixed Not Deployed |
| SCAN-612-03 / P2 | Same gate treats actual Miu Miu wording as speculative branding | Remove real brand from speculative-noise pattern | Fixed Not Deployed |
| SCAN-612-04 / P1 | Query paths can use rejected brand guesses or untrusted model search queries | Reuse supported brand evidence and reject queries that reintroduce rejected guesses or drop confirmed branding | Fixed Not Deployed |
| SCAN-612-05 / P1 | Ranker uses substring brand/model matches, title mentions override contradictory provider brand, shipping-default brand weight can lose to generic attributes | Whole-token identity agreement, explicit provider-brand conflict precedence and relevant same-brand precedence with optional identity layer OFF | Fixed Not Deployed |
| SCAN-612-06 / P2 | Candidate validation accepts credentialed purchase URLs and malformed/negative prices | Reject those candidates using existing validators; no fabricated price or inventory | Fixed Not Deployed |
| SCAN-612-07 / P1 | Mobile identification normalizer drops logo evidence and brand/model confidence before deferred commerce | Retain bounded additive fields through normalization; shared VTO types unchanged | Fixed Not Deployed |
| SCAN-612-08 / P1 | Mobile mapper can upgrade an unsupported brand or invent it by voting across retrieved retailers; bare logo boolean grades high | Derive Scanner display brand from image evidence only; commerce cannot change selected garment identity | Fixed Not Deployed |
| SCAN-612-09 / P1 | `scanResultObject.ts` equates high visual confidence + any brand signal + a usable listing with exact-product evidence; card path synthesizes brand evidence | Remove unsupported exact inference; keep close/style results; exact remains unavailable until genuine product+variant evidence exists | Fixed Not Deployed |
| SCAN-612-10 / P2 | Purchase Options title implies product matching without exact evidence | Conservative Similar Styles heading and truthful empty copy; VTO launch/attribution and Shop/Watch interfaces preserved | Fixed Not Deployed |
| PRIVACY-LOCAL-MASK / P1 readiness | Shared `privacyImageSanitizer.js` reports passthrough, no local face/plate masking, remote transmission allowed | Escalated to release coordination here and in user update. Shared/frozen dependency; implement and independently verify applicable local masking before activating improved cloud image paths | Blocked |
| IMAGE-FIDELITY / P2 investigation | Camera quality .7 precedes shared resize 896px/JPEG .65; gallery starts at quality1. Native utility unconditionally resizes, and local harness can bypass compression when ImageMagick is missing | No frozen utility or privacy bypass. Device-level original/prepared/transmitted comparison and sanitized New Balance fixture required before attributing #612 to image loss | Blocked |
| UI-TIER-CONTRACT / P2 integration | Shared purchase-option/persisted identity contracts do not carry verified product+variant authority for exact tier | Coordinate shared contract work if three explicit tiers are required. Current package makes no exact claim and preserves VTO garment identity | Blocked |

The issue-specific earliest visual failure is still a bounded reproduction
experiment, not an asserted finding: the logo may have been lost in preparation,
omitted by the model, or excluded by the default schema. Deterministic defects
above are individually reproduced; none proves what happened in the owner's scan.

### Privacy and performance boundary

No raw-image route, higher-resolution crop, local masking bypass, provider
integration, additional model call, retry expansion, or retailer fan-out was added.
Existing selected-item session/digest reuse avoids repeat image preparation.
New evidence diagnostics use existing scan-session correlation and bounded
evidence states, attempt/model identifiers and byte length. No image content,
brand wording, model hypothesis, commerce query or destination is logged by them.

Missing masking is independent of image-recognition success. Historical protocol
permission for disclosed passthrough does not satisfy the current owner directive.
Gate 2 privacy/fidelity and later live certification gates are not certified.

### Tests and evidence recorded before completion

- Existing baseline: 397 Node tests passed, including attribution, launcher,
  multi-image, commerce hydration, persistence and harness suites.
- Initial commerce reproduction: 7/7 new cases failed before repair; expanded
  provenance/candidate suite passed after repair. A later shipping-default
  same-brand ranking regression also failed before its repair.
- Brand gate: 5/5 new regressions failed before repair, 5/5 passed afterward.
  Includes classified New Balance logo, decorative N/unnamed/uncertain/other-logo
  controls, conflicting wordmark and real Miu Miu wordmark.
- Mobile evidence retention: 2 new tests failed when replayed against pinned
  parent adapter source; both passed against repaired adapter.
- Mobile identity stability: 2 new tests failed before mapper repair; both passed
  afterward (unnamed logo and retailer-result voting cannot verify branding).
- Unsupported exact labels: 3 new SRO cases failed before repair; 236 affected
  compatibility tests passed afterward. Existing unsafe exact expectations were
  corrected; assertions were not disabled.
- Scanner backend closure: 418 passed / 0 failed with Deno runtime tests; standalone
  `deno check supabase/functions/scan-identify/index.ts` passed. Standard full typed
  runner initially could not resolve `npm:@types/node` in this isolated environment;
  its runtime equivalent used `--no-check`, not relaxed product assertions.
- Focused mobile after mapper/UI repairs: 146 passed / 0 failed, including VTO
  entry-point attribution and launcher/privacy contract coverage.
- Full Node regression, complete typed checks, exact candidate CI and final backend
  rerun are recorded in subsequent append-only checkpoints.

### Quality scorecard and live blockers

The existing authority remains
`security/release/scanner-live-certification/corpus.json` and
`docs/build35/scanner/LIVE_CERTIFICATION_PROTOCOL.md`; no threshold or budget was
changed. The historical Fashion Match Quality Lab is absent on this authority;
no second scoring authority was created. Existing sneaker fixture F is unbranded
ground truth, not the authorized #612 reference.

Deterministic counterexamples improve from failing to passing as above. These are
not estimates of real-world logo accuracy, hit@3, precision@3, wrong-brand top-3,
invalid-link rate, or Camera/Gallery performance. All those live before/after
metrics, p50/p95 processing and first-useful-result latency remain Not Tested.
The five-second goal remains a measured, non-gating product objective.

TestSprite CLI 0.5.0 is installed and authentication valid. One linked backend
project exists (`135d7e41-d894-4a28-848a-7d4f75e6dc90`). No TestSprite local-tunnel
MCP is available. Testing the old deployed version would not validate these
repairs, so TestSprite verification is Blocked / unverified-because-undeployed
until the exclusive Scanner Staging handoff; no paid run was started.

### Integration order and release verdict at this checkpoint

1. VTO/Elise closes its active window and coordinator records final integration
   SHA, workflow/deployment state, flags and rollback state.
2. Reconcile Scanner PRs against that live SHA without shared resets, force-pushes
   or autonomous conflict-resolution rebases.
3. Coordinate frozen image/privacy, purchase identity and governed manifest
   dependencies. Run combined Scanner/VTO/Elise contract checks on exact candidate.
4. Merge approved backend repair through sole backend authority, then perform
   exclusive governed Scanner Staging deployment and readback.
5. Run authorized fixtures/synthetic accounts within remaining existing budgets;
   execute TestSprite and actual Camera/Gallery, selected-item/multi-image,
   Recent Scans, Closet and Dressing Room verification on applicable devices.
6. Converge mobile candidate and mandatory CI. Prepare protected Production
   promotion, rollback and production-profile binaries only under existing owner
   approval. No existing IPA/APK is certified to include these repairs.

Current commit at checkpoint: starting `c413daa...` plus uncommitted repairs.
PRs: none yet; commits and focused PRs follow validation.
**Verdict: Fixed Not Deployed for independent repairs; release certification
Blocked. Neither Staging nor Production readiness is claimed.**

## 2026-10-16 — final source validation and split-PR preparation

Integration advanced independently to `2d76650e37b6c3bd9635e1fdaefb5711b069d459`
during this campaign. Backend authority remained `c74c99c1ee74d71486347e27a744ad0dd22c8e1a`.
Scanner did not merge, rebase, reset, force-push or adopt a VTO feature branch.
Reconciliation against the newer integration SHA remains coordinator work.

Backend repairs were copied, file-for-file, into a second Scanner-owned worktree:
`C:/Users/jsmit/KScan/.scanner-backend-worktree-20261016`, branch
`repair/scanner-backend-intelligence-20261016`, based on exact backend authority
`c74c99c1...`. This branch is a repair proposal, not a second deployment authority.
Neither copy is deployed. Shared deployment/parity manifests remain frozen.

Additional confirmed repairs:

- **SCAN-612-11 / P1:** commerce interprets "low top sneaker" as an apparel top
  and removes a valid shoe. A bounded Scanner commerce adapter recognizes
  low/mid/high-top shoe collar descriptions while retaining genuine apparel and
  conflicting explicit provider-category rejection. Shared taxonomy unchanged.
- **SCAN-612-12 / P2:** filler stripping removes a confirmed **On** brand from
  queries. Preserve the confirmed leading brand phrase through existing bounded
  cleanup; attribute stopwords, neutral fallback and query word caps unchanged.
- **SCAN-612-13 / P1:** frozen V1/V2 identity normalizers can lose a classified
  logo without a redundant guess, or prefer a conflicting guess. Scanner-owned
  projections now reconcile the supported brand before those existing contracts,
  including optional quality/intelligence OFF. No shared type/normalizer edit.
  Real saveScan/loadLibrary round-trip preserves New Balance, sneaker subtype,
  and burgundy color independently of other-brand shopping options.

Parallel isolation refinements:

- New Scanner prompt, response-schema additions, diagnostic logging and identity
  projection exclude known Elise entry paths/sources and TextScan.
- The quality gate has a request-scope parameter preserving legacy non-Scanner
  brand behavior; it is not a new deployment flag. Five isolation regressions
  failed before this preservation fix and pass afterward.
- Scanner's existing camera/gallery mapper source option selects the new brand
  behavior. Existing Elise callers omit that option and retain their mapping.
- Shop, Watch, garment identifier, launch origin and VTO attribution contracts
  remain unchanged. No VTO/Elise-owned implementation or ledger was edited.

### Final local validation

| Check | Result / limitation |
|---|---|
| Standard typed `node scripts/run-backend-tests.js scan-identify` on combined repair source | **433 passed, 0 failed**; resolves initial dependency issue |
| `deno check supabase/functions/scan-identify/index.ts` | Passed |
| `tsc --noEmit -p tsconfig.json` after isolated pinned npm install | Passed |
| Final directly affected Scanner + VTO attribution/launcher/persistence suites (21 files) | **442 passed, 0 failed, 0 skipped** |
| New Balance real local library save/reopen | Passed through real normalizer, mapper, library and JSON reload; only device storage/cloud edges substituted |
| Historical Git-object failure triage | **41 passed, 0 failed** outside sandbox; both earlier historical-source failures were access failures |
| Full Node run after pinned dependency installation | 602 files, 11,060 tests; 10,953 passed, 8 failed, 99 skipped. Includes interim combined source, not a release candidate certification |
| Remaining full-run failures | Six manifest/parity failures caused by intentionally unmodified frozen metadata; two historical-object access failures passed the separate 41-test rerun. The runner also reports its two pre-existing known parity identities; nothing was re-baselined |
| Governed deployment manifest currency | Fails as expected after backend source changes; coordinator must authorize regeneration and review |
| Cross-path parity manifest currency | Fails after governed Scanner code changes; coordinator must authorize regeneration and review |
| `git diff --check` | Passed outside sandbox; sandbox loose-object access failures are not source whitespace defects |
| Package/dependency policy | Isolated `npm ci --ignore-scripts --no-audit --no-fund`; package.json/package-lock.json unchanged; no dependency upgrade or Elise asset hook executed |
| Live model/provider accuracy, corpus quality metrics and p50/p95 | Not Tested; no paid-provider request issued |
| TestSprite | Blocked / unverified-because-undeployed; linked backend project/auth preflight verified, no old-build run misrepresented as repair validation |
| Android/iOS Camera/Gallery installed binary | Not Tested; no emulator takeover, production build or store submission |

Exact focused mobile command:

```text
node --test __tests__/scannerBrandEvidenceRegression.test.js __tests__/scanIdentification.test.js __tests__/scannerIdentificationV2Migration.test.js __tests__/recentScansCommerceActualRoundTrip.test.js __tests__/scanResultObject.test.js __tests__/scanResultActivation.test.js __tests__/vtoEntryPointTaxonomy.test.js __tests__/vtoPrivacyAndWiring.test.js __tests__/vtoContractParity.test.js __tests__/vtoShippedSurfaceReach.test.js __tests__/vtoTryOnStudio.test.js __tests__/build35OwnedVtoClient.test.js __tests__/multiImageScannerHookMatrix.test.js __tests__/multiImageScannerBatchOrchestration.test.js __tests__/multiItemCommerceItemBinding.test.js __tests__/multiImageResultPersistence.test.js __tests__/multiItemCommercePersistence.test.js __tests__/commerceHydrationV127.test.js __tests__/commerceDestinationClaimTruth.test.js __tests__/commerceShelfWiring.test.js __tests__/commerce/productShelfUxContract.test.js
```

### Files in the repair proposals

Mobile: `services/scanIdentification.ts`, `services/scanIdentificationMapper.ts`,
`services/scanResultObject.ts`, `components/scan-results/PurchaseOptionsPanel.tsx`,
and tests `scannerBrandEvidenceRegression`, `scanIdentification`, `scanResultObject`,
`scanResultActivation`, `recentScansCommerceActualRoundTrip` under `__tests__`.

Backend, all under `supabase/functions/scan-identify/`: `brandEvidence.ts`,
`index.ts`, `multiItemGarments.ts`, `scannerQualityGate.ts`,
`commerceRelevanceAgreement.ts`, `commerceRelevanceQueries.ts`,
`qualityTuneCommerce.ts`; tests `brandEvidence.test.ts`,
`scannerBrandIsolation.test.ts`, `commerceBrandProvenance.test.ts`,
`commerceIdentity.v124.test.ts`, `commerceRelevance.test.ts`.

This Scanner-owned report accompanies both proposals. No shared manifest,
runtime flag, auth/storage policy, EAS profile, shared image utility, shared
purchase/VTO type, or VTO/Elise feature file is included.

### Remaining explicit release blockers

1. **P1 privacy readiness:** missing local masking in shared sanitizer. Coordinator
   repair and independent privacy verification required; no image-fidelity success
   waives this blocker.
2. **P1 #612 live reproduction/certification:** authorized sanitized reference is
   absent from the current corpus; actual original/prepared/transmitted fidelity,
   served model output, negative-logo visual controls and provider inventory must
   be measured during the exclusive window. Prompt/structured-fixture tests cannot
   certify that photograph recognized.
3. **P2 governed metadata:** stale edge/cross-path manifests. Regenerate only with
   coordinator authorization; exact candidate CI must pass afterward. PRs remain
   drafts rather than falsely merge-ready.
4. **P2 explicit three-tier presentation:** shared purchase/persistence contracts
   lack verified product+variant evidence. Current exact inference is removed and
   the panel says Similar Styles. Any future Exact Match or fully persisted
   same-brand tier needs coordinated evidence-contract work, not retailer identity
   or visual confidence alone. Full logo description/confidence persistence also
   needs shared schema coordination; supported saved brand identity is tested.
5. **Integration/release:** explicit Staging handoff, remaining budget readback,
   deployed byte/flag verification, TestSprite, actual mobile/device verification,
   combined exact-SHA CI and protected owner-approved Production/binary actions.

Source repairs: **Fixed Not Deployed**. Local stated tests: **Verified**.
Staging/Production activation and release readiness: **Blocked**.
Real-photo quality/latency and installed binaries: **Not Tested**.

## 2026-10-16 — pre-commit authority validation

The separated backend-authority repair worktree independently passed the standard
typed Scanner runner: **433 passed / 0 failed**, plus `deno check`.
Mobile's final directly affected suite passed **442/442**. Historical-object
triage passed **41/41** with readable Git objects. Package and lockfile diffs are
empty. Backend source is present only as an unstaged integration-test copy in the
mobile worktree pending cleanup after the split commits.

File-list correction: `__tests__/scanIdentification.test.js` ultimately remains
unchanged; its legacy positive fixture was restored to preserve non-Scanner
coverage. New Scanner-specific assertions live in `scannerBrandEvidenceRegression`.
No asserted threshold or test-failure baseline was changed.
