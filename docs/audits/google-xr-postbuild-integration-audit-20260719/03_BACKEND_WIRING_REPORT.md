# 03 — Backend Wiring Report

## Active debug route (proven)

```
GlassesDebugEndpointClient
  POST {KSCAN_DEBUG_ANALYZE_URL}
  Headers: Content-Type: application/json
           Authorization: Bearer {runtime token}
  Body: AnalyzeRequestJson → {"image":"data:image/jpeg;base64,…","client":"google-glasses-alpha"}
→ backend POST /api/glasses/analyze-debug
  → validateGlassesAnalyzeRequest (enabled + token + JPEG data URL + size)
  → MockGlassesAnalyzeService (when KSCAN_GLASSES_ANALYZE_BACKEND_URL unset)
  → HUD-safe JSON
→ GlassesDebugEndpointClient.parseResponse → FashionAnalyzeResult
```

Default debug install (no local.properties URL): `MockAnalyzeClient` (no network).

## Host local smoke (executed 2026-07-19)

| Case | Result |
|------|--------|
| `GET /api/glasses/health` | 200 `{"ok":true,"service":"kscan-glasses-debug-backend"}` |
| Bad Bearer | 401 |
| Valid token + JPEG data URL | 200 mock fashion HUD payload |
| Non-image payload | 415 |

Token used for smoke was runtime-only (`audit-local-smoke-token`); not committed.

## Auth posture

| Layer | Posture |
|-------|---------|
| Glasses debug endpoint | Fail-closed: disabled → 503; missing/invalid token → 503/401 |
| Android client token | **Not** in BuildConfig. Runtime provider only |
| Upstream `/api/analyze` | Still unauthenticated per `shared/api-contract.md` (inherited risk) |

## Repairs applied

1. Blank-token factory gate → `MockAnalyzeClient` (no empty Bearer).
2. `DebugAnalyzeCredentialProvider` + merge in `KScanApplication`.
3. Upstream proxy strips data-URL → bare base64 (`toBareBase64`).
4. Disabled service mode fails closed (`DisabledGlassesAnalyzeService`) instead of mock success.
5. `RealAnalyzeClient` uses `AnalyzeRequestJson.encodeUpstreamAnalyzeRequest`.

## Remaining external gates

- Controlled live upstream smoke (HTTPS + real auth if/when required by main backend).
- Android→emulator→host round trip with runtime token + debug URL (cleartext config added; not fully E2E exercised after XR stabilize).
- Session / phone Closet sync still stubs.
