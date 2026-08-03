# Provider Edge Function Authentication

Status: shared foundation implemented and unit-tested; not yet deployed to staging.
Branch: `security/provider-edge-auth-hardening`. Module: `supabase/functions/_shared/security/context.ts`.

## What it does

Every provider-backed function calls `authenticateRequest(req)` before doing any other work. It:

1. Extracts the bearer token from `Authorization: Bearer <token>`. Missing or malformed → `unauthorized`.
2. Verifies the token via `supabaseClient.auth.getUser()` (the current supported Supabase server-side flow — this makes a live call to GoTrue, so an expired/revoked/forged token is rejected by Supabase itself, not by local JWT parsing). Failure → `unauthorized`.
3. Derives `userId` **only** from the verified `user.id` returned by `getUser()` — never from the request body or a client-supplied header. A `test-request-boundary` regression test (`context.test.ts`) sends a spoofed `X-User-Id` header alongside a valid token and asserts the returned context still uses the token's real user ID.
4. Loads `public.profiles.account_status` for that user via the same RLS-scoped client (self-read policy already exists; no service-role key needed for this check).
5. Rejects unless `account_status` is in the allowed list — **default `['active']` only**. This repository's actual schema (`supabase/migrations/202605130000_profiles_privacy_status.sql`) has exactly three states: `active`, `pending_deletion`, `locked`. There is no separate suspended/blocked/disabled column — `locked` is the single non-active blocked state, and `pending_deletion` is the deletion-pending state. Both are rejected by default.
6. **Fails closed**: a missing profile row, a DB error, or an unrecognized `account_status` value all deny the request (`account_unavailable`) rather than defaulting to allow.
7. Returns a normalized context: `{ userId, sessionId, accountState, requestId }`. `sessionId` is a best-effort, non-authoritative read of the JWT's `session_id` claim for log correlation only — never used in an authorization decision. `requestId` is a fresh `crypto.randomUUID()` per request, safe to return to the client.

## What is never logged

The token itself and the full `Authorization` header are never passed to `logSecurityEvent` or `console.*`. Only `safeUserIdFragment(userId)` (first 8 characters) appears in logs, matching the truncation convention already used elsewhere in this codebase (e.g. `stylechat-generate`'s pre-existing `uid=%s` logs).

## Testing

`supabase/functions/_shared/security/context.test.ts` — 12 tests, using dependency injection (`AuthenticateOptions.clientFactory`, test-only, unused in production) to substitute a fake Supabase client instead of a live network call: missing token, malformed header, invalid/expired token (via a rejecting fake client), valid active user, `pending_deletion` rejection, `locked` rejection, missing profile row, profile-lookup error, a caller override of `allowedAccountStates`, and the anti-spoofing test above.

## Known gap

`scan-identify` is **not** on the verified security base branch (`origin/ios/full-submission-readiness-v2` @ `5adf76e`) and is therefore not yet hardened by this guard. See the PR description for the branch-reconciliation decision. Every other in-scope function (`stylechat-generate`, `product-search-deals`, `search-vinted-secondhand`, `tryon-clothes-pro`, `kickscrew-sneaker-description`, `nike-shoe-details`) is present and can adopt `authenticateRequest` the same way `stylechat-generate` does.
