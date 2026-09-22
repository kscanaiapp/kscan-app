# Receipt & Purchase Intelligence V1 — decision log

The first pass (commit `fa66795f`) stopped with `HOLD_PRIVACY_ARCHITECTURE`
and asked for two owner rulings. The owner ruled on **2026-09-22**:

> "we are on the pre-paid gemini tier and ask for a photo but proceed if they
> do not have one"

That ruling resolves both holds as described below, and the feature was built
on **Privacy Path B**.

## 1. Authority

| Item | Value |
|---|---|
| Build 35 accepted line | `fix/notifications-final-convergence-v1` @ `d66f03d6` (PR #414 merge), equal to upstream |
| Lane | `feature/build35-receipt-intelligence-v1`, worktree `C:/src/B35-RECEIPT-20260922` |
| Backend deploy authority | `rebuild/backend-authority-v2`. Not touched; nothing deployed. |
| Production / staging | Not touched. No deploy, no migration applied, no flag enabled, no EAS. |

## 2. Parallel-lane fence

```
ACTIVE_SHARED_SURFACE_LANES=[#427 feature/build35-cross-platform-haptics-optimistic-ui]
RECEIPT_LANE_OWNED_FILES=[services/purchaseImport/**, hooks/usePurchaseImport.ts,
  components/purchase-import/**, app/purchase-import/**,
  supabase/functions/purchase-import-extract/**,
  supabase/migrations/20260922190000_closet_purchase_import_origin.sql,
  docs/receipt-intelligence/**, __tests__/purchaseImport*.test.js,
  __tests__/helpers/purchaseImportHarness.js]
SHARED_SURFACE_FOLLOWUP_REQUIRED=YES (haptics only; see below)
```

- **#427** owns the Build 35 shared haptic authority and touches
  `hooks/useClosetCandidates.js`. This lane does not touch that hook. It calls
  the existing `services/haptics.js` helpers. When #427 lands, the purchase
  import haptics should move onto its authority. The only call sites are
  `PurchaseCropStep`, `PurchaseCandidateCard` and `app/purchase-import`.
- **Closet contract.** The Closet Productization lanes (#335/#336/#337) are
  merged and no lane owns this contract now. It is extended here additively:
  - one origin value, `purchase_import`;
  - one media relaxation, scoped to that origin;
  - one nested, allowlisted `purchase` object;
  - one new documented ownership call site.
- **Merge order:** no file conflicts with #427. Either order works.

## 3. Decision log

| Probe | Path inspected | Capability found | Decision | Fallback/HOLD |
|---|---|---|---|---|
| Closet ownership authority | `services/closetLibrary.js#createClosetItem` | The single ownership write. Actor-scoped, allowlisted, idempotent on lineage. | `CLOSET_OWNERSHIP_AUTHORITY=services/closetLibrary.js#createClosetItem`. Purchase import is its 4th documented call site (`purchaseImportCommit.ts`); the SEAM test and contract map were updated. | — |
| Media requirement | same | Media was required for every origin. | **Owner ruling: ask for a photo, proceed without one.** A missing `sourceUri` is allowed ONLY when `draft.origin === 'purchase_import'`. Every other origin still fails `missing_source_media` (tested). Media-less items were already supported downstream: the grid placeholder, restore (`materializeRestoredClosetItem` writes null media), and sync (`mediaState: 'none'`). | — |
| Purchase metadata | `buildClosetRecord`, `closetContractSchema.json` | No such fields existed. | Added one nested, allowlisted, bounded `purchase` object, present only on `purchase_import` items. The schema **stays v2**: writers operate on the raw manifest, so older builds preserve it. `applyRestoredClosetItemFacts` re-asserts it. The projection (what screens and Elise read) excludes it, so there is no financial profiling. | — |
| Origin vocabulary | `CLOSET_ORIGINS`, server CHECK | `direct_intake` and `recent_scan` only. | Added `purchase_import`. The migration widens the CHECK. Sync and restore carry it through; any other unknown origin still collapses to `direct_intake`. Inventory adds an "Added from an order" filter, shown only when such items exist. | — |
| Minimum receipt-only identity | — | — | `RECEIPT_ONLY_MINIMUM_IDENTITY=title + owner-confirmed selection (+ optional garment photo)`. There is no global product identity. | — |
| Quantity | Closet record | No quantity field. | `CLOSET_QUANTITY_SEMANTICS=MULTIPLE_IDENTICAL_ITEMS`. A "Qty 3" line adds up to 3 records (at most 10, and never more than printed). The customer chooses how many. Each unit gets its own lineage id. | — |
| Product identity | Closet, candidate, mirror | None on owned items. | `PURCHASE_IDENTITY_CAPABILITY=NONE (global)`. SKU, GTIN and retailer ref are kept only as purchase provenance, and only when printed on the line (GTIN also check-digit validated). `KSCAN_VERIFIED_PRODUCT` is never produced. No fuzzy matching. | — |
| Extraction provider | `_shared/llmModelRouting.ts`, `scan-identify` | Gemini Developer API, image and text. | `RECEIPT_EXTRACTION_PROVIDER=Gemini via new governed Edge Function purchase-import-extract (existing provider, existing model allowlist, Scanner routing pinned with no env override)`, `PROVIDER_ACCEPTS_IMAGE=YES`, `PROVIDER_ACCEPTS_TEXT=YES` | No new provider. |
| Provider terms | Owner statement + Gemini API Additional Terms (effective 2026-03-23, fetched 2026-09-22) | Paid Services (a Cloud project with an active billing account, which includes prepaid): prompts and responses are **not used to improve products**; they are **logged for a limited period solely for abuse detection and required legal disclosures**; human review is described for Unpaid Services only. | `PROVIDER_TRAINING_USE=NOT_USED (paid tier)`, `PROVIDER_RAW_INPUT_RETENTION=LIMITED_PERIOD_ABUSE_MONITORING_ONLY`, `PROVIDER_PROCESSING_CONTRACT_VERIFIED=YES (owner-attested tier + published paid-tier terms)` | **Owner follow-ups:** confirm the `GEMINI_API_KEY` used by Edge Functions belongs to the billed project; legal review of the receipt data class; privacy-disclosure copy. |
| On-device text redaction | `modules/kscan-pii-native/**` | None. Plate screening detects text rectangles without reading them, and is iOS-only. | `ON_DEVICE_TEXT_REDACTION_AVAILABLE=NO` | — |
| Privacy path | — | — | `PII_MINIMIZATION_PATH=USER_CROP_GOVERNED_PROCESSING` (Path B). See section 4. | — |
| Existing image privacy boundary | `services/privacy/privacyBoundary.ts` | Face + plate gate for Closet **cloud-media** upload. Its plate screen blocks any image containing text rectangles. | Not applied to receipts: it would block every receipt and redacts nothing textual. An optional garment photo is still governed by it on cloud sync, unchanged. | — |
| Input bounds | `scan-identify` `MAX_IMAGE_BASE64_BYTES` | 2 MiB base64 | `MAX_IMAGE_BYTES=2 MiB base64` (client and server, parity-tested). `MAX_IMAGE_DIMENSIONS`: width 1280 after resize, height at most 4096. `MAX_ITEMS_PER_IMPORT=25`. `MULTIPAGE_SUPPORT=NO`. `LONG_SCREENSHOT_SUPPORT=YES` up to the height bound, refused beyond it. `PDF_RECEIPT_SUPPORT=DEFERRED`. | Refuse, never truncate. |
| Rate / cost | `reserve_provider_request` (migration `20260803020000`), `_shared/security/quota.ts` | Actor-scoped reservations exist. `quota.ts` had no caller until now. | New limits row: 8 per rolling hour, 25 per day, 1 concurrent, 60s TTL, cost 2. Non-billable attempts are released. `MODEL_CALLS_PER_IMPORT=1` (at most 2, only on a transient failure, via the approved fallback). `PROVIDER_CALLS_PER_IMPORT=1–2`. No Commerce call. | Fails closed if the reservation authority is unavailable. |
| Anonymous access | `_shared/deletion/common.ts#isEligibleAccountActor` | — | Anonymous identities are refused before reservation. | — |
| Flag | `constants/featureFlags.ts` | — | `EXPO_PUBLIC_RECEIPT_INTELLIGENCE_V1`: default OFF, exact `"true"` only. Server kill switch `PURCHASE_IMPORT_EXTRACT_ENABLED`, default OFF. Neither is set anywhere. | — |
| Return reminders | `services/watchlist/pushRegistration.ts` | Remote push only. | `RETURN_REMINDERS_V1=DEFERRED` | — |
| Telemetry | `services/analytics/*` | A governed registry and boundary exist. | A 6th registered surface, `purchase_import`, with a sink that allows 5 events and 16 properties, all enums, buckets or small counts. | — |
| Haptics | `services/haptics.js`, PR #427 | #427 unmerged. | Existing helpers used. Follow-up once #427 lands. | — |

## 4. Privacy (Path B)

```
USER-SELECTED IMAGE -> REQUIRED LINE-ITEM CROP -> METADATA STRIP -> GOVERNED PROVIDER
```

**The required crop.** `components/purchase-import/PurchaseCropStep.tsx` cannot
be skipped. Only the cropped region is encoded. The customer must also
confirm "My crop shows only the purchased items". The copy says a crop reduces
what is shared and does not claim it guarantees PII removal.

**The metadata strip.** `expo-image-manipulator` re-encodes from a bitmap
(`UIImage.jpegData` on iOS, `Bitmap.compress` on Android), so source EXIF, GPS
and device metadata are not carried over. The picker is also asked for
`exif: false`.

**What may still transit (`PII_MINIMIZED_BEFORE_CLOUD=PARTIAL`).**
- Anything the customer leaves inside the crop: a name, an order number, a
  card fragment, or an address printed among the item lines.
- It cannot be removed locally because no on-device text recognition exists.
- It is governed by Gemini's Paid Services terms: not used for training, and
  logged for a limited period for abuse monitoring only.
- Persistence: none on K Scan's side.
  - The Edge Function writes nothing and logs only classes and counts.
  - The model is instructed never to transcribe these categories.
  - Deterministic scrubbing (`purchaseImportSensitive.ts`, byte-identical on
    the server) removes card fragments, email addresses, phone numbers, street
    addresses and order, loyalty and tracking references from every text field,
    both server-side and again on the device.

**Other settings:**
- `RAW_RECEIPT_PERMANENTLY_STORED=NO`
- `RAW_RECEIPT_IN_ANALYTICS=NO`
- `RAW_RECEIPT_IN_CLOSET=NO`
- `TEMP_STORAGE_LOCATION=cacheDirectory/kscan_purchase_import/` (app-private)
- `TEMP_ENCRYPTION`: the platform app sandbox. iOS Data Protection default
  class; Android app-private internal storage with file-based encryption. No
  additional encryption.
- `TEMP_TTL`: the life of one import session. The cropped JPEG exists only
  until it is read as base64.
- `TEMP_CLEANUP_TRIGGERS`: extraction start (the staged source is deleted once
  cropped), completion, cancellation, terminal failure, actor switch, screen
  exit, and a sweep on every feature entry. The sweep covers abandonment.

## 5. Stop conditions checked

None triggered. The owner ruling resolved `HOLD_PRIVACY_ARCHITECTURE` and the
image-requirement finding. No new provider was added. There is no parallel-lane
conflict. No security defect is open.
