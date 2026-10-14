# Build 35 Scanner live Staging certification protocol

Declared **2026-10-09, before any live Scanner request was issued**. The git history
of this file is the evidence of ordering. Thresholds and budget below are copied
verbatim from `security/release/scanner-live-certification/corpus.json`; the digest pins them and
`__tests__/scannerLiveCertificationHarness.test.js` fails if either changes without
this document changing in the same commit.

`thresholds+budget sha256: faa4e26ce8690b9440275ea9353574cc26439b771282612437b3a42b7a002946`

Nothing here is a statement about Production. Production comparison is delivered
privately (this repository is public).

## 1. Authority under test

| Item | Value |
|---|---|
| Mobile integration | `integration/build35-v1-convergence` @ `8da459e2` (PR #539 merged) |
| Backend authority | `rebuild/backend-authority-v2` @ `3db50fec` |
| Staging `scan-identify` | v80, 42/42 files byte-identical to backend authority (verified by `supabase functions download` + `cmp`, 2026-10-09) |
| Staging flags | `BACKEND_COMMERCE_FUNNEL_V127_ENABLED=true`, `SCAN_MULTI_ITEM_ENABLED=true` (secret digests compared to sha256 of `true`; values never printed) |
| Client under test | the real `hooks/useKScan.js`, transport, normaliser, mapper, `services/batchCommerceSelection.js`, `services/commerceHydration.ts`, `services/library.js` and the real `app.js` batch regions, executed in Node |
| Edge under test | the real Staging `scan-identify` over HTTPS, authenticated as the governed synthetic ACTIVE account(s) |

Only the device edges are replaced: the photo picker, `expo-image-manipulator`
(replaced by ImageMagick with the same 896 px / q0.65 settings when available), haptics.

## 2. Owner rulings that bound this run

1. **Spend:** at most 56 image-mode requests and 40 commerce-only requests in
   total, at most 28 image-mode requests per account per UTC day, Staging only.
   Enforced in code by `lib/budget.js` *before* each request leaves the machine.
   An image-mode request is one Gemini call (two if the server falls back to its
   secondary model). Cost is reported as measured call counts; current model
   pricing was not verified.
2. **Photos:** the 8 approved repo fixtures in `assets/qa_fixtures` only. One fixture
   in that directory is excluded and is never read. No other image is sent anywhere.
3. **Second account:** if `STAGING_SYNTHETIC_ACTIVE_B_*` is not present, live
   account A to B isolation is reported BLOCKED, not PASS.
4. **Privacy gate:** the disclosed passthrough state can pass. The gate is truthful
   disclosure, re-encode and metadata strip, fail-closed when preparation fails, no
   image payloads in telemetry, and actor isolation.

## 3. Phases and call budget

| Phase | What runs | Image-mode | Commerce-only |
|---|---|---|---|
| P1 base | each of the 8 photos alone: detect, then identify **every** detected garment (max 5 per photo), then MODE B per identified garment | 8 + at most 12 | at most 12 |
| P2 two-photo | O + D selected together, batch queue, MODE B per selected item (responses held so Save All runs **before** offers arrive), late offers attach to the saved record, reopen | 2 + 2 | 2 |
| P3 five-photo | O, D, F, A, N: exactly the global five-candidate bound plus one non-fashion photo; one injected network failure (zero cost, never sent), one real retry, out-of-order commerce delivery, Save All, reopen | 5 + 5 + 1 | 6 |
| P4 deferred-commerce | (e) account change while MODE B is in flight on O + D; (b) leaving the screen mid-queue aborts the rest | 4 + 3 | 2 |
| P5 funnel-off control | O + D as a two-photo batch (selected-item answers carry offers inline; no MODE B exists), only if the governed Staging flip is performed, with rollback | 4 | 0 |
| P6 post-repair re-verification | identify and shop A (sunglasses) again after the repair is deployed | 3 | 2 |
| P7 variance (optional) | D identified and shopped again; N and O detection only | 4 | 1 |
| **Planned total (before P1 results)** | | **at most 50** | **at most 22** |

Headroom (6 image-mode, 18 commerce-only) is reserved for one repair re-verification.
A phase that would exceed any cap is refused and reported, never trimmed silently.
With one synthetic account the plan fits two UTC days (day 1: P1 + P2 = 24 image-mode;
day 2: P3 + P4 + P5 + P6 = 26), each under the 28 per-day ceiling.

## 4. Scoring

### 4.1 Identification (per expected garment, ground truth in `corpus.json`)

Category correct, subtype acceptable and primary colour acceptable are token
matches against the ground truth lists, applied to the mapped analysis the app
displays. A **critical misidentification** is a primary garment returned in a
different category family from the truth with no subtype match (a jacket described
as a dress). A brand is **grounded** only if its text is listed under
`brandGrounded` for that fixture (visible logo text); any other brand claim in
`brand_guess`, `visible_brand_text` or the title is an ungrounded brand claim.
Non-fashion and distractor handling are scored separately (the book in the
accessory photo may never become a garment candidate).

### 4.2 Commerce relevance rubric (offers returned for a garment)

| Score | Meaning |
|---|---|
| 0 | Unrelated: wrong garment category or fundamentally incompatible item |
| 1 | Weak: broad category matches but visible characteristics substantially differ |
| 2 | Relevant: correct category with meaningful similarity in key attributes |
| 3 | Strong: close match in category, silhouette, colour/pattern and other distinguishing details |

Offers are scored by the certifier from the returned title, merchant, price and
destination host, in returned order, **without reordering and without knowing the
final verdict**. Product images are not retrievable by the harness, so similarity is
judged from text only; this limitation is reported. An automatic keyword pre-check
(`offerTitleAny` / `offerTitleReject`) flags probable score-0 offers but never sets
a score. Top-3 and top-5 precision count offers scoring 2 or 3.

### 4.3 Integrity (zero tolerance)

Candidate/image mix-ups, actor contamination, requests spent on unselected garments,
unintended duplicate commerce operations and saved-item source-image mismatches.

### 4.4 Latency

p50 and p95 are reported separately for detection, selected-item identification and
commerce. The 5 s time-to-useful-result goal is reported MET or NOT MET and does not
gate the verdict (Staging identification has historically taken 6-14 s, an open
owner decision); the gates are the client timeouts: 20 s per scan request and 15 s
per commerce request at p95, with zero hangs.

## 5. Verdict derivation

| Line | PASS requires |
|---|---|
| `SCANNER_SOURCE_CERTIFICATION` | Scanner suites and backend closure green apart from the recorded baseline, `tsc` clean, deployed bytes equal source |
| `SCANNER_STAGING_LIVE_TESTS` | every approved phase executed inside the caps with zero hangs and zero contract violations |
| `SCANNER_IDENTIFICATION_ACCURACY` | every threshold in `corpus.json > thresholds.identification` |
| `SCANNER_COMMERCE_RELEVANCE` | every threshold in `thresholds.commerce` |
| `SCANNER_MULTI_IMAGE_INTEGRATION` | P2-P4 pass, integrity thresholds all zero, the feature tested **enabled** |
| `SCANNER_PRIVACY_SECURITY` | rule 4 above |
| `SCANNER_ANDROID_EMULATOR` | the Scanner smoke executed on an emulator on the applicable candidate |
| `SCANNER_IOS_CODE_CERTIFICATION` | code-level suites only; physical-device evidence is never claimed |
| `SCANNER_PRODUCTION_PROMOTION_READY` | all of the above plus a documented environment comparison and no open P0/P1 |
| `OVERALL_SCANNER_CERTIFICATION` | every line above PASS |

A mandatory item that was not executed is NOT TESTED or BLOCKED and cannot count as PASS.

## 6. Known limits of this corpus (declared up front)

The approved fixtures contain no denim jacket, blazer, boots, knitwear or a
four-garment outfit, and no low-light handheld photograph beyond the gown fixture.
Those cases are reported NOT TESTED unless the owner supplies additional approved
photographs. Real-device camera/gallery ordering and HEIC/EXIF handling cannot be
shown by this harness.

## 7. Amendments (dated; thresholds and the budget digest are NOT amended)

**2026-10-09, after P1 results.** P1 spent 23 image-mode and 15 commerce-only requests, not
the planned 20 and 12: the real detector found 15 garments in the 8 photos (the ground truth
lists the required garments; the extra ones are real visible items such as the knit layer under
the jacket and the jeans under the hoodies). The cap is unchanged. Remaining: 33 image-mode and
25 commerce-only. Changes made because of what P1 showed, none of which touches a threshold:

1. Every phase now performs **one explicit commerce retry per garment whose first attempt
   returned an error** (the screen's own retry action) and records the first attempt and the
   retry separately. A retry must not issue a selected-item request (B35-SCAN-014 check 13).
   The predeclared hit@3 gate is evaluated on the **first attempt**, which is what a customer
   sees first; retry recovery is reported alongside it.
2. P6 is repurposed from variance measurement to **post-repair re-verification** (A and D were
   the garments that failed in P1) plus detection variance on N and O. P5 is a two-photo
   funnel-off batch.
3. The two P1 failures led to backend repair PR #541 (B35-SCAN-021 subtype retention,
   B35-SCAN-022 fast-path deadline). Phases P2 onward that follow a Staging deployment of that
   repair are labelled with the deployed function version in their reports.

**2026-10-09, after R1.** With actor A at 27 of its 28 image-mode requests for the UTC day, the remaining live
phases move to the next UTC day (or to a second account). To keep the verdict-critical phases inside the
28-per-day ceiling, P6 is reduced to the one check the sunglasses repair needs (A), and the variance
measurement becomes the optional P7. R1 (a paired commerce replay of the four P1 timeouts, commerce-only
requests, no Gemini) was added to verify the deadline repair deployed to Staging as scan-identify v81.
The Staging deploy that carried PR #541 was retried once after two runner-side registry throttles
(`toomanyrequests` pulling the edge-runtime image, before anything reached Staging).
