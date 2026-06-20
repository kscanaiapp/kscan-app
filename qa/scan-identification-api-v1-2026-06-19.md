# K Scan AI — KS-REL-008C Scan Identification API Integration

## 1. Status

**PASS WITH NOTES**

A real app-side fashion identification path now exists: a `scan-identify` Supabase
Edge Function (Gemini vision) plus a client adapter, mapper, typed contract, and a
gated wire-in to the existing Scan flow. The new path is behind a default-OFF
feature flag (`SCAN_IDENTIFY_BACKEND_ENABLED`), so the live app is unchanged until
an owner enables it. Notes: the Edge Function is **not deployed** (no deploy
without approval) and live on-device runtime smoke is deferred (function not
deployed; flag off). Client adapter + mapper behavior is verified by unit tests.

---

## 2. Branch / Commit

- **Branch:** `feature/scan-identification-api-v1`
- **Base:** `feature/ui-v2-integration-smoke` @ `f90dd05`
- **Commit:** see commit step.
- **Working tree:** clean except the intended new/modified files plus the known
  pre-existing untracked QA/workspace files (not staged).

---

## 3. Files Changed

New:
- `types/scanIdentification.ts` — shared request/response contract.
- `supabase/functions/scan-identify/index.ts` — Edge Function (Gemini vision).
- `services/scanIdentification.ts` — client adapter (`identifyScanImage`, `normalizeScanIdentifyResponse`).
- `services/scanIdentificationMapper.ts` — maps contract → legacy analysis state.
- `__tests__/scanIdentification.test.js` — 11 unit tests (adapter + mapper).

Modified:
- `constants/featureFlags.ts` — adds `SCAN_IDENTIFY_BACKEND_ENABLED` (default OFF).
- `hooks/useKScan.js` — gated branch in `runAnalysis` selecting the new adapter
  when the flag is on; legacy path otherwise.

---

## 4. Previous Scan Backend Path

- **Old endpoint/call:** `hooks/useKScan.runAnalysis()` → `compressForUpload()` →
  `sanitizeImageBeforeUpload()` → `analyzeImage()` (`services/api.js`), which
  POSTs to the **Render** backend `${EXPO_PUBLIC_API_URL || https://kscan-app-1.onrender.com}/api/analyze`.
- **Old payload:** `{ image: "data:image/jpeg;base64,..." }`.
- **Old response:** `{ type: 'fashion', result, metadata: {category,color,silhouette}, products }`
  or `{ type: 'non-fashion', message }`.
- **Reason replaced:** This slice adds an app-side Supabase Edge Function
  destination for identification. The Render path is **not removed** — it remains
  the default. The new path is opt-in via flag so nothing regresses.

---

## 5. New Scan Identification Path

- **Edge Function:** `supabase/functions/scan-identify/index.ts`
  - Auth: requires `Authorization: Bearer`; verifies user via `auth.getUser()`
    (mirrors `stylechat-generate`). Anonymous calls are rejected (401).
  - Input validation + 2 MB base64 size guard (oversized never reaches provider).
  - Gemini vision call (`inline_data`, `responseMimeType: application/json`),
    timeout guard (target ~5 s; 8 s hard cap, `SCAN_GEMINI_TIMEOUT_MS`-tunable).
  - Output is parsed, allowlist-sanitized (only fashion attribute keys survive),
    and normalized; raw provider output is never returned.
  - Kill switch: `SCAN_IDENTIFY_AI_ENABLED=false`.
- **Client service:** `services/scanIdentification.ts` — `identifyScanImage(image, { source, localPrivacyFiltered })`
  using `supabase.functions.invoke('scan-identify', …)` with an AbortController
  timeout; strips the data-URI prefix; mirrors the 2 MB guard; requires a session;
  always returns a normalized response.
- **Request contract:** `{ imageBase64, source: 'camera'|'upload', localPrivacyFiltered, clientTimestamp }`.
- **Response contract:** `{ scanId?, status: 'completed'|'non_fashion'|'failed', attributes?, recommendedProducts: [], userMessage? }`.
- **Mapper:** `services/scanIdentificationMapper.ts` — `completed` → `{ type:'fashion', result, metadata, products: [] }`;
  `non_fashion` → `{ type:'non-fashion', message }`; `failed` → throws a user-safe
  error caught by the existing `useKScan` error path. No UI rewrite required.
- **Feature flag behavior:** `SCAN_IDENTIFY_BACKEND_ENABLED` (env
  `EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED`) is **OFF by default**. When off,
  the legacy Render path runs unchanged. Enabling requires owner approval and an
  authenticated Scan flow. Not enabled in this task; no env file modified.

---

## 6. AI Provider

- **Provider:** Google Gemini (Flash, vision) — same provider as `stylechat-generate`.
- **Env vars used (names only):** `GEMINI_API_KEY` (server-side secret),
  optional `SCAN_GEMINI_MODEL` / `GEMINI_MODEL`, optional `SCAN_GEMINI_TIMEOUT_MS`,
  optional `SCAN_IDENTIFY_AI_ENABLED`. Auto-injected: `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- **Supabase secret present:** YES — `GEMINI_API_KEY` exists on App Staging
  (`wyyuqfdxucjksghsmhry`), confirmed via `supabase secrets list` (digest only; no
  value printed).
- **Server-side only:** YES — the key is read via `Deno.env.get('GEMINI_API_KEY')`
  inside the Edge Function and never exposed to the client.
- **Missing provider secrets:** none for staging. Optional `SCAN_GEMINI_MODEL` /
  `SCAN_IDENTIFY_AI_ENABLED` are unset and fall back to safe defaults.

---

## 7. Privacy / Safety

- **No people identification:** prompt forbids identity; output sanitizer drops
  any non-allowlisted key, so face/person/demographic fields cannot pass through.
- **No face recognition:** none performed server-side; the client also runs a
  local privacy sanitizer (`sanitizeImageBeforeUpload`) before upload.
- **Non-fashion behavior:** prompt returns `non_fashion`; normalized to a safe
  message and the existing non-fashion UI state.
- **localPrivacyFiltered handled:** passed in the request (client sets it after
  the local sanitizer pass); recorded server-side.
- **Raw image storage:** none. The image is sent for inference only; not persisted.
- **Image payload limit:** 2 MB base64, enforced on both client and server;
  oversized → "Image too large. Please retake the photo closer or in better light."
- **Timeout behavior:** provider call aborts at the configured cap; returns
  `status: 'failed'` with safe retry copy. No indefinite hang.
- **Safe error copy:** all failures map to user-safe messages; no stack traces or
  raw provider errors reach the client.
- **No fake commerce:** no products, prices, or match scores are produced.

---

## 8. Product Matching

- **recommendedProducts behavior:** always `[]` (enforced in the contract type,
  the Edge Function normalizer, the client normalizer, and the mapper).
- **Retailer data:** none.
- **Prices:** none.
- **Match scores:** none.
- **Deferred work:** product/catalog matching is a later slice; `FashionAttributes`
  is intentionally image-agnostic so it can feed matching (and TextScan) later.

---

## 9. Persistence

- **Persistence used:** none in this slice.
- **saved_scans used:** no.
- **Raw image stored:** no.
- **Deferred work:** persistence deferred to the Library cloud sync slice
  (`saved_scans` + `CLOUD_SAVED_SCANS_ENABLED`). No new table/migration created.

---

## 10. TextScan Impact

- **TextScan changed:** no.
- **TextScan still points to:** the Render `/api/analyze` text path via
  `analyzeText` (`services/api.js`) + `services/textScan.ts` normalization. Untouched.
- **Shared types:** none forced; `FashionAttributes` is deliberately attribute-only.
- **Future reuse:** TextScan can later return the same `FashionAttributes` shape
  from text instead of an image, reusing this contract.

---

## 11. Validation

- **TypeScript:** `npx tsc --noEmit` → exit 0 (clean).
- **Node tests:** new `__tests__/scanIdentification.test.js` → 11/11 pass. Full
  suite shows **no new failures**. Three pre-existing failures remain and were
  confirmed identical at baseline (with my modified files reverted):
  - `useKScanDuplicateGuard.test.js` (stale VM mock missing `sanitizeImageBeforeUpload`).
  - `authPrivacy.test.js` (1 pre-existing failure, unrelated).
  - `verifyAppleReadiness.test.js` (1 pre-existing failure, unrelated).
- **Deno check:** `deno check supabase/functions/scan-identify/index.ts` → exit 0.
- **Git diff check:** `git diff --check` clean (no whitespace/conflict markers).
- **Runtime smoke:** deferred — Edge Function not deployed and flag off by default,
  so the live app still uses the Render path. Adapter/mapper behavior (auth gate,
  size guard, normalization, prefix stripping, error mapping) verified by unit tests.

---

## 12. Remaining Work

- **Deploy function:** `supabase functions deploy scan-identify --project-ref wyyuqfdxucjksghsmhry`
  (owner approval required; not run here).
- **Provider secret:** none needed — `GEMINI_API_KEY` already present on staging.
- **Staging function verification:** after deploy, smoke `scan-identify` with an
  authenticated test session; confirm completed/non_fashion/failed paths and that
  only `wyyuqfdxucjksghsmhry` is called (never the Privacy project).
- **Library persistence:** wire `saved_scans` in the Library cloud sync slice.
- **TextScan reuse:** optionally route TextScan through the same `FashionAttributes`.
- **Retailer/catalog matching:** future slice; `recommendedProducts` stays `[]`.
- **Enablement:** flip `EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=true` (owner
  approval) once the function is deployed and the Scan flow is authenticated.

---

## Recommendation

Merge `feature/scan-identification-api-v1`. The new identification path is
complete, type-checked, unit-tested, privacy-safe, and additive (flag-gated OFF),
so it introduces zero behavior change to the shipping app. Before enabling:
(1) deploy `scan-identify` to App Staging, (2) confirm the Scan flow is
authenticated, (3) smoke the three result paths, then (4) flip the flag under
owner approval.
