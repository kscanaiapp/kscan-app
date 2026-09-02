# K SCAN AI — BUILD 34 MULTI-IMAGE SCANNER + SCAN RESULTS DEEP AUDIT

Date: 2026-09-02

---

## A. AUTHORITY

| | |
|---|---|
| SOURCE BRANCH | `origin/integration/backend-kplus-complimentary-staging-v1` |
| SOURCE SHA | `6e7e0053184fbc3973765de51b92d4f5bba49d08` |
| AUDIT BRANCH | `audit/build34-scanner-multiimage-deep-20260902` |
| WORKTREE | `C:/src/AUDIT-B34-SCANNER-20260902` (isolated; primary workspace untouched) |
| WORKTREE CLEAN AT START | yes |
| LIVE TARGET | App Staging `yzqjvdfgefveprobvvyw` only. Production never contacted. |

### Scope correction that reframes this audit

**There is no multi-image capture path in Build 34.** `hooks/useKScan.js` opens the
gallery with `allowsMultipleSelection: false`, `createScanSession()` takes exactly one
source URI, and `prepareScannerEvidence` is documented as "ONE evidence object per HTTP
request. iOS Scanner is single-image." The backend receives one image per request and
issues exactly one Gemini call per request.

What ships is **single-image, multi-ITEM**: one photo → up to five detected garments.
Every "multi-image" section of the brief has been audited against that contract, and the
image→item invariant is audited as the candidate→item→commerce invariant.

### Deployed flag state (App Staging, read from secret digests; `sha256("true")` = `b5bea41b…`)

| Flag | Value | Effect |
|---|---|---|
| `SCAN_MULTI_ITEM_ENABLED` | **true** | multi-item detection live |
| `BACKEND_COMMERCE_FUNNEL_V127_ENABLED` | **true** | commerce deferred off the scan critical path |
| `BACKEND_QUALITY_TUNE_ENABLED` | absent → default **true** | v120 on |
| `BACKEND_SCANNER_INTELLIGENCE_ENABLED` | absent → default **true** | v121 on |
| `BACKEND_COMMERCE_RELEVANCE_ENABLED` | absent → default **true** | v122 on |
| `BACKEND_COMMERCE_IDENTITY_ENABLED` | absent → default **false** | v124 brand/exact-hypothesis **off** |
| `BACKEND_COMMERCE_RETRIEVAL_V125_ENABLED` | absent → default **false** | v125 **off** |
| `EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED` | **not set in any eas.json profile** | Scanner V2 contract is **dark code**; the legacy contract ships |

The entire `scannerIdentificationV2` / evidence-correlation / `detectionDigest` layer is
unreachable in every shipped profile. This audit therefore evaluated the **legacy**
request path, which is what users run.

---

## B. ARCHITECTURE (as measured, not as documented)

```
CAPTURE / GALLERY  (single image, allowsMultipleSelection: false)
  → compressForUpload      resize to 896px wide, JPEG, base64
  → sanitizeImageBeforeUpload   PASSTHROUGH (see J)
  → prepareScannerEvidence      one evidence id per session
  → POST scan-identify  { imageBase64, source, localPrivacyFiltered,
                          multiItemDetection, requestMode, scanSessionId,
                          imageDigestPrefix, clientTimestamp }
  → ONE Gemini call  (gemini-3.6-flash, 14 s timeout, 2048 max output tokens)
  → sanitizeDetectedGarments   ≤5 garments, deterministic candidateId
  → applyQualityTaxonomyTune → applyScannerQualityGate  (per garment)
  → response: detectedGarments[] + primary identification + commerce meta
CLIENT
  → mapScanIdentifyToAnalysis → confirmationCandidates
  → RESULT PAINTS HERE
  → per-candidate MODE B commerce (commerce_only, no image, ≤1.9 s each)
  → PurchaseOptionsPanel / MultiItemCommerceSection
  → user selects a candidate → second Gemini call (selected_item) → full attributes
```

| Stage | Authority |
|---|---|
| IMAGE | `hooks/useKScan.js`, `services/imageUtils.js` |
| AI | `supabase/functions/scan-identify/index.ts`; model routing allowlist-bound in `_shared/llmModelRouting.ts` (gemini-3.6-flash primary, gemini-3.5-flash-lite fallback; 1.x/2.x explicitly blocked) |
| ITEM EXTRACTION | `multiItemGarments.ts` (`sanitizeDetectedGarments`) |
| BRAND | `scannerQualityGate.ts` (v124 evidence grading — **off** in staging) |
| COMMERCE QUERY | `commerceRelevanceQueries.ts` + `commerceRelevanceColorMaterial.ts` |
| PROVIDERS | `shoppingProvider.ts` (Serper, Brave), `poshmarkProvider.ts`, URL-only enrichment via `farfetch3Provider.ts` / `kicksCrewProvider.ts` |
| NORMALIZATION | `qualityTuneCommerce.ts`, `canonicalCommerce.ts` |
| RESULT UI | `components/scan-results/ScanResultV2.tsx`, `MultiItemCommerceSection.tsx`, `PurchaseOptionsPanel.tsx` |
| SAVE | `app.js` effects → `saveScan` / `saveMultiItemScan`, actor-scoped |

---

## C. MULTI-ITEM

| Property | Result |
|---|---|
| IMAGE→ITEM | PASS. One image per session; every candidate carries its own `candidateId`, bounds and identification. |
| ITEM→COMMERCE | **P1 FOUND AND REPAIRED** (SCAN-003) — see N. |
| ITEM ORDER | Stable. Model is instructed top-to-bottom then left-to-right; `sanitizeDetectedGarments` preserves array order and stamps `order: index`. Cards render in that order; async completion cannot reorder them (they are keyed by `candidateId`, not by completion). |
| PARTIAL FAILURE | PASS. `Promise.allSettled` per candidate; a rejected garment produces no card and never inherits a sibling's. Now pinned by `multiItemCommerceItemBinding.test.js`. |
| RETRY | PASS. `retryCommerce` / `retryMultiItemCommerce` issue MODE B only — never a second Gemini call. Whole-session retry re-enters `preview`, and `analyzeSelectedCandidate` reuses the SAME prepared derivative and evidence id (nothing recompressed). |
| STALE RESPONSE | PASS after coverage repair. Independent generation guards for scan, single-item commerce and multi-item commerce. The multi-item guard had **no test**; now pinned by `multiItemCommerceStaleGeneration.test.js`. |
| SESSION ISOLATION | PASS. `startInFlight()` bumps every generation and clears both shelves; `dismissResult`/`retake` null the session. |
| ACTOR ISOLATION | PASS. `createActorRequest()` captures (actorId, actorEpoch, requestId) before each async write; `isActorRequestCurrent()` gates the state write and the persistence layer rejects a write whose actor changed. |
| DOUBLE TAP | PASS. Synchronous `scanInFlightRef` lock read before React re-renders; every entry point (capture, gallery, upload, analyze, retry, retake, dismiss) checks it and emits a `scan_duplicate_blocked` diagnostic. |

---

## D. ACCURACY

### Corpus — stated exactly

**8 images** (`assets/qa_fixtures/`): 7 fashion + 1 non-fashion control. **13 detected
garments.** This is the only visual corpus in the repository. `__tests__/fixtures/scanAccuracyCases.js`
(37 category cases) is a **text proxy** — it exercises `normalizeCategory`, not vision.

**No statistical accuracy claim is made.** The corpus does not support one. Ground truth
available is the category encoded in each filename; the fixture images were not visually
inspected during this audit, so colour, pattern, silhouette and material could not be
scored against truth and are reported as *unverified*, not as passes.

### Live results (App Staging, `multi_item_detection`)

| Fixture | Tier | ms | Detected | Primary category |
|---|---|---|---|---|
| outerwear.jpg | EASY | 13 983 | leather jacket, turtleneck sweater | jacket ✓ |
| footwear.jpg | EASY | 7 667 | low-top sneakers | footwear ✓ |
| dress.jpg | EASY | 8 478 | wedding dress | dress ✓ |
| top.jpg | EASY | 8 829 | hoodie, jeans | tops ✓ |
| bottom_jeans.jpg | MEDIUM | 9 592 | T-shirt, jeans, sneakers | top ✗ (see below) |
| bottom_skirt.jpg | MEDIUM | 9 312 | track jacket, denim mini skirt | jacket ✗ (see below) |
| accessory.jpg | MEDIUM | 9 456 | crossbody bag, aviator sunglasses | bag ✓ |
| non_fashion.jpg | CONTROL | 6 250 | — | `non_fashion` ✓ |

- **Expected-garment recall: 8/8.** In both filename mismatches the expected garment *was*
  detected — as candidate 2. The mismatch is which garment becomes *primary*, and that
  follows the prompt's deterministic top-to-bottom rule, not a detection failure.
- **Primary-vs-filename category: 6/8.**
- **False items: 0.** No fabricated garment in 13.
- **Non-fashion control: correct**, with `detectedGarments: []` and no commerce.
- **Multi-item recall:** 2–3 garments found in 4 of 7 fashion images.

### Attributes on the detection pass

| Attribute | Present on the 13 detected garments |
|---|---|
| category / subtype / primary_color / visual_observation / bounds / confidence | 13/13 |
| **pattern, silhouette, fit, material_estimate, length, sleeve, neckline, closure** | **0/13** |

This is by design — the detection prompt says "Keep each candidate compact. Do not return
full styling analysis." Those attributes only exist after the user picks an item and a
*second* Gemini call runs. **Consequence: every multi-item commerce card is searched with
category + subtype + colour only.** That is the single biggest limiter on multi-item
Top-3 quality, and it is the reason SCAN-006 mattered so much (see F).

### Taxonomy accuracy

`bottom_skirt.jpg` candidate 2, "denim mini skirt", came back with `category: "dress"`.
Skirt has no mapping in `normalizeCategory` — see SCAN-007.

---

## E. BRAND TRUTH

| | |
|---|---|
| VISIBLE EVIDENCE | `visible_brand_text` / `logo_detected` are schema fields on the selected-item pass only. Zero brand claims appeared across all 13 detected garments — the model returned no brand where none was visible. |
| WEAK EVIDENCE | v124 grading (`verified` / `plausible` / `weak` / `invalid`) exists and is correct, but `BACKEND_COMMERCE_IDENTITY_ENABLED` is **off** in staging, so no graded brand reaches ranking today. `brand_guess` is nulled when unsupported. |
| NO EVIDENCE | Correct behaviour observed: no brand field emitted at all rather than a guess. |
| AUTHENTICITY BOUNDARY | **PASS.** No user-facing authenticity language anywhere. The only occurrences of "authentic"/"genuine" in scanner source are **stop-words being stripped from provider titles** (`canonicalCommerce.ts:62`, `scanCommerceRouter.ts:319`) and a material regex. |
| CROSS-ITEM LEAKAGE | **FAILED — P1 (SCAN-003), repaired.** Not brand leakage but identity leakage: garment 2 rendered under garment 1's label. |
| PEOPLE | The prompt forbids identifying people and forbids inferring age, race, gender identity, body type, health, religion or income. The in-app privacy screen's claim "not designed for facial recognition or identifying people" is consistent with implementation. |

---

## F. COMMERCE

### Live MODE B measurements (13 detected garments + a 5-arm ablation)

| Outcome | Count | Meaning |
|---|---|---|
| products returned | 3/13 | commerce ran and matched |
| `weak_query`, `providersTried: []` | **6/13** | **no provider was ever called** — SCAN-006 |
| `timeout` (`discoveryMs` 1901–1903 vs a 1900 ms deadline) | 4/13 | providers cut off at the fast deadline |

Server logs confirm the split exactly: `weak_query` requests log
`discoveryMs=0 early=false offers=0 totalMs=4–8`; successful ones log
`discoveryMs=1037–1447 early=true offers=3–8`; timeouts log `discoveryMs=1901–1903`.

### Query construction

Real query built for a black leather jacket: **`black leather jacket fitted`** — colour,
subtype, material, silhouette; `pattern: solid` correctly excluded as non-discriminating.
Target is 3–5 key terms, hard cap 8 meaningful words.

**Hard vs soft attributes — PASS, and this is genuinely well built.**
`commerceRelevanceColorMaterial.ts` grades every material before it can reach a query:

| Certainty | Example | Primary query | Fallback query |
|---|---|---|---|
| `supported` | leather, denim, wool | included | included |
| `likely` | "likely wool" | only when quality band is high/moderate | included |
| `appearance_only` | "leather-look" | **excluded**; mapped to "faux leather" | synonym only |
| `unsupported` | **lambskin, calfskin, exotic, designer, luxury** | **excluded** | **excluded** |

Proven live: the `over_specified` ablation arm sent `material_estimate: "lambskin"` and
still returned 8 results, because `UNSUPPORTED_MATERIAL_RE` stripped it before the query
was built. Colour is graded the same way (high → canonical, low → family or omitted).

*Caveat:* `cashmere` sits in `SUPPORTED_MATERIALS` and is treated as a hard term. It is
rarely visually certain. It is protected by the fallback query, which runs when the
primary yields fewer than 3 valid products — but **only when quality-tune is enabled**. It
is enabled by default and in staging, so this is a latent, not live, risk. Recorded P4.

### Top-K (only the shelves that populated — 3 of 13, plus 2 ablation arms)

| Query | N | Category relevance | Notes |
|---|---|---|---|
| black turtleneck sweater | 8 | 5/5 turtlenecks | WHBM, H&M, Banana Republic, Macy's, Bloomingdale's |
| red low-top sneakers | 8 | 5/5 low-top sneakers | Nike, adidas, Steve Madden, Puma — **colour not evidently honoured in titles** |
| white wedding dress | 8 | 5/5 white wedding dresses | Azazie, Nadine Merabi, KissProm, JJ's House |
| blue denim mini skirt | 3 | 3/3 denim mini skirts | Hollister, AE, Edikted |
| black leather jacket fitted | 8 | 8/8 leather jackets | Abercrombie et al. |

- **Wrong category: 0/33.** **Obviously irrelevant: 0/33.**
- **Duplicates within a shelf: 0.** 31 distinct titles across 33 rows; the 2 repeats are
  the same garment queried by two different ablation arms.
- **Price present 33/33. Image present 33/33. URL present 33/33. Retailer present 33/33.**
- **Currency field: 0/33** — price is a provider display string (`"$79.99"`). Nothing is
  fabricated and nothing is converted, which is correct, but a non-US locale would render
  a bare `$`. Recorded P4.
- **Visual similarity was NOT scored** — that requires inspecting fixture and product
  imagery side by side, which this audit did not do. Reporting a similarity rate would be
  invention.

### Commercial significance (Top-3, the 5 populated shelves, product-judgement scale)

| Scan | Score | Rationale |
|---|---|---|
| wedding dress | 5 | exact category, exact colour, purchasable range |
| leather jacket | 4 | category + material family + fit all honoured |
| turtleneck sweater | 4 | category exact, wide price range, retailer diversity |
| denim mini skirt | 4 | category exact, only 3 results |
| red sneakers | 3 | right silhouette, colour not carried into results |

Mean **4.0 on the shelves that populated** — but that is 5 of 13 garments. Before the
SCAN-006 repair, **8 of 13 garments produced no shelf at all**, and 6 of those were told
"No strong shopping match found." without a search running.

---

## G. RETAILER NEUTRALITY

| | |
|---|---|
| PROVIDERS | Serper Shopping, Brave (fallback), Poshmark; Farfetch3 and KicksCrew are **URL-driven enrichment only** (neither API offers keyword search), so neither can be preferred at discovery. |
| RANKING | Provider order is a bounded parallel fan-out with a global 4.5 s deadline, then K Scan's own agreement scoring and a **soft** retailer-diversity rerank (`MAX_RESULTS_PER_RETAILER_BEFORE_DIVERSITY = 3`, promotion only when agreement ≥ 50). No hard exclusion. |
| FALLBACK FAIRNESS | PASS. Fallback preserves the same item identity and query; it replaces the primary result set only when it returns strictly more valid products. |
| AFFILIATE NEUTRALITY | PASS. No affiliate parameter, no affiliate host, no revenue term anywhere in the scanner or commerce path. `TRACKING_PARAMS` are stripped from destination URLs. |
| SOURCE TRUTH | **Qualified.** `source` is the true merchant. But **28 of 33 observed destinations were `google.com` Google Shopping listings**, 5 were `poshmark.com`, and **0 were the merchant's own site**. |
| "PARTNERS" | Correctly absent — no provider is described as a partner anywhere. |

On the destination question: the code is right and the data is thin.
`selectRetailerDestination` explicitly prefers a non-aggregator URL and keeps the
aggregator only as last resort, and `isAggregatorDestination` exists for exactly this.
Serper's current plan simply did not supply merchant offer links for these items. That is
an upstream data property, not a routing defect — recorded as SCAN-005, not repaired
(repairing it means changing provider or plan, which §89 forbids). What *was* repaired is
the false claim the UI made about it (SCAN-009).

---

## H. PRODUCT A IDENTITY

| Boundary | Result |
|---|---|
| IMAGE → ITEM | PASS |
| ITEM → LABEL | **FAILED, P1, REPAIRED** (SCAN-003) |
| ITEM → SUBTYPE / candidateId agreement | **FAILED, P2, REPAIRED** (SCAN-004) |
| ITEM → COMMERCE QUERY | PASS — now proven, not assumed (`multiItemCommerceItemBinding.test.js`) |
| COMMERCE → PRODUCT CARD | PASS — cards keyed by `candidateId`; out-of-order completion cannot rebind |
| PRODUCT IMAGE | PASS — `imageUrl` travels with its own normalized row; no shared/stale image slot exists |
| SAVE | PASS — and structurally so: on the multi-item step ScanResultV2 passes `undefined` for Save, Ask StyleChat and Add to Dressing Room, because those act on the scan rather than the selected garment. The only action offered is "Find Matches", bound to `activeCandidateId`. |
| OWNERSHIP BOUNDARY | PASS. A scan writes a Recent Scan record, never a Closet/owned record. Closet intake is a separate explicit action. No commerce click implies ownership. |
| RECENT SCANS | Multi-item sessions persist as ONE record with its candidate list (`saveMultiItemScan`), single-item as one record; the two effects are mutually exclusive on `confirmationCandidates.length`. Commerce attaches afterward under a fresh actor check. |

---

## I. PERFORMANCE

Measured live, App Staging, 8 scans; server timings from function logs.

| Segment | Measurement |
|---|---|
| Server pre-Gemini (auth, quota, validation) | ~260 ms |
| **Gemini detection call** | **4 909 – 7 256 ms** (`gemini_success elapsedMs=…`) |
| Client-observed total, capture→identification | **6 250 – 13 983 ms**, mean ≈ 9 200 ms |
| Client HUD floor | 600 ms (`MIN_ANALYSIS_MS`), only binds on sub-600 ms responses |
| MODE B commerce per item | `discoveryMs` 1 037–1 447 ms when it succeeds; hard deadline 1 900 ms |
| Enrichment hop | 6 000 ms budget, after first paint |
| Attempt ceiling | 32 000 ms client, 14 000 ms Gemini |

**FIVE-SECOND CURIOSITY GAP: NOT MET.** Time to identification is 6.2–14.0 s. The largest
delay is provider-bound: Gemini is ~74 % of wall time; transport and base64 upload account
for most of the rest; K Scan's own server work is ~260 ms. The worst case (13 983 ms)
came within 1 s of the 14 s Gemini timeout.

Commerce is *not* the bottleneck. Under v127 it is off the critical path entirely, and
after SCAN-001 the first commerce result lands ~1.0–1.9 s after the result paints.

**No latency repair was attempted, deliberately.** The available levers are the model, the
prompt size and the output schema, and §70/§87 require a measured accuracy comparison
across a governed corpus before trading accuracy for speed. An 8-image corpus cannot
demonstrate "no meaningful regression". This is recorded as SCAN-002 for owner decision
with the breakdown above.

---

## J. PRIVACY / SECURITY

| | |
|---|---|
| IMAGE TRANSIT | Resized to 896 px, JPEG, base64, over HTTPS to the Edge Function, authenticated-only. 2 MB server cap, enforced independently of the client. |
| **LOCAL PREPROCESSING** | **`services/privacyImageSanitizer.js` is a PASSTHROUGH.** `mode: 'passthrough'`, `faceDetectionAvailable: false`, `faceBlurApplied: false`, `plateMaskApplied: false`. No face blurring or plate masking occurs before upload, on either platform. `localPrivacyFiltered` is therefore always `false`. |
| Is that a defect? | **No — it is an architectural gap, correctly recorded.** No user-facing copy anywhere claims on-device face blurring or masking for the Scanner. The "On-device" labels in the app belong to Signature Style and speech recognition. Per the brief, this audit did not invent a PII engine. |
| SERVER PROCESSING | Image is held in memory for the Gemini call. `image_hash` is written as `null` in telemetry by design. |
| GEMINI INPUT | The prepared JPEG plus the prompt. No user id, no closet, no preferences. |
| ACTOR | Authenticated-only from the client (`identifyScanImage` short-circuits without a session). Server-side per-user daily quota 30 image / 50 text, verified live (`quota_allowed … count=9 limit=30`). |
| RATE LIMITS | Anonymous image 6/10 min; commerce-only 40/10 min; both sliding-window and fingerprint-based. |
| SECRETS | Backend-only. `GEMINI_API_KEY`, `SHOPPING_SERPER_API_KEY`, `SHOPPING_BRAVE_API_KEY`, `RAPIDAPI_KEY` never appear in any response or log. |
| LOGGING | **PASS.** `logUserId` is truncated to 8 hex chars. Only image *byte length* is ever logged. No base64, no JWT, no email, no raw model text, no provider payload. Client diagnostics are `__DEV__`-gated. |
| MODE B PRIVACY GATE | Strong: `PROHIBITED_IMAGE_KEYS` makes any image-shaped field a **rejected request**, not a silently-ignored one, so a client bug cannot start shipping images down the commerce route. |
| TELEMETRY | `scan_intelligence_events` is user-linked and **is** covered by account deletion (`userDataResources.ts`, `direct_delete_before_auth`, plus `on delete set null` FK). `scan_commerce_events` has no `user_id` at all — aggregate only, correlation hash only. |
| PERSONALIZATION FIREWALL | **PASS, now pinned.** Zero references to Signature Style, Closet, Packing, Concierge, Elise history or purchase history across all 14 modules that decide what a garment is or how it is searched. The request body carries 9 allowlisted fields and nothing else. |
| NON-K+ PARITY | **PASS, now pinned.** No entitlement, subscription or tier check reaches identification or retrieval. The only K+ surface in Scan Results is `<KPlusGate source="watchlist">` around the Watch button. |

---

## K. UX / ACCESSIBILITY

| | |
|---|---|
| MULTI-ITEM UX | All detected items render simultaneously as a vertical list, each card keyed by `candidateId` — there is no swipeable active-index pager, so the "swipe to item 2 and see item 1's stale cards" failure mode is structurally impossible here. |
| PARTIAL FAILURE | Per-item states are independent: `pending` / `ready` / `no_match` / `error` / `not_eligible`. `toCardStatus` already distinguishes a genuine `no_results` from a provider failure — good prior work. |
| RETRY | Whole-shelf retry, MODE B only. |
| ERROR TRUTH | Good, with the exception SCAN-001 fixed: the shelf was stating a no-match result for a search that never ran. |
| A11Y | **FAILED, P3, REPAIRED** (SCAN-008). `MultiItemCommerceSection` had zero accessibility props; up to five shelves read as one flat run of "View options for …" links, and three stacked no-match notices or Retry buttons were indistinguishable by voice. |
| CLAIM TRUTH | **FAILED, P3, REPAIRED** (SCAN-009). |
| LARGE TEXT | Item labels use `numberOfLines={1}`, so a long garment name truncates rather than pushing controls off-screen; the shelf is inside the result ScrollView. No unreachable control found. Not exercised on a device — recorded as a residual verification item. |

---

## L. TESTS

| Suite | Result |
|---|---|
| `deno test supabase/functions/scan-identify/` | **314 passed, 0 failed** (was 281 at baseline; +33 added here) |
| Focused scanner/commerce JS suites | **216 passed, 0 failed** |
| `npx tsc --noEmit` | 5 errors, **all** `TS2307 Cannot find module` for transitive-only packages absent from this worktree's partial install. **Zero** in any file this audit touched. |
| `node scripts/run-all-tests.js` | 25 failures — **19 known baseline**, 6 unexpected |

**All 6 unexpected failures are environmental**, caused by a 39-package partial
`node_modules` in this worktree: `glob` (→ `kscanPiiNativeReleaseTargetScope`, and the
Swift/XCTest assertion inside it), `image-size` (→ `stylistIdentity`), and
`expo-modules-autolinking` / `expo-modules-core` (→ the three Voice autolinking
assertions). All four are transitive-only, none is declared in `package.json`, and none
lies in a file this audit changed.

**Audit-introduced failures: 5, all resolved before this report.**
Four were the edge-function manifest/parity/drift/deploy gates reacting correctly to a
changed `scan-identify` hash — fixed by running the repo's own
`scripts/generate-edge-function-manifest.js`. The fifth was
`scanIdentifyV2Wiring.test.js` → "the legacy detection commerce skip is preserved", which
asserted `reason: 'multi_item_detection_only'` as two adjacent literals; SCAN-001 selects
that reason via a ternary. The assertion was re-pointed at the properties its own comment
describes (branch present, no inline commerce, funnel-off reason preserved), with the full
contract pinned behaviourally in `multiItemDetectionDeferral.test.ts`.

**NEW UNEXPECTED REGRESSIONS: 0.**

---

## M. NEGATIVE CONTROLS

Every control is a real mutation of production source, run against the guarding suite,
then restored. `CAUGHT` = the suite failed, as required.

| ID | Mutation | Result |
|---|---|---|
| SCAN-NC-001 | garment 2 takes garment 1's label | **CAUGHT** |
| SCAN-NC-001b | detection deferral marker removed | **CAUGHT** |
| SCAN-NC-002 | single-item commerce generation guard removed | **CAUGHT** |
| SCAN-NC-002b | multi-item generation guard removed | **MISSED → test added → CAUGHT** |
| SCAN-NC-003 | exact brand kept without visual evidence | **CAUGHT** |
| SCAN-NC-004 | Signature Style admitted into the quality gate | **CAUGHT** (test added) |
| SCAN-NC-005 | card keyed to the wrong candidate | **MISSED → test added → CAUGHT** |
| SCAN-NC-005b | card body names another candidate | **CAUGHT** (test added) |
| SCAN-NC-005c | garment searched with a sibling's identification | **CAUGHT** (test added) |
| SCAN-NC-006 | product dedupe disabled | **CAUGHT** |
| SCAN-NC-006b | weak-query gate accepts everything | **CAUGHT** |
| SCAN-NC-007 | rejected garment filled from a sibling's result | **MISSED → test added → CAUGHT** |
| SCAN-NC-008 | Scanner quality reduced for non-K+ | **CAUGHT** (test added) |
| SCAN-NC-009 | Save offered on the multi-item step | **MISSED → test added → CAUGHT** |
| SCAN-NC-009b | Find Matches falls back to the primary garment | **CAUGHT** (test added) |
| SCAN-NC-010 | detected-garment cap removed | **CAUGHT** |

**Four controls initially passed against the existing suite.** Three of them
(NC-005, NC-007, NC-009) attack the audit's central invariant — that Item A's card carries
Item A's commerce and Item A's actions. That gap is the most important *process* finding
in this audit: the invariant was correct in the code and entirely unguarded. All mutations
restored; worktree verified clean.

---

## N. FINDINGS

### P0 — none.

### P1

**SCAN-003 — garment 1's identity rendered on garment 2's card. REPAIRED.**
- LOCATION: `supabase/functions/scan-identify/index.ts`, per-garment normalization loop.
- DEFECT: reproduced live on `accessory.jpg` —
  `candidateId: "garment-2-eyewear-aviator-sunglasses"`, `label: "Blue Crossbody Bag"`,
  `subtype: ""`. A user tapping "Blue Crossbody Bag" as detected item 2 got sunglasses.
- ROOT CAUSE: `intelligenceGate` is assigned only at `i === 0` because it shapes the
  single-item commerce query read *after* the loop. The label expression inside the loop
  read that same variable, so every garment `i ≥ 1` whose own subtype the quality gate
  suppressed inherited the **primary** garment's label.
- ACCURACY IMPACT: wrong garment name on the card. COMMERCE IMPACT: the user selects a
  garment believing it is another. PRIVACY: none.
- REPAIR: each garment carries its own gate label; identity resolution extracted to
  `resolveGarmentDisplayIdentity` so it is testable behaviourally. Primary gate still
  retained unchanged for the commerce-shaping fields.
- STATUS: **REPAIRED** (`eef959a`), 7 regression tests, NC-001 confirms.

### P2

**SCAN-001 — multi-item detection told the user "no match" for a search that never ran. REPAIRED.**
- LOCATION: `index.ts`, `else if (useMultiItemDetectionProvider)` commerce branch.
- DEFECT: that branch is evaluated *before* the v127 funnel branch, so a detection
  response carried `commerceSkipped: true, reason: 'multi_item_detection_only'` and never
  `deferred: true`. Both client hydration effects are gated on `commerce.deferred === true`,
  so **neither dispatched**. With `SCAN_MULTI_ITEM_ENABLED=true` and
  `BACKEND_COMMERCE_FUNNEL_V127_ENABLED=true` — both live on staging — every detected item
  rendered "No strong shopping match found." and the Purchase Options panel rendered its
  empty state. Confirmed live on all 8 fixtures.
- REPAIR: the detection response now reports deferral when the funnel is on. Detection
  still runs **no** commerce inline — the scan critical path is untouched. Funnel-off is
  byte-identical to before.
- STATUS: **REPAIRED** (`8328312`), 4 backend + 2 client tests, NC-001b confirms.

**SCAN-004 — a subtype suppressed for retrieval erased the garment's identity. REPAIRED.**
- The quality gate empties a subtype so it cannot narrow a commerce query — correct. But
  `g.subtype` was overwritten with that empty string, so the `candidateId`
  (`…-aviator-sunglasses`) and the displayed subtype (`""`) disagreed, and the search
  degraded from "gold aviator sunglasses" to "gold eyewear".
- REPAIR: the suppressed value stays suppressed in the commerce-facing `identification`;
  only the identity fields fall back to what detection resolved. STATUS: **REPAIRED** (`eef959a`).

**SCAN-006 — 46 % of detected garments never reached a provider. REPAIRED.**
- LOCATION: `scanCommerceRouter.ts`, `isWeakQuery`.
- DEFECT: the two-meaningful-word branch decided whether a query named a garment using a
  **seven-token allowlist** — polo, blazer, handbag, sneakers, coat, dress, trench. Every
  other category was rejected before any provider call: hoodie, jeans, t-shirt, bag,
  boots, skirt, scarf, sunglasses, cardigan, loafers, tote. It bites hardest on the
  multi-item path, whose candidates carry only category + subtype + colour and so very
  often produce exactly two meaningful words.
- EVIDENCE: 6 of 13 live garments returned `weak_query` with `providersTried: []`.
  Replaying the 13 real queries through the gate: **8/13 admitted before, 13/13 after.**
- Two-term retrievability is not theoretical: "white wedding dress" is two meaningful
  words, passed only because "dress" happened to be on the list, and returned 8 products.
- REPAIR: vocabulary widened to the project's own `normalizeCategory` taxonomy. The gate
  is otherwise unchanged — all-generic queries and queries naming no garment are still
  rejected, and the existing `item_type: 'thing'` fixture still returns `weak_query` with
  zero fetches. STATUS: **REPAIRED** (`c4cbf8c`), 26 tests, NC-006b confirms.

**SCAN-002 — identification takes 6.2–14.0 s; the 5-second gap is not met. OPEN — OWNER DECISION.**
- Measured breakdown in section I: Gemini is ~74 % of wall time, K Scan server work ~260 ms.
- NOT REPAIRED, deliberately. Every lever (model, prompt size, output schema) trades
  accuracy for speed, and §70/§87 require a measured no-regression demonstration across a
  governed corpus first. An 8-image corpus cannot support that claim.
- SUGGESTED NEXT STEP: build a real visual corpus (≥100 images, tiered), then A/B a
  reduced detection output schema — `visual_observation` is 200 chars × up to 5 garments
  and is the largest output-token cost on the critical path.

### P3

**SCAN-008 — multi-item shelves were unusable by screen reader. REPAIRED** (`b618fd1`).
Each garment label is now a heading; every per-item notice and retry names its garment.
Visible copy unchanged. Negative control: stripping the props fails all four tests.

**SCAN-009 — the card promised a retailer destination it does not control. REPAIRED** (`9afd773`).
The accessibility hint said "Opens the retailer product page" while 28 of 33 destinations
were Google Shopping. Sighted users saw the honest "View Options"; screen-reader users got
the stronger claim. Hint now states what is true for every destination. Applied to both
`PurchaseOptionsPanel` and `ProductShelf` (the reopened Recent Scan surface).

**SCAN-005 — commerce destinations are aggregator listings, not merchant pages. RECORDED, NOT REPAIRED.**
28/33 `google.com`, 5/33 `poshmark.com`, 0 merchant sites. The routing logic is correct
(`selectRetailerDestination` prefers non-aggregator and `isAggregatorDestination` exists
for this); Serper's current plan did not supply merchant offer links. Repair means
changing provider or plan — forbidden by §89. **OWNER DECISION.**

**SCAN-007 — the shared taxonomy has no mapping for skirt (and 28 other garment nouns). RECORDED — INTEGRATION-BLOCKED.**
`normalizeCategory` in `_shared/scanHelpers.ts` fails to resolve skirt, jumpsuit, romper,
vest, waistcoat, swimsuit, bikini, lingerie, socks, tights, overalls, suit, tuxedo,
eyewear and others — 29 of 69 probed nouns. Observed live: a "denim mini skirt" was
categorized `dress`. Extending that function is a **cross-feature** change — TextScan,
Elise, closet intake and catalog retrieval all read it — so per the parallel-work firewall
it is recorded rather than made here. Covered for the weak-query gate only by a local set
scoped strictly to that retrievability test. **OWNER DECISION.**

### P4–P10 (record only)

| ID | SEV | LOCATION | TYPE | IMPACT | SUGGESTED FIX |
|---|---|---|---|---|---|
| SCAN-P4-01 | P4 | `commerceRelevanceColorMaterial.ts` | over-specification risk | `cashmere` is a `supported` hard search term but is rarely visually certain; protected only by the fallback query, and only while quality-tune is on | move rarely-verifiable fibres (cashmere, silk, linen) to `likely` |
| SCAN-P4-02 | P4 | `shoppingProvider.ts` / product card | price truth | no `currency` field; price is a provider display string, so a non-US locale shows a bare `$` | carry provider currency when present; never infer |
| SCAN-P4-03 | P4 | `commerceFunnelConfig.ts` | latency/relevance | `FAST_COMMERCE_DEADLINE_MS = 1900` cut off 4/13 live requests that were landing at 1.0–1.45 s — a marginal budget | measure p95 discovery, consider 2 400 ms |
| SCAN-P4-04 | P4 | `app.js` multi-item attach effect | persistence | attach key is `id:length:status`, content-insensitive, unlike the single-item key which fingerprints content | fingerprint content for symmetry |
| SCAN-P4-05 | P4 | detection prompt/schema | commerce relevance | pattern, silhouette, fit and material are absent from every detection candidate, so multi-item cards search on category+subtype+colour only | consider adding pattern + silhouette only, measured against SCAN-002 |
| SCAN-P4-06 | P4 | `scripts/smoke-scan-identify.js:24` | tooling hazard | `DEFAULT_URL` is the **production** project; running it without `EXPO_PUBLIC_SUPABASE_URL` set hits production | default to staging, require an explicit opt-in for production |
| SCAN-P4-07 | P5 | `__tests__/multiItemCommerceCriticalPath.test.js` | test validity | stubs the mapper with a literal already carrying `commerceDeferred: true`, so it could never have caught SCAN-001 | keep, but treat as a latency test only |
| SCAN-P4-08 | P5 | privacy sanitizer | architecture | passthrough; no on-device face/plate masking on either platform | product decision; no user-facing claim is currently violated |
| SCAN-P4-09 | P5 | §83 disclosures | legal | the in-app privacy screen makes no false claim, but the "images are sent to a third-party AI provider" disclosure lives outside this repo | verify the hosted policy covers it |

---

## O. REPAIRS

**Branch `audit/build34-scanner-multiimage-deep-20260902`, 7 commits, no PR opened, nothing merged.**

| Commit | Change |
|---|---|
| `8328312` | SCAN-001 — defer commerce on multi-item detection responses |
| `eef959a` | SCAN-003 / SCAN-004 — stop garment 1's identity leaking onto later garments |
| `c4cbf8c` | SCAN-006 — widen the weak-query garment vocabulary to the real taxonomy |
| `b618fd1` | SCAN-008 — per-garment accessibility on the multi-item shelf |
| `9afd773` | SCAN-009 — stop promising a retailer destination we do not control |
| `aa5cb0b` | close the four coverage gaps the negative controls exposed |
| `7af3a96` | refresh the edge manifest; re-point one V2 wiring assertion |

**FILES (production):** `supabase/functions/scan-identify/index.ts`,
`multiItemGarments.ts`, `scanCommerceRouter.ts`;
`components/scan-results/MultiItemCommerceSection.tsx`, `PurchaseOptionsPanel.tsx`;
`components/ProductShelf.tsx`; `config/edge-function-manifest.json`.

**FUNCTIONS:** the per-garment normalization loop and the detection commerce branch in
`index.ts`; new `resolveGarmentDisplayIdentity`; `isWeakQuery` + new `isGarmentNoun`.

**TESTS ADDED:** 3 Deno files (`multiItemDetectionDeferral`, `garmentDisplayIdentity`,
`weakQueryGarmentVocabulary`) and 6 JS files (`multiItemCommerceDetectionDispatch`,
`multiItemCommerceAccessibility`, `commerceDestinationClaimTruth`,
`multiItemCommerceItemBinding`, `scanResultMultiItemActionBinding`,
`scannerObjectivityFirewall`, `multiItemCommerceStaleGeneration`).

**PRODUCTION TOUCHED: NONE.** **STAGING CHANGES: NONE** — no deploy was run; the repairs
are source-only, so App Staging still exhibits SCAN-001/003/004/006 today. **EAS: not run.**

---

## P. SCORECARD

Scores are judgements over the measured evidence above, not statistics.
"After repair" reflects this branch, which is **not deployed**.

| Dimension | Before | After repair |
|---|---|---|
| SCANNER ACCURACY (category/recall) | 4 | 4 |
| ATTRIBUTE DEPTH on the multi-item path | 2 | 2 |
| MULTI-IMAGE / MULTI-ITEM CORRECTNESS | 2 | 5 |
| BRAND TRUTH | 5 | 5 |
| COMMERCE QUERY QUALITY | 3 | 4 |
| COMMERCE RELEVANCE (reach × quality) | 2 | 4 |
| COMMERCIAL SIGNIFICANCE (Top-3, populated shelves) | 4 | 4 |
| RETAILER NEUTRALITY (logic) | 5 | 5 |
| RETAILER NEUTRALITY (observed destinations) | 2 | 2 |
| PRODUCT IDENTITY | 2 | 5 |
| PRIVACY / SECURITY | 4 | 4 |
| PERFORMANCE | 2 | 2 |
| ACCESSIBILITY | 2 | 4 |

---

## Q. FINAL VERDICT

```
BUILD 34 MULTI-IMAGE SCANNER + SCAN RESULTS — CONDITIONAL / P0-P3 FIX REQUIRED
```

P0 = 0. P1 = 1, repaired. P2 = 4, three repaired and one (SCAN-002, latency) open for
owner decision. P3 = 4, two repaired and two recorded as owner decisions.

It is conditional for two reasons, not one:

1. **The repairs are not merged and not deployed.** App Staging today still returns
   detection responses with no deferral marker, still leaks garment 1's label onto
   garment 2, and still rejects 46 % of detected garments before any provider call. The
   shipped behaviour has a live P1.
2. **SCAN-002 is an unrepaired P2.** Time to identification is 6.2–14.0 s against a
   5-second product goal, and closing it responsibly needs a real corpus first.

Against §92, these pass: image→item identity, multi-item isolation, stale-response
protection, partial-failure correctness, brand evidence truth, no authenticity claims,
the personalization firewall, non-K+ accuracy parity, commerce query correctness, Product
A commerce binding, result normalization, duplicate control, retailer-neutrality logic,
save/Closet handoff identity, rate and cost bounds, a truthfully documented privacy path,
and zero new regressions. Top-3 commercial relevance is acceptable *on the shelves that
populate*; making that the common case is exactly what SCAN-006 fixes.

---

## §93. THE STRATEGIC QUESTION

> Does the additional detail produced by K Scan's fashion-specific Scanner materially
> improve the products users are shown?

**Yes — and the evidence is sharper than expected, because the failure mode is binary
rather than gradual.**

Live attribute-ablation on one garment (black leather jacket), same endpoint, same
providers, five arms:

| Arm | Query the system built | Results |
|---|---|---|
| category only | `outerwear` | **0** — `weak_query`, no provider called |
| category + colour | `black outerwear` | **0** — `weak_query`, no provider called |
| category + colour + **subtype** | `black leather jacket` | **5** (Poshmark) |
| + material, silhouette, fit, pattern | `black leather jacket fitted` | **8** (Serper) |
| + an unverifiable material (`lambskin`) | `black leather jacket fitted` | **8** — the estimate was correctly stripped |

The generic query does not merely return *worse* products. It returns **nothing at all**,
because a category-level query cannot clear the system's own relevance bar. The first
attribute that buys anything is **subtype** — "leather jacket", not "outerwear" — and
silhouette/fit then improve provider selection and result count further.

Three qualifications, stated plainly:

1. **Colour was the weakest contributor.** "red low-top sneakers" returned five correct
   low-top sneakers whose titles did not evidently honour red. Colour constrains the query
   without reliably constraining the result set.
2. **Estimated material is correctly treated as soft**, and this is a genuine strength:
   `lambskin` was stripped and cost nothing. The fashion-specific detail helps *because*
   it is graded before it reaches the query, not in spite of it.
3. **The multi-item path does not currently get this benefit.** Detection candidates carry
   no pattern, silhouette, fit or material at all, so multi-item cards run on the
   `category + colour + subtype` arm — the 5-result tier, not the 8-result tier. Closing
   that gap is SCAN-P4-05, and it trades directly against SCAN-002's latency budget.

So the fashion-specific Scanner earns its place, and the specific thing earning it is
**subtype plus construction detail**, not colour. The largest available commerce win is
not more attributes — it is making sure the attributes already extracted actually reach a
provider, which is what SCAN-006 recovers: from 8/13 garments searched to 13/13.
