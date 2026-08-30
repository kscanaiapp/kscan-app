# K Scan AI Privacy & Data Management Integration Notes

## Authentication and account-level privacy persistence

The app uses `@supabase/supabase-js` with an `AsyncStorage` session adapter for native session
persistence (`persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: false`).

On app boot, `AuthSessionProvider` (`contexts/AuthSessionContext.tsx`) calls
`supabase.auth.getSession()` and blocks child rendering behind a loading guard until auth state
is resolved. This prevents the Privacy screen from flashing "device-only mode" before the
session is known.

Auth method: **Email + Password** (`supabase.auth.signInWithPassword`). The sign-in route is
`app/auth.tsx`, accessible from the "SIGN IN TO SYNC" CTA on the Privacy screen.

## How privacy persistence works

```
Signed out   → preferences stored in AsyncStorage (device-local, truthfully labelled)
Signing in   → AuthSessionContext resolves session; PrivacyPreferencesProvider re-hydrates
Signed in    → preferences read from/written to public.privacy_settings via Supabase REST
               using the real session access_token (never a manually pasted token)
Signing out  → remote row cleared from context; device falls back to local-only mode
```

`services/supabasePrivacy.js` calls `supabase.auth.getSession()` on every remote request to
retrieve the current token, ensuring freshness after automatic token refresh. No token is cached
in a module-level variable in the production path.

Required Supabase env vars (both must be set for the project to be reachable):
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

## Provider order in app/_layout.tsx

```
AuthSessionProvider           ← outermost; resolves session before children render
  PrivacyPreferencesProvider  ← reads auth state via useAuthSession()
    Stack                     ← navigation
```

`PrivacyPreferencesProvider` reads `session`, `isAuthenticated`, `isRefreshing`, and
`loading` from `AuthSessionContext` via `useAuthSession()`. It re-hydrates whenever
`session?.access_token` changes (sign-in, sign-out, token refresh).

## Privacy context modes and syncStatus

`PrivacyPreferencesProvider` exposes a `mode` field:

| mode                  | when                                        |
|-----------------------|---------------------------------------------|
| `booting`             | auth session not yet resolved at startup    |
| `local`               | signed out; preference stored on device     |
| `remote-authenticated`| signed in; preference stored in Supabase    |

It also exposes `syncStatus`:

| syncStatus   | UI label          | meaning                                   |
|--------------|-------------------|-------------------------------------------|
| `synced`     | Saved to Account  | preference persisted to remote row        |
| `syncing`    | Syncing           | remote read or write in flight            |
| `local-only` | Saved to Device   | signed out; device-only storage           |
| `error`      | Could Not Sync    | remote call failed; last-known preference |

The Privacy screen renders a status chip driven by `syncStatus`.

## Write safety during session refresh

`persistPreference()` checks `authLoading` and `isRefreshing` before attempting a remote
write. If either is true, the call throws and the UI toggle is disabled. This prevents
race conditions where a write fires with a stale or expiring token.

## Local → remote preference merge on sign-in

When a user signs in, `PrivacyPreferencesProvider` merges local device preferences into
the remote account row using `mergePrivacyPreferences` and `mergeNeedsWrite` from
`services/privacyPolicy.js`.

Merge rules (always preserve the more privacy-protective choice):

| Local              | Remote             | Merged outcome          | Write? |
|--------------------|--------------------|-------------------------|--------|
| opt_out_of_sale ON | opt_out_of_sale OFF| ON                      | yes    |
| opt_out_of_sale ON | opt_out_of_sale ON | ON                      | no     |
| opt_out_of_sale OFF| opt_out_of_sale ON | ON (remote preserved)   | no     |
| opt_out_of_sale OFF| opt_out_of_sale OFF| OFF                     | no     |

`Local OFF never overwrites Remote ON.`

After sign-out and sign-back-in, the remote row is read fresh from Supabase — the prior
account preference is preserved.

## Mobile initialization

`PrivacyPreferencesProvider` calls `public.ensure_privacy_settings()` via
`services/supabasePrivacy.js` on first hydration when the user is signed in. The RPC verifies
`auth.uid()`, inserts a default `privacy_settings` row (`ON CONFLICT (user_id) DO NOTHING`),
applies under-16 sale/sharing defaults, and returns the row.

## DEV-ONLY: manual access token override

`EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN` is a development-only bridge for testing privacy
persistence without completing a real sign-in flow. It is **not** the production path.

- If a real Supabase Auth session is present, the session token always takes precedence.
- If set without a real session, a console warning `[KScan] DEV TOKEN IN USE` is shown.
- Remove or leave blank for normal operation.
- `setPrivacyAccessToken()` is deprecated and has no effect in production builds.

## Data category separation

Personal information subject to sale/sharing controls includes linked style preferences,
linked interactions, and account-level behavioral data that may be transferred for monetary
or other valuable consideration. `privacy_settings.opt_out_of_sale` applies to these
user-linked transfers.

Aggregated or deidentified trend reporting is separate. Aggregation jobs must not treat
user-linked monetization as the same thing as deidentified trend reporting.

Internal operational and diagnostic data includes app performance logs, request errors, and
security events where permitted. These data flows may have retention/security exceptions and
should be documented outside the mobile toggle.

Raw scan and derived fashion metadata require a production storage map. The mobile copy and
export manifest intentionally do not assume raw scans are retained. Derived fashion metadata
linked to a user should be reviewed for export. Signature Style vectors or embeddings are not assumed
exportable until legal review requires it.

## Minor users

When `profiles.age_group` is `under_13` or `age_13_to_15`, `ensure_privacy_settings()` forces
`opt_out_of_sale = true`. The mobile UI disables the toggle and shows:

"Sale or sharing of personal information is disabled for users under 16 unless legally valid
authorization is obtained."

The merge logic in `buildPrivacyUpdatePatch` also forces `opt_out_of_sale = true` for known
minor age groups, regardless of the merged input value.

## RLS and security

`public.privacy_settings` has RLS enabled. SELECT and UPDATE are scoped to
`user_id = auth.uid()` for the `authenticated` role. No other user's row is accessible.

`ensure_privacy_settings()` is a `SECURITY DEFINER` RPC that verifies `auth.uid() IS NOT NULL`
before any insert or select. It is `GRANT EXECUTE` to `authenticated` only.

RLS policies (from `supabase/migrations/202605130001_privacy_settings.sql`):
- `Users can read own privacy settings` — `for select ... using (user_id = auth.uid())`
- `Users can update own privacy settings` — `for update ... using (user_id = auth.uid()) with check (user_id = auth.uid())`

## GPC and GDPR

Global Privacy Control from web should write `privacy_settings.opt_out_of_sale = true` with
`last_request_source = 'gpc_web'`. Mobile reads the same row and preserves that setting unless
a legally valid user action changes it.

California opt-out state is not GDPR consent. The `gdpr_*` columns are placeholders for future
EU/UK consent and withdrawal logic after legal review.

## Request workflows

`handle-user-deletion` is idempotent for open requests and marks
`profiles.account_status = 'pending_deletion'`. Actual erasure should be performed by a
separate service-role workflow that handles retention, fraud/security exceptions, legal holds,
confirmation email, and audit logging.

`privacy-data-export` creates a request plus an export manifest. The production export worker
should gather profile, privacy settings, linked style preferences, linked interaction data, and
legally exportable derived fashion metadata.

`privacy-correction-request` stores structured correction details for review. Direct
self-service mutation of legally relevant profile fields should remain narrow and auditable.
