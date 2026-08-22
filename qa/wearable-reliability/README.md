# Wearable reliability harness

Scripted end-to-end verification of the `wearable-bridge` protocol against the
**live K Scan AI Staging** Supabase project (`yzqjvdfgefveprobvvyw`), simulating
both the glasses and phone roles over real HTTPS calls — not mocks, not unit
tests. Written during the 2026-08-22 Google XR physical-device-candidate
takeover to independently re-verify the reliability matrix from the build plan
against the actual deployed backend, rather than trusting a prior session's
self-report.

## Running it

```
node matrix.mjs      # pairing, sessions, scan cycles, actions, error recovery,
                      # reconnect, replay — ~2-4 minutes, creates/cleans up
                      # throwaway auth.users via the *.invalid TLD (RFC 2606)
node expired.mjs      # expired-challenge rejection — ~2.5 minutes (real wait
                      # for the 120s pairing TTL to elapse)
```

Both scripts create real rows in staging (`auth.users`, `wearable_pairings`,
`wearable_sessions`, `wearable_results`, `wearable_actions`, `saved_scans`) and
print a PASS/FAIL summary per batch. **Neither script deletes its own test
data automatically** — after a run, clean up via SQL (see below) so staging
doesn't accumulate throwaway accounts.

```sql
-- cleanup, in FK-safe order
delete from wearable_actions where user_id in (select id from auth.users where email like 'xr-reliability-%@kscan-test.invalid');
delete from wearable_results where user_id in (select id from auth.users where email like 'xr-reliability-%@kscan-test.invalid');
delete from wearable_messages where session_id in (select id from wearable_sessions where user_id in (select id from auth.users where email like 'xr-reliability-%@kscan-test.invalid'));
delete from wearable_sessions where user_id in (select id from auth.users where email like 'xr-reliability-%@kscan-test.invalid');
delete from wearable_pairings where user_id in (select id from auth.users where email like 'xr-reliability-%@kscan-test.invalid');
delete from wearable_auth_attempts where user_id in (select id from auth.users where email like 'xr-reliability-%@kscan-test.invalid');
delete from saved_scans where user_id in (select id from auth.users where email like 'xr-reliability-%@kscan-test.invalid');
delete from auth.users where email like 'xr-reliability-%@kscan-test.invalid';
```

## Two real platform limits this harness works around

1. **`pair.approve` is rate-limited to 10 attempts per user per 2-minute
   window** (server-side, `throttlePairAttempt` in `wearable-bridge/index.ts`)
   — a real anti-brute-force control, not a bug. `matrix.mjs` uses a small
   pool of throwaway users, round-robin, capped under this limit, instead of
   one user hammering `pair.approve` dozens of times.
2. **Supabase GoTrue's signup endpoint has its own burst rate limit**
   (`over_request_rate_limit`), independent of the app. `makeTestUser`/
   `makeUserPool` stagger signups and back off with retries when hit.

## What this does and doesn't prove

Covers, against the real backend: pairing (create/approve/poll), expired
challenges, replay, wrong-session rejection, explicit revoke, sign-out revoke,
scan cycles (capture → phone → result), Save/Open-on-Phone idempotency
(including DB-level de-duplication, not just the API response), malformed/
oversized-payload rejection, and cursor-based poll resumption across a
simulated reconnect gap.

Does **not** cover: real ML Kit face detection (needs a real Android
runtime — verify via `testDebugUnitTest`/an installed APK, not this harness),
Compose UI rendering, or physical hardware. Cancel/Retry is enforced
client-side (an `AsyncStorage` flag in the phone app, not backend state) —
verify that by reading `app.js`'s `isWearableScanCancelled` guard, not with
this harness.
