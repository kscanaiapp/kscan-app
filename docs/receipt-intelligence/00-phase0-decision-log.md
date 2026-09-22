# Receipt & Purchase Intelligence V1 — Phase 0 decision log

**Verdict: `HOLD_PRIVACY_ARCHITECTURE`**, plus a second owner ruling needed on
Closet ownership (see §4). No feature source was written. The Phase 0 privacy
gate runs before the feature build, and it did not pass.

## 1. Authority

| Item | Value |
|---|---|
| Build 35 accepted line | `fix/notifications-final-convergence-v1` |
| Base SHA (= upstream) | `d66f03d6126bdfb65bfa0301bf8474d2e584a544` (PR #414 merge, 2026-09-14) |
| Lane branch | `feature/build35-receipt-intelligence-v1` |
| Worktree | `C:/src/B35-RECEIPT-20260922` (fresh, clean, `npm ci` done) |
| Backend authority | `rebuild/backend-authority-v2` (not touched) |
| Production | not touched. No deploy, no flag, no EAS. |

## 2. Parallel-lane fence

```
ACTIVE_SHARED_SURFACE_LANES=[#427 feature/build35-cross-platform-haptics-optimistic-ui]
RECEIPT_LANE_OWNED_FILES=[docs/receipt-intelligence/**]
SHARED_SURFACE_FOLLOWUP_REQUIRED=YES
```

- #427 (open, based on the Build 35 line) touches `hooks/useClosetCandidates.js`,
  which is the Closet candidate intake hook a receipt review flow would sit next
  to. It also owns the shared haptic authority named in §40 of the spec. That
  authority is not on the base yet, so only `services/haptics.js` exists today.
- The Closet Productization lanes (#335, #336, #337) are **merged**. The Closet
  record contract has no active owner, so extending it is allowed. It is still a
  shared contract, with a client allowlist, a JSON schema and a server `CHECK`,
  so any extension needs a deliberate schema bump.
- Merge order if the feature resumes: land #427 first, then rebase this lane.

## 3. Decision log

| Probe | Path inspected | Capability found | Decision | Fallback/HOLD |
|---|---|---|---|---|
| 3.1 Closet ownership authority | `services/closetLibrary.js#createClosetItem` (L892) | This is the only ownership write. It is actor-scoped, allowlisted by `buildClosetRecord`, and idempotent on `sourceCandidateId` and `sourceLineageId`. | `CLOSET_OWNERSHIP_AUTHORITY=services/closetLibrary.js#createClosetItem` | — |
| 3.1 Media requirement | same, L904 | **`sourceUri` is required.** With no image the write fails with `missing_source_media`. Every item gets `imageUri` and `thumbnailUri` from a garment image. | A receipt-only item has no garment image. Spec §25 forbids putting the receipt image in the Closet. | **Owner ruling needed** (§4) |
| 3.1 Purchase metadata | `buildClosetRecord` (L181); `services/closet/closetContractSchema.json` (`additionalProperties:false`) | No merchant, price, currency, purchase date, SKU, GTIN, return deadline or per-field provenance fields. Unknown draft keys are **dropped by design**. `createdAt` is documented as "NOT a purchase date". | Purchase provenance needs Closet record schema v3, a contract-schema change and a mirror migration. | Scoped follow-up |
| 3.1 Origin vocabulary | `CLOSET_ORIGINS` (L64); `supabase/migrations/20260829203657_user_closet_items.sql` L54 | `origin in ('direct_intake','recent_scan')` is enforced by a server `CHECK`. | A `purchase_import` origin needs a narrowly justified migration. | Scoped follow-up |
| 3.1 Candidate staging | `types/closetCandidate.ts` | `receipt_screenshot` and `forwarded_receipt` are already **declared** sources. They are **not** in `CLOSET_CANDIDATE_ACTIVE_SOURCES`. Candidates are image-centred too (`candidateImageUri`, content hash of the normalized JPEG). | This is the intended reuse point. It still needs a garment image. | — |
| 3.1 Mirror source map | `__tests__/closetMirrorContractActivation.test.js` L246 | `receipt_screenshot` is asserted to **fail closed** in `closetEntryPathKeyForSource`. | Keep it that way until a governed path exists. | — |
| 3.2 Minimum receipt-only identity | as above | title + category + ownerId + **image**. There is no image-free item. | `RECEIPT_ONLY_MINIMUM_IDENTITY=title, category, garment image (required by createClosetItem)` | `HOLD_CLOSET_OWNERSHIP_ARCHITECTURE`-class finding, §4 |
| 3.3 Quantity | `buildClosetRecord`, mirror table | No quantity field. Each `createClosetItem` call with no lineage creates one record. | `CLOSET_QUANTITY_SEMANTICS=MULTIPLE_IDENTICAL_ITEMS` | — |
| 3.4 Product identity | Closet record, mirror table, candidate type | No product reference, retailer ID, URL, SKU, UPC/EAN/GTIN or canonical product ID on owned items. Dedupe is exact only: candidate provenance, lineage, and sha256 of normalized media. | `PURCHASE_IDENTITY_CAPABILITY=NONE on owned items`. SKU/GTIN could only be retained as provenance after a schema bump. They are never a global identity. | No fabricated identity |
| 3.5 Extraction provider | `supabase/functions/_shared/llmModelRouting.ts`; `scan-identify/index.ts` L192 | Google Gemini Developer API (`generativelanguage.googleapis.com`, API key). The model is `gemini-3.6-flash` with a `gemini-3.5-flash-lite` fallback. | `RECEIPT_EXTRACTION_PROVIDER=Gemini via governed Edge Function (existing)`, `PROVIDER_ACCEPTS_IMAGE=YES`, `PROVIDER_ACCEPTS_TEXT=YES` | — |
| 3.5 Provider terms | repo-wide search for DPA, retention, training and processing-contract records; `docs/privacy-data-management.md`; `docs/play-store-readiness-notes.md` L114 | **No recorded processing contract.** The only record is a disclosure line: "Google Gemini / AI-provider image processing for app functionality". Gemini API data use depends on account and billing tier, and nothing in the repo verifies which tier applies. `docs/vto-provider-benchmark.md` records "DPA available? UNKNOWN" for the VTO provider class. | `PROVIDER_RAW_INPUT_RETENTION=UNVERIFIED`, `PROVIDER_TRAINING_USE=UNVERIFIED`, `PROVIDER_PROCESSING_CONTRACT_VERIFIED=NO` | Not inferred, per spec |
| 4 On-device text redaction | `modules/kscan-pii-native/**` | Face masking (inactive) and person detection. The only text capability is plate screening with `VNDetectTextRectanglesRequest`, which **deliberately does not read text**, so it cannot tell a card number from a line item. It is `platforms:["apple"]` only, and there is no Android text path. No OCR dependency is in `package.json`. | `ON_DEVICE_TEXT_REDACTION_AVAILABLE=NO` | — |
| 5 Privacy path | §4 and §3.5 | Path A needs local redaction, which does not exist. Path B needs a verified provider contract, which does not exist. | `PII_MINIMIZATION_PATH=NONE_SUPPORTABLE` | **`HOLD_PRIVACY_ARCHITECTURE`** |
| 7 Input bounds | `scan-identify/index.ts` L182 | `MAX_IMAGE_BASE64_BYTES = 2 MiB` on the existing path | `MAX_IMAGE_BYTES` would inherit 2 MiB base64. `PDF_RECEIPT_SUPPORT=DEFERRED`. | — |
| 30 Return reminders | `services/watchlist/pushRegistration.ts` | Only server-driven remote push (Watchlist). No local scheduled-notification authority. | `RETURN_REMINDERS_V1=DEFERRED` | — |
| 34 Rate / cost | `supabase/functions/_shared/security/quota.ts`, `aiSecurity/abuseControls.ts` | Actor-scoped `reserve_provider_request` RPCs exist and are reusable. | Would reuse them. No new infrastructure. | — |
| 37 Flag | `constants/featureFlags.ts` | The Closet flags follow the `EXPO_PUBLIC_*_V1 === 'true'` fail-closed pattern. | `EXPO_PUBLIC_RECEIPT_INTELLIGENCE_V1`, default OFF (not created) | — |
| 40 Haptics | `services/haptics.js`; PR #427 | The Build 35 shared haptic authority is **unmerged** (#427). | Reuse after #427 lands | — |

## 4. Why this stops here

### Privacy (the governing HOLD)

Receipt imagery carries names, addresses, emails, order numbers and card
fragments. The spec allows cloud extraction only through:

- **A.** local text redaction. It does not exist: the only text detector finds
  text-shaped rectangles without reading them, and only on iOS.
- **B.** a required user crop plus a **verified** governed provider contract.
  No verified contract is recorded. A user crop reduces exposure, but it
  cannot guarantee that sensitive text is gone (spec §4). Without a verified
  retention and training posture there is no governed basis for the residual
  data that does get through.

Neither holds, so under the spec this is Path C. Choosing between owner options
A, B and C below is a product and legal decision the build agent may not make.

### Closet ownership (second ruling, needed before build either way)

Even with privacy cleared, a receipt line has **no garment image**, and
`createClosetItem` requires one. The receipt crop cannot stand in for it
(spec §25). The honest options:

1. **Receipt metadata + user-attached garment photo.** At review, each
   confirmed line needs a camera or gallery photo of the garment. This uses
   `createClosetItem` unchanged. It adds friction, but it is truthful.
2. **Image-optional Closet items.** This changes the ownership contract, the
   grid, media sync (`user_closet_items_media`), restore, and every consumer
   that assumes `imageUri`. It is a Closet architecture lane of its own.

Both options need Closet record schema v3 (purchase provenance fields), a
`closetContractSchema.json` update, and a migration that widens the `origin`
CHECK to add `purchase_import` and adds purchase columns to the mirror.

## 5. Owner options (privacy)

- **A.** Record a governed processing contract for Gemini: confirm the
  billing/paid tier of the key used by Edge Functions, capture the retention
  and training terms, get legal review for the receipt data class, and update
  the privacy disclosure. Build then proceeds on **Path B** (required crop,
  metadata strip, governed provider).
- **B.** Build on-device OCR and text redaction as a prerequisite lane (ML Kit
  Text Recognition and Apple `VNRecognizeTextRequest`, both OS-resident, within
  the on-device model authority). Build then proceeds on **Path A**.
- **C.** Defer Receipt Intelligence.

## 6. Not done, by design

No source, tests, migration, Edge Function, flag, fixture or telemetry was
added. No production, staging or EAS action was taken. Waitlist governance
(§45) was not touched.
