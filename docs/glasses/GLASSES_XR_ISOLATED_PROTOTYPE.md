# Glasses / XR Isolated Prototype

## What Was Created

An isolated Google Glasses / XR prototype layer inside the K Scan mobile app repo. This layer is completely self-contained and does not touch any active production code, backend contracts, or routing.

### Files Created

| File | Purpose |
|------|---------|
| `types/glasses.ts` | Self-contained type definitions for the glasses prototype (capture states, privacy status, result shape, error shape) |
| `services/glasses/mockGlassesService.ts` | Deterministic async mock service with no network calls, no backend dependencies, no auth |
| `components/glasses/GlassesResultPreview.tsx` | HUD-style result preview using only React Native primitives |
| `components/glasses/GlassesPrototypeScreen.tsx` | Screen-like wrapper with mock analysis trigger, reset, and error states |
| `__tests__/glasses/mockGlassesService.test.js` | Unit tests for the mock service using Node's built-in test runner |
| `docs/glasses/GLASSES_XR_ISOLATED_PROTOTYPE.md` | This documentation file |

## Why It Is Isolated

- No file under `app/` was created or modified.
- No Expo Router route was registered.
- `app/_layout.tsx` was not touched.
- No active mobile screen was modified.
- No backend call exists in the prototype layer.
- No `fetch`, no `XMLHttpRequest`, no network I/O.
- The mock service uses `setTimeout` only to simulate async behavior.

## Backend Dependency

**No.** This build is isolated and waits for the canonical backend contract before real analysis wiring.

The `GlassesPrototypeScreen` and `mockGlassesService` are consumers of a future backend contract, not modifiers of it. The canonical endpoint will be `POST /api/glasses/analyze-debug` (as verified in the `kscan-google-glasses` backend repo), returning a `FashionAnalyzeResult`-aligned shape.

## No Production Route Created

`GlassesPrototypeScreen` is a component only. It lives under `components/glasses/`, not under `app/`. To make it reachable in the future, a route registration in `app/` or a navigation entry will be required. That step is explicitly deferred until backend consolidation completes.

## No Existing File Modified

No existing file in the repo was modified for this prototype. All work is in new files.

## No Scan-Identify Dependency

- `scan-identify` untouched
- `supabase/functions/scan-identify/` untouched
- `gatewayContract.ts`, `gatewayAdapter.ts`, `gatewayValidation.ts` untouched
- `__tests__/scanIdentifyGatewayWiring.test.ts` untouched

## No AI Gateway Dependency

- `services/aiGateway/*` does not exist yet (managed by Backend Consolidation Manager)
- `types/aiGateway.ts` does not exist yet
- No import from any gateway module

## No Active Mobile Routing Changed

- `app/_layout.tsx` untouched
- `app/text-scan/index.tsx` untouched
- `app/scan/` untouched
- `app/style-chat/` untouched
- `app/onboarding/` untouched
- No tab or stack layout modified

## No StyleChat Dependency

- No StyleChat import
- No StyleChat session/conversation dependency
- No room collaboration sync

## No Collaboration Sync Dependency

- No shared-room import
- No room message import
- No reaction import
- No broadcast or websocket usage

## No Supabase Dependency

- No `supabaseClient` import
- No Supabase Edge Function call
- No database query
- No RLS policy reference

## No Auth / Session Dependency

- No `AuthSessionContext` import
- No `useAuthSession` hook
- No JWT or token handling
- User identity is hard-coded as `glasses-prototype-user` for mock display only

## No Android / Native Config Changed

- `AndroidManifest.xml` untouched
- `app.json` untouched
- `eas.json` untouched
- `package.json` untouched
- `package-lock.json` untouched
- `metro.config.js` untouched
- `babel.config.js` untouched
- No Android permissions added or removed
- No native module changes

## Privacy Guardrails

- No raw image upload path exists in the prototype.
- `imagePreviewUri` is explicitly marked as `LOCAL-ONLY preview. Never send to backend.`
- The mock privacy status is always `'local_only'`.
- No Zero-Knowledge masking claim is made.
- The result preview includes this exact copy:

  > "This is a local prototype preview. Cloud analysis is not connected in this build."

- No real glasses cloud analysis is connected.
- No production device-readiness claim is made.

## Mock Shape Alignment

The `GlassesMockResult` interface aligns with the native Android repo's `FashionAnalyzeResult` naming:

| Native Android (kscan-google-glasses) | React Native Prototype |
|---------------------------------------|------------------------|
| `result` (title + summary) | `title` + `summary` |
| `category` | `category` |
| `color` | `color` |
| `silhouette` | `silhouette` |
| `products` | `products` (not yet in prototype; planned for future) |

This alignment reduces future rewrite when the canonical backend contract is wired.

## Future Integration Comments

Each file includes a TODO comment with the exact canonical endpoint and expected shape:

```
// TODO(Glasses-Backend-Integration): After backend consolidation completes,
// replace this mock with the canonical gateway-backed implementation.
// DO NOT import aiGateway or scan-identify directly from this prototype layer.
// Expected canonical endpoint: POST /api/glasses/analyze-debug
// Expected result shape: FashionAnalyzeResult (align with native Android repo)
```

## Validation

Validation was not run because this was a code-only agent pass. Tests can be executed with:

```bash
node --test __tests__/glasses/mockGlassesService.test.js
```

## Risks Remaining

| Risk | Severity | Mitigation |
|------|----------|------------|
| Component not tested in a real React Native runtime | Medium | Future terminal verification pass |
| No actual route exists to reach the screen | Low | By design — deferred until backend consolidation |
| Type-only imports from `types/glasses.ts` may need adjustment when real backend contract lands | Low | Types are self-contained and will be replaced |
| `GlassesPrototypeScreen` uses dynamic import for `analyzeWithError` which may not work in all bundlers | Low | The import is local and the function is in the same module; can be changed to static import if needed |

## Next Recommended Action

Run a terminal verification pass on the isolated glasses/XR files:

1. `node --test __tests__/glasses/mockGlassesService.test.js`
2. Verify TypeScript compilation of the new files via `tsc --noEmit` (if configured)
3. Optionally render `GlassesPrototypeScreen` in a Storybook-like isolated preview or a temporary debug route

Do not register a production route until backend consolidation completes.
