# K Scan AI — Scan to Closet Wiring Report

**Date:** 2026-06-19  
**Branch:** `fix/scan-to-closet-wiring-v1`  
**Base:** `feature/scan-identification-api-v1`  
**Scope:** Validate and complete the Scan → Identify → Results → Save to Closet loop.

---

## 1. Branch / Commit

| Field | Value |
|---|---|
| Branch | `fix/scan-to-closet-wiring-v1` |
| Base | `feature/scan-identification-api-v1` (HEAD `47358c2`) |
| Commit(s) | `e97e325` docs(qa): add core backend wiring audit (ancestor) |
| Working tree | Clean (no tracked modifications before this task) |

---

## 2. Architecture Map

| Component | Path | Role |
|---|---|---|
| **Scan entry** | `app.js` | Camera capture, upload, QA fixtures, V1/V2 result rendering |
| **Scan state machine** | `hooks/useKScan.js` | `idle → capturing → preview → processing → result/non-fashion/error` |
| **Scan identify function** | `supabase/functions/scan-identify/index.ts` | Edge Function: auth → Gemini vision → normalized fashion attributes |
| **Client adapter** | `services/scanIdentification.ts` | `identifyScanImage()` → `supabase.functions.invoke('scan-identify')` |
| **Response mapper** | `services/scanIdentificationMapper.ts` | Maps `ScanIdentifyResponse` → legacy `analysis` shape |
| **Save action** | `services/library.js` `saveScan()` | Persists scan to local `FileSystem` (`kscan_library.json` + images + thumbnails) |
| **Auto-save** | `app.js` `useEffect` | Fires on `status === 'result'`, calls `saveScan()`, shows `SavedToast` |
| **Manual save** | `app.js` `onSaveToLibrary` | Re-save fallback for explicit "Save to Closet" tap |
| **Closet persistence** | `services/library.js` `loadLibrary()` | Reads `kscan_library.json` from `FileSystem.documentDirectory` |
| **Closet screen loader** | `hooks/useLibrary.js` | `loadLibrary()` + optional background cloud merge (`saved_scans` opt-in) |
| **Closet screen** | `app/library.tsx` | Renders scans + inspiration in grid, handles open/delete/upload |
| **Storage path** | `FileSystem.documentDirectory + 'kscan_library/'` | Images (`images/`), thumbnails (`thumbnails/`), JSON index |
| **Auth dependency** | Yes (Edge Function) | `scan-identify` rejects anonymous calls via `auth.getUser()` |

---

## 3. What Was Fixed

### 3.1 Scan identify backend default

**Problem:** `SCAN_IDENTIFY_BACKEND_ENABLED` defaulted to `false`, causing the app to fall back to the legacy Render `/api/analyze` endpoint, which is currently unreachable. The scan→closet loop was completely broken.

**Fix:** `constants/featureFlags.ts` — changed default from `env === 'true'` to `env !== 'false'`. The scan-identify Edge Function is now the default path. It can be explicitly disabled by setting `EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=false`.

### 3.2 Result mapping field names

**Problem:** `services/scanIdentificationMapper.ts` output `materialEstimate` and `confidenceScore` in `MappedScanMetadata`, but the legacy `LegacyAnalysisData` type and downstream UI (`ScanResultV2`, `app.js` StyleChat handoff) expected `material` and `confidence`. This caused data loss in result rendering and StyleChat context.

**Fix:** Renamed fields in `MappedScanMetadata` and `buildMetadata()`:
- `materialEstimate` → `material`
- `confidenceScore` → `confidence`

### 3.3 Save to Closet attribute preservation

**Problem:** `services/library.js` `saveScan()` only stored `category`, `silhouette`, `color_palette`. It dropped `itemType`, `material`, `pattern`, `texture`, `occasion`, `styleTags`, and `confidence` from the scan-identify response.

**Fix:** Updated `saveScan()` to preserve all available metadata fields:
- `material_estimate` from `analysis.metadata?.material`
- `pattern` from `analysis.metadata?.pattern`
- `texture` from `analysis.metadata?.texture`
- `occasion` from `analysis.metadata?.occasion`
- `style_tags` from `analysis.metadata?.styleTags` (array)
- `confidence_score` from `analysis.metadata?.confidence` (number)

### 3.4 Save to Closet button (V2 results)

**Problem:** In `app.js`, the `ScanResultV2` `onSaveToLibrary` prop was a no-op comment (`/* already auto-saved to library */`). If the auto-save failed or the user dismissed before it completed, the manual save button did nothing.

**Fix:** Changed `onSaveToLibrary` to explicitly call `saveScan()` with the current photo and analysis, and show `SavedToast` on success. This provides a reliable manual fallback.

---

## 4. Database / Storage

| Layer | Used | Details |
|---|---|---|
| **Local persistence** | Yes | `FileSystem` (`kscan_library.json`, `images/`, `thumbnails/`) |
| **Cloud persistence** | Opt-in | `saved_scans` table via `saveScanToCloud()` (fire-and-forget, flag-gated) |
| **Migrations added** | None | Reused existing `saved_scans` migration (20260617215307) |
| **RLS added/verified** | None | Existing `saved_scans` RLS assumed; no live staging verification performed |
| **Storage buckets** | Local only | No Supabase Storage used for scan images in this slice |
| **Signing** | N/A | Local file paths used directly |

---

## 5. Validation

| Check | Result | Notes |
|---|---|---|
| **tsc** | ✅ Pass | `node node_modules/typescript/lib/tsc.js --noEmit` — no errors |
| **node tests** | ✅ Baseline | Same 3 pre-existing failures as before (`authPrivacy`, `useKScanDuplicateGuard`, `verifyAppleReadiness`). No new failures introduced. |
| **deno check** | ⏸️ Deferred | `deno` CLI not available in environment. `scan-identify` function reviewed manually for syntax and structure — no obvious issues. |
| **git diff check** | ✅ Pass | No whitespace issues |

---

## 6. Manual Smoke

| Step | Status | Notes |
|---|---|---|
| **Runtime available** | ❌ No | No Metro / physical device / emulator in this environment. Smoke deferred. |
| **Scan identify** | ⏸️ Deferred | Requires live app runtime with camera and Supabase auth session |
| **Save to Closet** | ⏸️ Deferred | Requires scan result to trigger save flow |
| **Closet render** | ⏸️ Deferred | Requires saved item in local `FileSystem` |
| **Closet reload** | ⏸️ Deferred | Requires app restart or screen refocus |
| **Remove flow** | ⏸️ Deferred | Requires saved item to delete |

**Deferred reason:** This is a code-audit-and-fix environment. No React Native runtime, Metro bundler, or physical device is available. The changes are logic-only (feature flag, field mapping, persistence shape, button handler). Runtime validation must be performed on-device or in a simulator with a working Supabase auth session.

---

## 7. Remaining Gaps

### 7.1 Product matching
- **Status:** Not connected. `scan-identify` returns `recommendedProducts: []` by design.
- **Impact:** Scan results show fashion attributes only. No purchase links, prices, or retailers.
- **Recommended next step:** Connect product matching when a real product data source is available. Do not fabricate.

### 7.2 Provider/API gaps
- **Status:** `scan-identify` depends on `GEMINI_API_KEY` being set in the Supabase Edge Function environment.
- **Impact:** If the key is missing, the function returns `500: AI provider not configured`.
- **Recommended next step:** Verify `GEMINI_API_KEY` is set in the staging Supabase dashboard (Edge Function secrets).

### 7.3 Runtime gaps
- **Status:** No live smoke performed.
- **Impact:** Cannot confirm end-to-end flow on a real device.
- **Recommended next step:** Run the manual smoke test on a physical device or iOS/Android simulator with:
  1. Supabase auth session active
  2. `EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED` not set to `false`
  3. Camera permission granted

### 7.4 Cloud sync
- **Status:** `CLOUD_SAVED_SCANS_ENABLED` is `false` by default.
- **Impact:** Scans are local-only. They do not sync across devices or survive app uninstall.
- **Recommended next step:** Enable `CLOUD_SAVED_SCANS_ENABLED` in staging after verifying `saved_scans` table and RLS are deployed.

### 7.5 Deno/type-check gap
- **Status:** `deno check` not run.
- **Impact:** Cannot guarantee `scan-identify` Edge Function is type-error-free.
- **Recommended next step:** Run `deno check supabase/functions/scan-identify/index.ts` in a Deno-enabled environment.

---

## 8. Files Changed

| File | Change |
|---|---|
| `constants/featureFlags.ts` | `SCAN_IDENTIFY_BACKEND_ENABLED` now defaults to `true` (enabled unless explicitly disabled) |
| `services/scanIdentificationMapper.ts` | Renamed `materialEstimate` → `material`, `confidenceScore` → `confidence` to match legacy analysis shape |
| `services/library.js` | `saveScan()` now preserves all scan attributes: `material`, `pattern`, `texture`, `occasion`, `style_tags`, `confidence_score` |
| `app.js` | `onSaveToLibrary` in `ScanResultV2` now explicitly calls `saveScan()` and shows `SavedToast` on success |

---

## 9. Explicit Notes

### Product matching status
**Partial / not yet connected.** The `scan-identify` Edge Function intentionally returns `recommendedProducts: []`. The frontend handles this gracefully — `ScanResultV2` shows fashion attributes with empty purchase/shelf states. No fake retailers, prices, or match percentages are invented. This is compliant with the "no fake commerce" product rule.

### Backend path
- **Primary:** `scan-identify` Supabase Edge Function (Gemini vision, auth-required)
- **Fallback:** `POST /api/analyze` on Render API (currently unreachable, disabled by default)
- **Recommended:** Keep `scan-identify` as primary. Re-enable Render fallback only if Render service is restored and provides value beyond the Edge Function.

### Auth requirement
The `scan-identify` Edge Function requires an authenticated user. Anonymous scans will return `401: Not authenticated`. The client adapter (`services/scanIdentification.ts`) pre-checks the session and returns a user-safe message (`SIGN_IN_REQUIRED_MESSAGE`) before the network call. This is intentional and aligns with the privacy-first architecture.

---

*Report generated by KS-BACKEND-VALIDATION-001 Backend Integration Agent.*
