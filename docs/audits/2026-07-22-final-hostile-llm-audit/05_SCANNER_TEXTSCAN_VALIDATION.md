# Scanner and TextScan validation

## Source reconciliation

The Step 1 deployment began as deployed code without a clean committed source, a P1. The exact Scanner/TextScan migration was isolated from the dirty `C:\Users\jsmit\KScan` evidence workspace, ported to a clean worktree, tested, committed (`50a3038…`), pushed, and merged into the canonical branch through PR 22 (`300ea878…`). Later telemetry source was committed at `72a6fab…` and redeployed.

Production `scan-identify` is now version 131, `verify_jwt=true`, bundle SHA-256 `67c1d1d…`, and aligned with committed/pushed source.

## Live attribution

| Request ID | Surface | Primary | Served | Fallback | Provider | Valid | Quota |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `abf3f0bc-50fe-498e-8c93-27204fab9883` | scanner | `gemini-3.6-flash` | `gemini-3.6-flash` | false | ok | true | consumed |
| `audit-textscan-postpriv-1784690645078-8ced543f` | textscan | `gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` | false | ok | true | consumed |

The Scanner request was created by the final committed Android emulator build. The UI displayed a completed analysis for the non-sensitive dress fixture. TextScan previously completed from the authenticated emulator and produced a valid fashion result.

## Controlled fallback

- Injected primary unavailability: Scanner fell back to Flash-Lite, returned one valid result, recorded `fallback_used=true`, `fallback_reason=http_unavailable`, two attempts, and one consumed quota event.
- Injected total provider unavailability: response failed safely, quota was refunded exactly once, and the user message was non-provider-specific.
- Fault-injection code was removed after validation; it was never merged into canonical production source and the temporary secret was removed.

## Invalid and security behavior

- Missing/invalid auth terminates before quota or provider invocation.
- Oversized, malformed, unsupported, and privacy-unprepared inputs fail before provider execution.
- Non-retryable auth, ownership, quota, validation, and policy failures do not invoke fallback.
- Image payloads and provider bodies are not stored in `llm_routing_events`.

## Mobile integration repairs

Two global audit gates made the Scanner impossible to test:

1. `privacyImageUpload.ts` always reported uploads unavailable.
2. `privacyImageSanitizer.js` rejected every image unless unavailable face/plate masking had run.

PR 25 enabled bounded JPEG re-encoding and metadata stripping. PR 26 replaced the impossible pixel-mask prerequisite with truthful preparation evidence: metadata stripping is required; face/plate capability fields remain false rather than being fabricated. Missing or invalid preparation still fails closed. Focused tests passed 140/140 and the full suite passed 1336/1336.
