# Backend Debug Mode Plan

## Goal

Enable controlled backend analyze testing against a staging environment without exposing credentials, secrets, or enabling real user uploads by default.

## Backend URL Placeholder

- The backend URL is **never hardcoded in source** as a production endpoint
- `BuildConfig.KSCAN_BACKEND_URL` is the only compile-time URL reference
- For debug mode, a **staging URL** can be injected via:
  - `local.properties` (developer-only, gitignored)
  - Environment variable at build time
  - Runtime configuration (debug-only settings screen, future)
- Production URL is not used in any debug build by default

## Required Debug Flags

To enable real backend analyze, **all** of the following must be true:

1. `BuildConfig.DEBUG == true` (debug builds only)
2. `BetaConfig.enableRealAnalyze == true` (explicit opt-in)
3. `BetaConfig.enableRealFaceMasking == true` (privacy gate)
4. `AnalyzeClientConfig.backendUrl` is non-empty and points to staging

If any of these is false, `RealAnalyzeClient` throws `AnalyzeException.Disabled`.

## No Credentials in Source

- No API keys in Kotlin source files
- No service role keys in source
- No Supabase anon keys in source
- No Render API tokens in source
- Auth/session handling is out of scope for Phase 3; will be addressed in Supabase integration phase

## Test-Only Local Sample Payload Strategy

- Unit tests use `MockAnalyzeClient` only (no real network)
- Integration tests (future) may use a local test server or recorded responses
- `FakeHttpTransport` in unit tests simulates network behavior without real calls
- No real image data in test fixtures; use synthetic base64 strings only

## Render Endpoint Expectations

- POST `/api/analyze`
- Content-Type: `application/json`
- Body: `{ "image": "data:image/jpeg;base64,..." }`
- Timeout: 10 seconds (client-side)
- Success response: `200 OK` with JSON body matching `FashionAnalyzeResult` shape
- Non-fashion response: `200 OK` with `{ "type": "non-fashion", "message": "..." }`
- Error responses: `4xx/5xx` with `{ "message": "..." }` (optional)

## Response Schema Assumptions

```json
{
  "result": "string",
  "type": "fashion",
  "metadata": {
    "category": "string",
    "color": "string",
    "silhouette": "string"
  },
  "products": [
    {
      "id": "string",
      "name": "string",
      "retailer": "string",
      "price": "string",
      "imageUrl": "string?",
      "productUrl": "string?"
    }
  ]
}
```

## CORS / Auth Notes

- CORS is not relevant to native Android apps (no browser origin restriction)
- Auth/session tokens will be handled via Supabase integration later
- For debug mode, the endpoint may accept anonymous requests with rate limiting
- Production auth will require JWT/session validation via Supabase

## Privacy Checklist Before Enabling Debug Analyze

- [ ] Face masking is implemented and tested (ML Kit)
- [ ] Privacy sanitizer runs before any upload
- [ ] No raw upload fallback exists
- [ ] No real user images are uploaded in unit tests
- [ ] Backend staging URL is not exposed in source
- [ ] Debug flag is documented and requires explicit opt-in
- [ ] Build is debug-only; release builds block real analyze

## Rollback Plan

If debug analyze causes issues:

1. Set `enableRealAnalyze=false` in `BetaConfig`
2. Rebuild debug APK
3. Mock path resumes automatically
4. No user data is at risk because mock path never uploads
