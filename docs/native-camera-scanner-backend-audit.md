# K Scan AI — Native Camera Scanner Backend/API Audit Report

**Branch:** `integration/free-tier-beta-into-style-dna`  
**Audit Date:** 2026-07-05  
**Scope:** Native camera scan → backend `scan-identify` → product suggestion pipeline  
**Auditor:** Kimi Work Agent  

---

## Executive Summary

**The native camera scanner does NOT return only LLM-generated fashion identification.** It returns **both** LLM-generated fashion attributes (from Gemini) **and** real product suggestions from the internal `product_catalog` database — complete with retail links, prices, and product images, **assuming the catalog is populated**.

However, the camera scanner **does NOT** use live shopping APIs (Serper / Brave Web Search). Those are wired exclusively for **TextScan** (text mode). Camera scans rely solely on the internal catalog.

| Capability | Camera Scan (Image Mode) | TextScan (Text Mode) |
|------------|--------------------------|----------------------|
| Fashion identification | Gemini vision | Gemini text |
| Product source | Internal `product_catalog` DB | Live Serper → Brave fallback |
| Retail links | Yes (from catalog) | Yes (from search APIs) |
| Pricing source | Catalog-stored (freshness-dependent) | Live search API pricing (Serper/Brave) |
| Exact-item matching | No — category/color/silhouette similarity | No — search-query based |
| Requires `SUPABASE_SERVICE_ROLE_KEY` | Yes | No |

---

## 1. End-to-End Camera Scan Flow

```
[Mobile Camera]
    ↓ base64 JPEG
services/scanIdentification.ts::identifyScanImage()
    ↓ POST scan-identify { imageBase64, source: "camera" }
supabase/functions/scan-identify/index.ts
    ↓ JWT auth → Gemini vision call
    ↓ Parse JSON response (attributes + identification)
    ↓ fetchCatalogCandidates(catalogClient, normalizedId, { limit: 30 })
    ↓ mergeProductCandidates() + rankRecommendedProducts()
    ↓ Return top 10 recommendedProducts
    ↓ Response { status, attributes, identification, recommendedProducts[], displayResult }
services/scanIdentification.ts::normalizeScanIdentifyResponse()
    ↓ Extract recommendedProducts → RankedScanProduct[]
components/ProductShelf.tsx
    ↓ Render horizontal shelf: image, title, price, retailer, purchase link
```

### 1.1 Mobile Entry Point

**File:** `services/scanIdentification.ts`

```ts
export async function identifyScanImage(image: string, options: IdentifyScanOptions = {}): Promise<ScanIdentifyResponse> {
  const requestBody: ScanIdentifyRequest = {
    imageBase64: toRawBase64(image),
    source: options.source === 'upload' ? 'upload' : 'camera',
    localPrivacyFiltered: options.localPrivacyFiltered ?? false,
    clientTimestamp: new Date().toISOString(),
  };
  const { data, error } = await supabase.functions.invoke('scan-identify', { body: requestBody });
  // ... normalization
}
```

The mobile adapter sends `imageBase64` + `source: 'camera'` and expects a `ScanIdentifyResponse` containing `recommendedProducts: RankedScanProduct[]`.

### 1.2 Backend Handler — Image Mode Logic

**File:** `supabase/functions/scan-identify/index.ts` (lines 1001–1359)

After the Gemini call returns parsed identification data, the handler branches by mode:

```ts
if (mode === 'text') {
  // TEXT MODE: Live shopping APIs (Serper → Brave)
  const shoppingQuery = buildShoppingQuery({ ... });
  const shopping = await getShoppingResults({ query: shoppingQuery, limit: 8 });
  finalRecommendedProducts = shopping.products.slice(0, 8).map(...);
  shoppingMeta = { provider, query, count };
} else {
  // IMAGE MODE: Internal catalog retrieval only
  const completedExistingProducts = Array.isArray(completedResponseWithAttributes.recommendedProducts)
    ? completedResponseWithAttributes.recommendedProducts
    : []; // Always [] because normalized() hardcodes it

  const completedCatalogCandidates = completedNormalizedId
    ? await fetchCatalogCandidates(catalogClient, completedNormalizedId, { limit: 30 })
    : [];

  const completedMergedCandidates = mergeProductCandidates(
    completedExistingProducts,
    completedCatalogCandidates.map(adaptCatalogCandidate),
  );
  const completedRankedProducts = rankRecommendedProducts(
    completedMergedCandidates,
    completedNormalizedId,
  );
  finalRecommendedProducts = completedRankedProducts.slice(0, 10);
}
```

**Critical finding:** The `normalized()` helper hardcodes `recommendedProducts: []` (line 629–635), but the handler **overwrites** this field in the final response for completed image scans. For non-fashion scans, the shelf is forcibly emptied with the comment:

> *"Non-fashion scans never surface catalog products. Even though the model marks the scan non_fashion, it can still emit a plausible item_type (e.g. 'bag'), which would otherwise leak real catalog rows of that category into a non-fashion result. Force an empty shelf here."*

---

## 2. Catalog Retrieval Deep Dive

**File:** `supabase/functions/_shared/catalogRetrieval.ts`

### 2.1 What `fetchCatalogCandidates` Does

1. Extracts `canonicalCategory`, `canonicalColor`, `canonicalMaterial`, `canonicalSilhouette` from `normalizedIdentification`
2. Queries the `product_catalog` table:
   ```sql
   SELECT * FROM product_catalog
   WHERE canonical_category = :canonicalCategory
   ORDER BY color_match DESC, availability DESC, last_seen_at DESC
   LIMIT :limit
   ```
3. If sparse results (< 5), widens to adjacent categories
4. Returns rows with: `id`, `name`, `brand`, `retailer`, `price`, `currency`, `product_url`, `image_url`, `availability`, `score`

### 2.2 What `adaptCatalogCandidate` Produces

```ts
{
  id: row.id,
  name: row.name,
  title: row.name,
  source: row.retailer ?? row.brand ?? 'catalog',
  retailer: row.retailer ?? row.brand ?? 'catalog',
  url: row.product_url,
  product_url: row.product_url,
  imageUrl: row.image_url,
  image_url: row.image_url,
  price: row.price,
  currency: row.currency,
  availability: row.availability,
  type: 'catalog',
}
```

These are **real database records** with real `product_url` and `price`. They are not LLM-generated.

### 2.3 Ranking

**File:** `supabase/functions/_shared/scanHelpers.ts::rankRecommendedProducts()`

Products are scored by:
- Canonical category match
- Color match
- Material match
- Silhouette match
- Availability boost

Each product gets `matchScore`, `similarityPercentage`, and `confidenceTier`:
- `'exact_candidate'` — highest score
- `'closest_match'` — strong signal overlap
- `'similar_style'` — partial overlap
- `'discovery_fallback'` — weak match

---

## 3. TextScan (Text Mode) — For Comparison

**File:** `supabase/functions/scan-identify/shoppingProvider.ts`

TextScan uses **live shopping APIs**:
1. **Serper Shopping** primary (4.5s timeout)
2. **Brave Web Search** fallback
3. Kill switch: `SHOPPING_ENABLED=false`

The mobile mapper (`services/textScanEdge.ts`) normalizes the response into `TextScanProduct[]` with `type: 'retail'` (Serper) or `'similar'` (Brave).

**Camera scans do NOT invoke this path.** The `getShoppingResults` import exists in `scan-identify/index.ts` but is only called inside the `if (mode === 'text')` branch.

---

## 4. Mobile UI Rendering

**File:** `components/ProductShelf.tsx`

The UI fully renders `recommendedProducts`:
- Horizontal scrollable shelf of product cards
- Product image (with skeleton loading + error fallback)
- Retailer name
- Product title
- Price (formatted with currency)
- Availability badge (e.g. "Out of stock")
- **Purchase link** — tapping opens `Linking.openURL(product_url)`
- "Add to Dressing Room" button (feature-flagged)
- Empty state: "No catalog matches yet. Try a clearer angle..."

**File:** `services/scanResultObject.ts`

Consumes `recommendedProducts` as `matches`, derives:
- `heroImageUrl` from first match
- `confidenceLabel` (capped at `exploratory` if no matches)
- `resultType`: `'exact'` | `'close'` | `'style'` | `'exploratory'`
- `whyThisMatched` explanation text

---

## 5. Environment & Configuration

| Variable | Purpose | Camera Scan Impact |
|----------|---------|-------------------|
| `GEMINI_API_KEY` | Gemini API access | Required |
| `SCAN_IDENTIFY_AI_ENABLED` | Kill switch | If `'false'`, all scans fail |
| `SUPABASE_SERVICE_ROLE_KEY` | Catalog DB read | **If missing, catalog returns `[]`** |
| `SHOPPING_ENABLED` | Shopping API kill switch | **Ignored for camera scans** |
| `SCAN_GEMINI_TIMEOUT_MS` | Gemini timeout | Default 8s |

**Note:** If `SUPABASE_SERVICE_ROLE_KEY` is not configured, `catalogClient` is null and `fetchCatalogCandidates` returns an empty array. In this case, camera scans would return **zero product suggestions** despite successful identification.

---

## 6. Test Coverage

| Test File | What It Covers |
|-----------|----------------|
| `__tests__/scanIdentifyEdgeContract.test.js` | Verifies backend contract: auth, CORS, kill switches, mode branching, non-fashion empty shelf |
| `__tests__/catalogRetrieval.test.js` | Tests `fetchCatalogCandidates` SQL queries, adjacent-category widening, `adaptCatalogCandidate` |
| `__tests__/shoppingProvider.test.js` | Tests Serper/Brave shopping APIs (**text mode only**) |
| `__tests__/scanResultObject.test.js` | Tests `createScanResultObject`, `createResultCardViewModel`, match consumption |
| `__tests__/scanIdentification.test.js` | Tests mobile adapter normalization of `recommendedProducts` |

**Gap resolved:** `scanIdentifyEdgeContract.test.js` now includes a dedicated test asserting that `getShoppingResults` is only invoked inside the `mode === 'text'` branch and that image mode uses `fetchCatalogCandidates` instead.

---

## 7. Findings & Risk Assessment

### 7.1 ✅ What Works

1. **Camera scans do return real product suggestions** — from `product_catalog`, not LLM hallucinations.
2. **Retail links are real** — `product_url` from the catalog opens actual retailer pages.
3. **UI is wired end-to-end** — `ProductShelf` renders images, prices, and purchase links.
4. **Non-fashion scans are safely capped** — forced empty shelf prevents catalog leakage.
5. **Ranking is deterministic** — `rankRecommendedProducts` scores by attribute overlap.

### 7.2 ⚠️ Risks & Limitations

1. **Catalog dependency** — If `product_catalog` is empty or `SUPABASE_SERVICE_ROLE_KEY` is missing, camera scans return zero products. The user sees "No catalog matches yet."
2. **No live shopping for camera** — Unlike TextScan, camera scans do not fall back to Serper/Brave if the catalog is sparse.
3. **Not exact-item matching** — The catalog query matches on category/color/silhouette, not visual similarity or reverse image search. The "exact" confidence tier is optimistic.
4. **Catalog staleness** — `last_seen_at` is used for ordering, but there's no documented freshness threshold or automated pruning.
5. **No visual search** — The image itself is not used for product matching; only the LLM-extracted text attributes drive the catalog query.

### 7.3 🔍 Architectural Observation

The comment at line 24 of `scan-identify/index.ts` was updated during this audit. Previously it incorrectly stated:

```ts
// recommendedProducts is always [] in this slice (matching deferred)
```

It now reads:

```ts
// recommendedProducts: image mode uses catalog retrieval (product_catalog DB);
//   text mode uses live shopping APIs (Serper primary, Brave fallback).
```

The code contains a comment at line 24 that is now **stale**:

```ts
// recommendedProducts is always [] in this slice (matching deferred)
```

This was true in an earlier slice, but the current code **does** populate `recommendedProducts` for camera scans via catalog retrieval. The comment should be updated to avoid confusion during future audits.

---

## 8. Recommendations

### Immediate (Low Effort) — COMPLETED

1. ~~**Update stale comment** in `scan-identify/index.ts` line 24.~~ ✅ Done — changed to document catalog retrieval for image mode and live shopping for text mode.

2. ~~**Add explicit test** in `scanIdentifyEdgeContract.test.js` asserting that `getShoppingResults` is only invoked in `mode === 'text'`.~~ ✅ Done — added `test('edge source: text mode is the only path that calls live shopping APIs')`.

1. **Update stale comment** in `scan-identify/index.ts` line 24. Change from "always []" to "populated via catalog retrieval for image mode; live shopping for text mode."

2. **Add explicit test** in `scanIdentifyEdgeContract.test.js` asserting that `getShoppingResults` is only invoked in `mode === 'text'`.

### Short-Term (Backend Sprint)

3. **Add shopping fallback for camera scans** — If `fetchCatalogCandidates` returns < 3 results, optionally call `getShoppingResults` using the generated `search_queries` from Gemini. This would bridge the gap between camera and TextScan commerce.

4. **Catalog health monitoring** — Add a metric/logging for `catalog_retrieval_empty` so operators know when the catalog is underserving camera scans.

### Long-Term

5. **Visual search integration** — Consider a true visual search API (e.g., Google Lens, Syte, ViSenze) for exact-item matching, rather than relying solely on LLM-extracted text attributes.

---

## 9. Audit Evidence — File Reference Index

| File | Lines | Evidence |
|------|-------|----------|
| `supabase/functions/scan-identify/index.ts` | 622–636 | `normalized()` hardcodes `recommendedProducts: []` |
| `supabase/functions/scan-identify/index.ts` | 1001–1359 | Handler body: text mode → shopping; image mode → catalog |
| `supabase/functions/scan-identify/index.ts` | 1137–1145 | Non-fashion forced empty shelf |
| `supabase/functions/scan-identify/shoppingProvider.ts` | 1–200 | `getShoppingResults()` — Serper/Brave, text mode only |
| `supabase/functions/_shared/catalogRetrieval.ts` | 1–150 | `fetchCatalogCandidates()` queries `product_catalog` |
| `supabase/functions/_shared/scanHelpers.ts` | 1–100 | `rankRecommendedProducts()` scoring logic |
| `services/scanIdentification.ts` | 1–100 | Mobile adapter calls `scan-identify`, normalizes `recommendedProducts` |
| `services/scanResultObject.ts` | 556–616 | `createScanResultObject()` consumes `recommendedProducts` as `matches` |
| `components/ProductShelf.tsx` | 262–428 | UI renders product cards with purchase links |
| `types/scanIdentification.ts` | 85–96 | `ScanIdentifyResponse` contract: `recommendedProducts: RankedScanProduct[]` |

---

*End of Audit Report*
