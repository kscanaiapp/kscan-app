# Production Stylist Voice — 502 Diagnosis and P1 Fix

WORKSPACE: `C:\src\KScan-stylist-voice-integration-20260714`
BRANCH: `feature/elevenlabs-stylist-voice`
STARTING_HEAD: `5313cff2eeffb0c8d207fb344103b614a2cba1ce`
SCOPE: Narrow P1 — diagnose and correct the sanitized production `stylist-speech`
HTTP 502. No feature expansion, no client/avatar/lip/preference/StyleChat change.

## Evidence

- Edge request log for the single controlled invocation:
  `POST | 502 | .../functions/v1/stylist-speech | execution_time_ms: 1718 | version 1`.
- Deployed functions confirmed: `stylist-speech` ACTIVE version 1 (verify_jwt on);
  `stylechat-generate` untouched at version 52.
- 1,718 ms rules out a pre-dispatch failure (sub-millisecond) and the 15 s
  provider timeout. It is consistent with a real ElevenLabs HTTP rejection.

## Root-cause localization

The request construction was already contract-correct before this phase:

- URL: `POST /v1/text-to-speech/{voice_id}/with-timestamps`, voice ID
  URL-encoded and placed only in the path.
- `output_format=mp3_44100_128` in the query string (not the body).
- Body: `{ "text", "model_id" }` only.
- Headers: `xi-api-key`, `Content-Type` (now also `Accept: application/json`).
- Secrets trimmed; provider timeout 15 s.

The defect was diagnostic, not constructional: `elevenLabsClient.ts` collapsed
every non-429 provider failure into a generic 502 `PROVIDER_UNAVAILABLE` and
never inspected the provider error body, so the underlying ElevenLabs status
(`detail.status`) — the definitive cause — was discarded and unobservable.

## Fix (this phase)

- `secretConfig.ts` — hardened secret reads: trim, then reject empty,
  placeholder, accidentally quoted, whitespace, or wrong-format values as
  `SERVER_CONFIGURATION` without echoing the stored value.
- `providerFailure.ts` — classify a bounded (≤ 4 KB) provider error body into
  app-owned categories: `provider_auth_failed` (401/403), `provider_voice_unavailable`
  (404, voice-scoped 403), `provider_model_unavailable` (model-scoped 422),
  `provider_invalid_request` (400/422), `provider_quota_exceeded` (429),
  `provider_unavailable` (5xx). Only a short, token-shaped provider status is
  retained; the raw body is never surfaced.
- `providerDiagnostics.ts` — emit one secret-free diagnostics line per request:
  correlation id, voice profile, failure kind, provider status, category, JSON
  flag, sanitized provider error token, response byte length, elapsed ms, model,
  output format, and a SHA-256 voice fingerprint (12 hex chars). Never logs the
  API key, full voice ID, request text, or audio.
- `elevenLabsClient.ts` — wire the above into every terminal path; the public
  error contract stays sanitized. The mobile client already ignores the server
  error code, so the new categories introduce no client regression.

## Validation

- Edge Function tests: PASS — 57/57 (30 baseline + 27 added/updated).
- `deno check` (all `stylist-speech` sources + tests): PASS.
- `git diff --check`: clean.
- No migrations, schema, RLS, auth, or secret-value changes. Only
  `stylist-speech` sources touched.

## Remaining — owner/device actions

The exact provider cause is now *instrumented* but not yet *observed*, because a
JWT-protected on-device (or owner-credentialed) invocation is required to run it,
and the ElevenLabs key is a sealed Supabase secret. After redeploying
`stylist-speech`, run one controlled feminine request and read the
`stylist_speech_provider` diagnostics line:

- `provider_auth_failed` / provider 401 → the restricted ElevenLabs API key is
  invalid or lacks **Text to Speech** permission. Enable that scope on the key
  (do not rotate/print here).
- `provider_voice_unavailable` / provider 404 or 403 → the configured voice
  (`NQMJRVvPew6HsaebYnZj` feminine / `guZ5txGiatiDmC3jrjOO` masculine) is not
  accessible to this key/workspace. Grant access; do not substitute a voice.
- `provider_model_unavailable` → `eleven_flash_v2_5` unavailable to the account;
  report before any model change (owner approval required).
- `SERVER_CONFIGURATION` → a stored secret value is quoted/whitespaced/malformed;
  correct the secret value (do not overwrite without owner confirmation).

Do not use the second authorized paid request to retry an unchanged failure.
