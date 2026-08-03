# Staging synthetic authentication

Status: live. `Synthetic auth tests` authenticates at runtime via Supabase Auth's password grant instead of reading pre-issued, long-lived JWTs out of GitHub secrets. This documents the account provisioning, the required secrets, and how to rotate them.

## Why runtime authentication instead of stored JWTs

The prior design stored `STAGING_SYNTHETIC_USER_JWT` / `_SUSPENDED_JWT` / `_DELETION_PENDING_JWT` as GitHub secrets — long-lived tokens that don't expire on a useful cadence and, once leaked, remain valid until manually revoked. The current design stores only **email + password** for three persistent synthetic accounts plus the staging publishable key; the workflow signs each account in fresh at the start of every run and the resulting access token lives in process memory for the duration of that one script invocation only.

## Required secrets

All of the following are GitHub repository (or `staging` environment) secrets, consumed only by the `Synthetic auth tests` job in `.github/workflows/security-staging-gate.yml`:

| Secret | Purpose |
|---|---|
| `SUPABASE_STAGING_PUBLISHABLE_KEY` | The staging project's publishable API key (`sb_publishable_...`) — the same class of key K Scan's own mobile app uses; not the service role key, never grants elevated access on its own. |
| `STAGING_SYNTHETIC_ACTIVE_EMAIL` / `STAGING_SYNTHETIC_ACTIVE_PASSWORD` | Login for the persistent `active`-state synthetic account. |
| `STAGING_SYNTHETIC_PENDING_EMAIL` / `STAGING_SYNTHETIC_PENDING_PASSWORD` | Login for the persistent `pending_deletion`-state synthetic account. |
| `STAGING_SYNTHETIC_LOCKED_EMAIL` / `STAGING_SYNTHETIC_LOCKED_PASSWORD` | Login for the persistent `locked`-state synthetic account. |

`security/scripts/synthetic-auth.js`'s `findMissingEnvVars()` checks for all of these before any network call and fails the job with the exact list of missing names — never a generic "auth failed" that could be confused with a real security regression.

## What the workflow never does

- **Never creates or deletes a synthetic Auth user during a CI run.** The three accounts are provisioned once (see below) and are expected to already exist every time this job runs.
- **Never stores a valid user JWT as a secret.** Only email/password credentials and the publishable key are stored; every access token is obtained fresh and only ever exists in the script process's memory.
- **Never writes a token to stdout, a file, an artifact, or a step summary.** `synthetic-report.json` (the uploaded artifact) contains only booleans, HTTP status codes, and non-sensitive error strings.
- **Never modifies `waitlist_signups`, `privacy_settings`, `deletion_requests`, `website_sale_share_opt_out_requests`, `privacy_export_requests`, or `privacy_correction_requests`.** The synthetic accounts and their `style_chat_sessions`/quota rows are entirely separate from those tables.

## Token masking

Immediately after `signInSyntheticUser()` returns a token, the calling script prints `::add-mask::<token>` **to stderr** (`security/scripts/synthetic-auth.js`'s `maskLine()`, called via `console.error` in `synthetic-staging-tests.js`) before doing anything else with it. GitHub Actions scans a step's full log output for this workflow command and redacts that exact value from every subsequent log line for the rest of the job. Stderr specifically (not stdout) so the mask command never lands inside `synthetic-report.json`, which is produced by piping the script's stdout through `tee`.

## Synthetic account provisioning (one-time, out of band — not part of any CI run)

The three accounts currently live on `yzqjvdfgefveprobvvyw` (K Scan AI Staging):

| Email | `profiles.account_status` | Has a persistent `style_chat_sessions` row? |
|---|---|---|
| `synthetic-active@kscan-test.invalid` | `active` | Yes (`a1b2c3d4-5555-4000-8000-000000000001`) — so the "active-user request succeeds" test gets a genuine 200, not just a lenient non-error status. |
| `synthetic-pending@kscan-test.invalid` | `pending_deletion` | No — the account-state check rejects the request before a session is ever needed. |
| `synthetic-locked@kscan-test.invalid` | `locked` | No — same reason. |

Provisioning steps (repeat only if an account needs to be recreated, e.g. after rotation):

1. Sign up via the public signup endpoint using the **publishable key only** — this never requires the service role key:
   ```bash
   curl -X POST "https://yzqjvdfgefveprobvvyw.supabase.co/auth/v1/signup" \
     -H "apikey: <publishable key>" -H "Content-Type: application/json" \
     -d '{"email":"synthetic-<role>@kscan-test.invalid","password":"<new password>"}'
   ```
   Staging has `mailer_autoconfirm: true`, so the account is usable immediately with no email confirmation step.
2. Set `account_status` for the `pending`/`locked` roles (the `active` role keeps the default `active` value the signup trigger assigns):
   ```sql
   update public.profiles set account_status = 'pending_deletion' where id = '<pending account's auth.users id>';
   update public.profiles set account_status = 'locked' where id = '<locked account's auth.users id>';
   ```
3. For the `active` role only, ensure its `style_chat_sessions` row exists (skip for `pending`/`locked`):
   ```sql
   insert into public.style_chat_sessions (id, user_id, title)
   values ('a1b2c3d4-5555-4000-8000-000000000001', '<active account's auth.users id>', 'ci-synthetic-active-session')
   on conflict (id) do nothing;
   ```
4. Update the corresponding GitHub secrets with the email/password used.

## Rotation procedure

To rotate a synthetic account's password (recommended periodically, and immediately if a password is ever suspected exposed):

1. Update the password via the Supabase Auth Admin API or dashboard (requires service-role/dashboard access — not something this repo's CI does).
2. Update the matching `STAGING_SYNTHETIC_{ROLE}_PASSWORD` GitHub secret to the new value.
3. No code or workflow change is needed — the next run signs in with whatever credential is currently in the secret.

To rotate the publishable key itself, update `SUPABASE_STAGING_PUBLISHABLE_KEY` to the new value from the Supabase dashboard; publishable keys can be rotated independently of the service role key and do not require touching the synthetic accounts at all.

To decommission a synthetic account entirely (e.g. replacing it with a fresh one), delete the `auth.users` row for it (cascades to `profiles` and any `style_chat_sessions`) and provision a replacement per the steps above — this is a manual, out-of-band action, never something a CI run does.
