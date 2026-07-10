# Glasses Integration Foundation

Isolated foundation for future smart-glasses integration. No existing mobile or backend runtime behavior was changed.

## 1. Scope

- Versioned shared scan-analysis contract (`services/scan-contract/`).
- Explicit privacy-sanitization boundary (`services/privacy/`).
- Mock wearable session and transport abstraction (`services/wearables/`).
- Local glasses-result formatting and synthetic fixture flow.
- Targeted tests and documentation.

## 2. Non-goals

- No real glasses hardware integration.
- No new native modules.
- No camera or microphone integration.
- No production API calls.
- No backend deployment or database change.
- No new application routes, screens, or navigation entries.
- No new permissions.
- No separate npm package, workspace, or monorepo tool.

## 3. Logical contract version

`SCAN_CONTRACT_VERSION = '1.0.0'`

This version identifies the request/response shape and adapter behavior. It is independent of the AI parser/prompt versions in the legacy backend and scan-identify edge function.

## 4. Contract types

### Request

- `contractVersion`: string
- `requestId`: non-identifying random id
- `source`: `'mobile_camera' | 'mobile_upload' | 'text_scan' | 'wearable_mock'`
- `image`: optional `{ base64, mimeType, width?, height? }`
- `textQuery`: optional string
- `privacy`: required sanitizer context
- `device`: optional `{ deviceClass, platform?, appVersion? }`

### Response

- `contractVersion`: string
- `requestId`: string
- `status`: `'success' | 'non_fashion' | 'partial' | 'error'`
- `attributes`: optional `FashionAttributes`
- `products`: optional `ProductMatch[]`
- `message`: optional string
- `processing`: optional metadata
- `error`: optional `ScanError`

### Fashion attributes

`category`, `subcategory`, `silhouette`, `fit`, `color`, `colorPalette`, `pattern`, `materialEstimate`, `texture`, `styleTags`, `seasonality`, `occasionTags`, `confidence`.

Fashion specificity is preserved. Vocabulary normalization maps common variants deterministically (e.g. `navy`/`dark blue`, `oversized`/`boxy`/`relaxed`).

### Product model

`id?`, `title`, `retailer`, `price?`, `currency?`, `imageUrl?`, `productUrl?`, `affiliateUrl?`, `similarity?`, `source?`, `availability?`.

Retailer-neutral. No invented partnerships or checkout claims.

### Error model

Stable codes: `INVALID_REQUEST`, `IMAGE_TOO_LARGE`, `UNSUPPORTED_IMAGE_TYPE`, `PRIVACY_SANITIZATION_REQUIRED`, `ANALYSIS_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `NON_FASHION_INPUT`, `RATE_LIMITED`, `AUTH_REQUIRED`, `UNKNOWN_ERROR`.

No stack traces, API keys, internal URLs, raw provider errors, database details, or tokens are exposed.

## 5. Legacy adapters

- `toSharedScanRequest(legacyInput)` — legacy Render/scan-identify request → shared request.
- `normalizeLegacyAnalyzeResponse(legacyResponse)` — legacy response → shared response.
- `toLegacyCompatibleResult(sharedResponse)` — shared response → existing mobile UI shape.

Adapters are for tests, fixtures, and future migration only. Existing mobile consumers do not import them.

## 6. Privacy boundary

Interfaces:

- `PrivacySanitizerInput`
- `PrivacySanitizerResult`
- `PrivacySanitizer`

Providers:

- `mobileCompatibilitySanitizer` — honest pass-through, no detection/masking.
- `wearableMockSanitizer` — synthetic masked metadata only, clearly mock-only.

## 7. Current pass-through limitation

The current app does not perform local face or plate detection or masking. The mobile compatibility provider labels this honestly as `mode: 'passthrough'`.

## 8. Future wearable masking requirement

`assertPrivacyPolicySatisfied(request, 'WEARABLE_PRODUCTION_REQUIRED_MASKING')` rejects pass-through input and requires face and plate masking flags. This policy is implemented but not activated in the current app.

## 9. Mock transport

`MockWearableTransport` in `services/wearables/`:

- Uses only local fixtures.
- Never performs a network request.
- Never requests camera or microphone permission.
- Never retains an auth token.
- Simulates connection state and session expiration.
- Supports success, timeout, and failure fixtures.

## 10. Fixture-only demonstration

The end-to-end mock flow is exercised in `__tests__/glassesFoundationFlow.test.js` only. No route, screen, navigator entry, deep link, tab, button, or hidden screen was added under `app/`.

## 11. Test commands

```bash
# Targeted foundation tests
node --test __tests__/glassesFoundationFlow.test.js

# Established full suite
node --test __tests__/*.test.js

# TypeScript type check
npx tsc --noEmit

# Expo config resolution
npx expo config --type public

# Expo Doctor
npx expo-doctor
```

## 12. Production freeze

This change does not:

- Start an EAS build.
- Submit to TestFlight or Play Store.
- Deploy Supabase functions.
- Apply migrations or execute SQL.
- Modify RLS, storage policies, or auth.
- Modify Render deployment or environment variables.
- Change OAuth redirects, remote `app_config`, feature flags, app version, build numbers, bundle IDs, or package names.
- Add permissions.
- Merge the branch.

## 13. Known gaps

- Real face and plate detection/masking does not exist yet.
- No live glasses API or camera integration.
- No voice recognition.
- No backend migration to the shared contract.
- No production wearable session management.

## 14. Next implementation phase

Planned future sequence:

```text
Device camera
→ local face and plate detection
→ local masking
→ garment crop
→ shared request
→ authenticated analysis service
→ retailer-neutral product matches
→ concise wearable response
→ optional phone handoff for checkout
```

The foundation in this branch makes the shared request/response and privacy boundary explicit so that future phases can plug in real implementations without changing the existing app.
