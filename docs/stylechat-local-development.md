# StyleChat local development

Android emulator builds may intentionally use local Supabase while deployed phone builds use their configured remote project. Keep those targets explicit; never fall back from a failed local backend to production.

## Client target

For the Android emulator, the local client URL is `http://10.0.2.2:54321`. The host-side Supabase URL remains `http://127.0.0.1:54321`. Store the local public client variables in the ignored root `.env.local`:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Confirm Expo reports `.env.local` during the debug build. Do not commit either file or print session tokens.

## Edge Function and Gemini environment

Create an ignored `supabase/.env.local` for function-only local secrets:

- `GEMINI_API_KEY` — required and nonempty
- `STYLECHAT_GEMINI_MODEL` — required for an explicit local model choice

`stylechat-generate` reads `GEMINI_API_KEY` exactly. Its model precedence is `STYLECHAT_GEMINI_MODEL`, then `GEMINI_MODEL`, then the code default. Never place provider credentials in an `EXPO_PUBLIC_` variable.

Start the local stack and serve functions with JWT verification left enabled:

```powershell
npx supabase start
npx supabase functions serve --env-file supabase/.env.local
```

Keep the serve process running while testing. Do not use `--no-verify-jwt`.

## Safe readiness checks

```powershell
npx supabase status
curl.exe -i -X OPTIONS http://127.0.0.1:54321/functions/v1/stylechat-generate
```

Expected: local API/auth services running, Edge Runtime/function serving, and OPTIONS 200. From the emulator, `10.0.2.2` must be reachable.

Failure classification:

- HTTP 503 before function logs: local Edge Runtime/function process is not running.
- HTTP 401: inspect the local authenticated session/JWT contract; do not disable verification.
- HTTP 500 with provider-not-configured classification: inspect the ignored function env file and exact secret name.
- Gemini 401/403: local provider credential rejected.
- Gemini 404: configured model unavailable or misspelled.
- Gemini 429: provider quota/rate limit.

The client should retain the failed text for one-shot retry and show an actionable error banner. A handled 5xx/network/timeout must not be persisted as an assistant answer or produce a React Native warning badge.
