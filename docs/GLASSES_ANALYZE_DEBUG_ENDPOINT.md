# Glasses Analyze Debug Endpoint

Isolated backend endpoint for the Google glasses controlled live smoke test (Phase 3C).

## Verified Status

- **npm install:** ✅ Clean (72 packages installed, 0 vulnerabilities in production dependencies)
- **Unit tests:** ✅ 20/20 pass (validation, service, error mapping, disabled mode, auth hardening, mock determinism, no-proxy)
- **Smoke tests:** ✅ 7/7 pass (disabled mode, enabled without token, missing image, invalid prefix, bad token, valid mock, no payload leakage)
- **Static safety review:** ✅ No payload logging, no persistence, no hardcoded secrets, no raw exception leakage, no live URL hardcoding
- **Live calls:** ❌ None performed (intentionally)
- **Android changes:** ❌ None
- **INTERNET permission added:** ❌ None
- **Open unauthenticated endpoint:** ❌ None (enabled=true requires token)
- **Accidental proxy calls:** ❌ None (mock-only by default)

## Endpoint

```
POST /api/glasses/analyze-debug
```

## Request Contract

Headers:
- `Content-Type: application/json`
- `Authorization: Bearer <debug token>` (required when `KSCAN_GLASSES_ANALYZE_ENABLED=true`)

Body:
```json
{
  "image": "data:image/jpeg;base64,...",
  "requestId": "optional-client-request-id",
  "client": "google-glasses-alpha"
}
```

- `image` is required and must be a JPEG data URL (`data:image/jpeg;base64,…`).
- Maximum payload size: 8 MB (string length).

## Response Contract

Success (HTTP 200):
```json
{
  "ok": true,
  "requestId": "server-or-client-request-id",
  "result": {
    "title": "Short fashion result title",
    "summary": "One or two short HUD-safe sentences.",
    "confidence": 0.0,
    "attributes": [
      { "name": "category", "value": "jacket" }
    ],
    "suggestions": ["Short suggestion"],
    "safeForHud": true
  },
  "meta": {
    "source": "debug-backend",
    "mode": "debug",
    "model": "mock-or-configured-model"
  }
}
```

Error (HTTP 4xx/5xx):
```json
{
  "ok": false,
  "requestId": "server-or-client-request-id",
  "error": {
    "code": "INVALID_IMAGE",
    "message": "The image could not be analyzed."
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN` | Bearer token for debug endpoint (required when enabled) |
| `KSCAN_GLASSES_ANALYZE_ENABLED` | `true` to enable the endpoint; defaults to `false` |
| `KSCAN_GLASSES_ANALYZE_MODEL` | Model label for meta response (e.g., `gemini-2.0-flash`) |
| `KSCAN_GLASSES_ANALYZE_BACKEND_URL` | URL of the existing K Scan backend to proxy analyze calls (optional; if blank, mock is used) |

## Auth Behavior

- The endpoint is **disabled by default** (`KSCAN_GLASSES_ANALYZE_ENABLED` must be exactly `true`).
- When enabled, a **token is required**. If `KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN` is blank or unset, the endpoint returns `CONFIG_DISABLED` (HTTP 503).
- When enabled and a token is configured, the endpoint requires `Authorization: Bearer <token>`.
- A bad token returns `UNAUTHORIZED` (HTTP 401).

This prevents accidental public unauthenticated exposure of the image endpoint.

## Size Limit

- Rejects images > 8 MB with HTTP 413 `PAYLOAD_TOO_LARGE`.

## No-Persistence Rule

- Image payloads are never written to disk or database.
- No raw model responses are stored.

## No-Logging Rule

- The endpoint does not log image payloads, base64 strings, data URLs, or request bodies.
- Raw exception messages are never returned to the client.

## Safe Error Codes

| Code | HTTP |
|------|------|
| `METHOD_NOT_ALLOWED` | 405 |
| `INVALID_JSON` | 400 |
| `MISSING_IMAGE` | 400 |
| `INVALID_IMAGE` | 415 |
| `PAYLOAD_TOO_LARGE` | 413 |
| `UNAUTHORIZED` | 401 |
| `CONFIG_DISABLED` | 503 |
| `MODEL_UNAVAILABLE` | 503 |
| `RATE_LIMITED` | 429 |
| `SAFE_BACKEND_FAILURE` | 500 |

## Proxy / Real Service Safety

`RealGlassesAnalyzeService` (used only when `KSCAN_GLASSES_ANALYZE_BACKEND_URL` is set):

- **Never used by default** — requires explicit `KSCAN_GLASSES_ANALYZE_ENABLED=true` + `KSCAN_GLASSES_ANALYZE_BACKEND_URL`.
- **HTTPS-only** — rejects non-HTTPS backend URLs.
- **15-second timeout** — uses `AbortController` to prevent indefinite hangs.
- **No payload logging** — does not log request bodies, images, or raw responses.
- **Safe error mapping** — backend errors map to `MODEL_UNAVAILABLE` or `RATE_LIMITED`; raw errors are never exposed.
- **No persistence** — images are forwarded in memory only.

If the proxy path is not needed, leave `KSCAN_GLASSES_ANALYZE_BACKEND_URL` blank and the endpoint returns safe mock responses.

## How This Supports Phase 3C

This endpoint provides a controlled, isolated boundary for the Google glasses live smoke test:

1. It validates the sanitized JPEG data URL from the Android client.
2. It checks auth and config gates before any model or backend call.
3. It proxies to the existing K Scan `/api/analyze` when configured, reusing the secure model client.
4. It maps the backend response into a minimal, HUD-safe shape.
5. When disabled or misconfigured, it returns safe mock responses so the client can test parsing without live model traffic.

## Standalone Server

A minimal server is provided in `backend/server.js` for local smoke testing:

```bash
cd backend
npm install
KSCAN_GLASSES_ANALYZE_ENABLED=true KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN=test-local-token KSCAN_GLASSES_ANALYZE_MODEL=mock-debug node server.js
```

## Confirmation

- No secrets were committed in source.
- No image payloads are logged by the endpoint.
- No images are persisted.
- No live model or backend calls were performed during this work.
- No deployment was performed.
- No Android files were modified.
- No `INTERNET` permission was added to Android manifests.

## Next Step Before Phase 3C Live Smoke Test

1. Set `KSCAN_GLASSES_ANALYZE_ENABLED=true` and `KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN=<token>` in `.env` (local) or hosting environment.
2. Optionally set `KSCAN_GLASSES_ANALYZE_BACKEND_URL` to the staging K Scan backend (e.g., `https://kscan-app-1.onrender.com`) for proxy mode.
3. Optionally set `KSCAN_GLASSES_ANALYZE_MODEL` for the meta response label.
4. Run the standalone server (`node backend/server.js`) or mount the router into the main K Scan backend.
5. Perform a single controlled call from the Google glasses client with all gates enabled and verify the HUD-safe JSON response.
