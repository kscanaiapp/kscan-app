# Glasses Scan Contract Inventory

Implementation-focused inventory of the existing scan/analysis contract for the glasses integration foundation.

## Existing request fields

**Legacy Render `/api/analyze` (services/api.js `analyzeText`):**
- `mode`: `'text'`
- `query`: string, 3–500 chars, sanitized
- `source`: string default `'textscan'`

**Legacy Render `/api/analyze` image path (removed from production mobile):**
- `image`: base64 string (data URI or raw)
- `mode`: `'image'`

**Scan-identify Edge Function (`services/scanIdentification.ts`):**
- `mode`: `'image' | 'text'`
- `imageBase64`: string
- `textQuery`: string
- `source`: string
- `localPrivacyFiltered`: boolean
- `clientTimestamp`: ISO string

## Existing response fields

**Legacy Render response:**
- `type`: `'fashion' | 'non-fashion'`
- `result`: string (prose analysis)
- `message`: string (non-fashion explanation)
- `metadata`: `{ category, color, silhouette, itemType?, material?, style? }`
- `products`: array

**Scan-identify response (`types/scanIdentification.ts`):**
- `scanId`: string (optional)
- `status`: `'completed' | 'non_fashion' | 'failed'`
- `attributes`: `FashionAttributes`
- `identification`: `DetailedIdentification` (optional)
- `recommendedProducts`: `RankedScanProduct[]`
- `similarityMatches`: `RankedScanProduct[]` (optional)
- `userMessage`: string (optional)
- `displayResult`: `{ headline?, details?, styling?, confidenceLabel? }`

## Required fields

- For image scan: a valid image input (base64 string)
- For text scan: a valid text query
- For the mobile UI: `type`, `result`/`message`, `metadata`, `products`

## Optional fields

- `itemType`, `material`, `style` in legacy metadata
- `identification`, `similarityMatches`, `displayResult`, `scanId` in scan-identify
- All product fields except identifier and title

## Non-fashion response

- Legacy: `{ type: 'non-fashion', message, metadata: { category: '', color: '', silhouette: '' }, products: [] }`
- Scan-identify: `{ status: 'non_fashion', recommendedProducts: [], userMessage }`
- Mapped UI: `{ type: 'non-fashion', message }`

## Error response

- `services/api.js` throws `Error` with `.code` and `.userMessage`
- `services/scanIdentification.ts` returns `{ status: 'failed', recommendedProducts: [], userMessage }`
- `mapScanIdentifyToAnalysis` throws a user-safe `Error` with `.userMessage`

## Product shape

**Legacy normalized product (`services/api.js`):**
- `id`, `name`, `retailer`, `price`, `imageUrl`, `imageCategory`, `productUrl`, `purchaseUrl`, `affiliateUrl`

**Catalog response shape (`server.js`):**
- `id`, `name`/`title`, `retailer`/`brand`, `price`, `imageUrl`, `imageCategory`, `productUrl`, `purchaseUrl`

**Scan-identify product (`types/scanIdentification.ts`):**
- `RankedScanProduct`: `id?`, `name?`, `title?`, `displayName?`, `matchScore?`, `similarityPercentage?`, `confidenceTier?`, `matchReasons?`

## Parser version

- `app/api/analyze+api.js`: Normalization version 2.0, Parser version 3.0, Prompt version 2.0
- `server.js`: `PARSER_VERSION`, `NORMALIZATION_VERSION`, `PROMPT_VERSION` (inspect file for current values)

## Prompt version

- See `app/api/analyze+api.js` SYSTEM_PROMPT and `server.js` SYSTEM_PROMPT.
- Current prompt version: 2.0 (per analyze+api.js header).

## Normalization functions

- `server.js`: `canonicalCategory`, `categoryForMetadata`, `shapeProductForResponse`, `normalizeAttributeValue`
- `services/api.js`: `normalizeProduct`, `deduplicateProducts`, `inferImageCategory`, `normalizeImageUrl`
- `services/scanIdentification.ts`: `normalizeAttributes`, `normalizeIdentification`, `normalizeRecommendedProducts`, `normalizeDisplayResult`, `normalizeScanIdentifyResponse`
- `services/textScanEdge.ts`: `mapRecommendedProducts`, `normalizeProductPrice`, `normalizeColor`, `normalizeMaterial`, `normalizeStyleDescriptors`
- `app/api/analyze+api.js`: `resolveCompoundValue`, `parseAIResponseLocal`

## Duplicate definitions

- Fashion attribute normalization exists in `server.js`, `services/scanIdentification.ts`, and `services/textScanEdge.ts` with overlapping but not identical rules.
- Product normalization exists in `services/api.js`, `server.js`, and `services/textScanEdge.ts`.
- Category/silhouette canonical sets exist in both `server.js` and `app/api/analyze+api.js`.

## Compatibility risks

- Legacy UI expects `{ type: 'fashion' | 'non-fashion', result?, message?, metadata, products }`.
- Scan-identify returns a different top-level shape; the mapper bridges it today.
- Product fields vary across sources (`name` vs `title`, `price` string vs number, `productUrl` vs `purchaseUrl`).
- Non-fashion responses must not be treated as errors by the UI.
- The new shared contract must remain convertible to both legacy UI shape and scan-identify shape without changing existing consumers.
