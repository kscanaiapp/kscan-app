# GLASSES XR Isolated Prototype

## Overview

This directory contains a **mock-only, isolated prototype** for the Google Glasses / XR integration layer in the K Scan AI mobile app.

It is **intentionally separate** from:

- `android-xr/` — the native Android XR glasses project
- `phone-bridge/` — the TypeScript phone-to-glasses bridge
- `backend/` — the K Scan backend services
- `supabase/` — Supabase Edge Functions and database

## What was created

```
types/glasses.ts                          — shared TypeScript types
services/glasses/mockGlassesService.ts    — deterministic mock service
components/glasses/GlassesResultPreview.tsx — React Native result preview UI
components/glasses/GlassesPrototypeScreen.tsx — standalone prototype screen
__tests__/glasses/mockGlassesService.test.js — unit tests for the mock service
docs/glasses/GLASSES_XR_ISOLATED_PROTOTYPE.md — this document
```

## Isolation guarantees

| Dependency | Status |
|---|---|
| Backend API routes | **Not used** |
| `scan-identify` Edge Function | **Not referenced** |
| `aiGateway` contract | **Not referenced** |
| Supabase client / auth / session | **Not referenced** |
| StyleChat / collaboration / shared rooms | **Not referenced** |
| Phone bridge (BLE / WiFi) | **Not referenced** |
| `android-xr` native modules | **Not referenced** |
| Camera / microphone / BLE / WiFi APIs | **Not referenced** |
| Expo Router routes | **Not created** |
| Navigation registration | **Not done** |
| Package / build / dependency changes | **None** |
| AndroidManifest / native permissions | **None** |

## How the mock service works

- `createMockGlassesSession()` returns a lightweight session object.
- `analyzeMockGlassesCapture(session, triggerId)` simulates a short local delay and returns deterministic mock data based on `triggerId`.
- `getMockGlassesResult()` returns a pre-canned high-confidence result.
- `getMockLowConfidenceResult()` returns a low-confidence edge case.
- `getMockErrorOutcome()` returns a forced error for UI testing.

No network requests are made. No images are uploaded. No auth tokens are accessed.

## Native Android shape alignment

The `GlassesMockResult` type uses field names aligned with the native Android result shape:

- `title`
- `summary`
- `category`
- `color`
- `silhouette`
- `confidence` (number 0.0 – 1.0)
- `createdAt` (ISO-8601 string)
- `imagePreviewUri` (local-only, marked null in mock builds)

This alignment makes future backend integration straightforward.

## Privacy / local-only language

The UI component includes this exact copy:

> "This is a local prototype preview. Cloud analysis is not connected in this build."

And a disabled placeholder:

> "Share to room — coming later."

No actual sharing behavior is implemented.

## Future phases

Planned integration roadmap (in order):

1. **Isolated mock UI** ← current phase
2. Internal demo route behind a feature flag
3. Phone bridge prototype (BLE / WiFi handoff)
4. Native glasses app integration
5. Backend integration behind a feature flag
6. Production hardening

Backend integration (phase 5) is explicitly **blocked** until the backend consolidation effort is complete.

## When to use this prototype

- Internal UI/UX demos
- Mock data visual validation
- Edge-case testing (low confidence, errors)
- Foundation for future feature-flagged integration

## When NOT to use this prototype

- Production user-facing features
- Real scan analysis
- Backend contract validation
- Native Android XR runtime testing

## Notes

- The `android-xr/` project remains a separate native workspace.
- This prototype is safe dead-end code unless explicitly imported later.
- No commit should include changes to `app/`, `backend/`, `supabase/`, `android-xr/`, `phone-bridge/`, or any build/config file.
