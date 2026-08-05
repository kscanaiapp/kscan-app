# Auth configuration manifest — K Scan AI Staging rebuild

Redacted. No key material, no user data, no production Auth users copied. No
production Auth setting was changed.

## What could be read, and how

Captured from the public GoTrue settings endpoint on both projects:

    GET https://<ref>.supabase.co/auth/v1/settings   (apikey header)

This endpoint is unauthenticated-readable and exposes provider and confirmation
posture only.

| Setting | Production | Staging | Parity |
|---|---|---|---|
| `external.email` | true | true | match |
| `external.google` | true | true | match |
| `external.apple` | true | true | match |
| `external.anonymous_users` | **true** | **false** | **GAP** |
| `external.phone` | false | false | match |
| all other providers | false | false | match |
| `disable_signup` | false | false | match |
| `mailer_autoconfirm` (email confirmation OFF) | true | true | match |
| `phone_autoconfirm` | false | false | match |
| `saml_enabled` | false | false | match |
| `passkeys_enabled` | false | false | match |

### The one detected gap

Production has **anonymous sign-ins enabled**; staging does not. This is
load-bearing: `scan-identify` is deployed with `verify_jwt = false` specifically
to support an anonymous, fingerprint-rate-limited scan path. With anonymous
sign-ins off, staging cannot reproduce that path.

**Action required (owner, dashboard):** enable Anonymous Sign-Ins on
`yzqjvdfgefveprobvvyw`. Not applied here — see below.

## What could NOT be read

The following are not exposed by the public settings endpoint, and there is no
read path available from this environment:

- password policy (minimum length, character classes, HIBP checks)
- JWT expiry
- refresh-token rotation and reuse interval
- rate limits (email, SMS, token refresh, sign-in, anonymous)
- CAPTCHA provider and enforcement
- site URL
- redirect URL allow-list
- mobile deep-link scheme registration
- email-template bodies for signup / restoration

Reasons, stated rather than guessed:

1. The Supabase MCP server exposes **no** Auth-configuration tool, read or write.
2. The Supabase CLI has `supabase config push` but **no** corresponding pull —
   `supabase config --help` lists `push` as the only subcommand. There is no way
   to read remote Auth config through it.
3. Reading the Management API `/v1/projects/{ref}/config/auth` needs the CLI's
   stored access token; retrieving it from the Windows credential store was
   blocked in this environment.

**These settings are therefore recorded as unresolved and were not guessed.**
Auth parity is **PENDING**, not passed.

## Tooling is now in place — one command closes the gap

`scripts/staging-v2/auth-config.mjs` talks to the Management API directly
(`GET`/`PATCH /v1/projects/{ref}/config/auth`) and patches **only** the keys named
on the command line, leaving every other setting untouched. It is guarded:
production is rejected for `--apply` and permitted read-only for `--capture`.

It needs one thing this environment cannot supply — a Supabase personal access
token. The CLI keeps its own token in the Windows credential store, which is not
readable from here (the read was blocked). Create one at
<https://supabase.com/dashboard/account/tokens>, then:

```bash
export SUPABASE_ACCESS_TOKEN=...        # for this command only; never committed

# record the current staging config as committed, redacted evidence
node scripts/staging-v2/auth-config.mjs --capture --project-ref yzqjvdfgefveprobvvyw

# record production's for comparison (read-only; the guard permits this)
node scripts/staging-v2/auth-config.mjs --capture --project-ref wyyuqfdxucjksghsmhry

# close the known gap
node scripts/staging-v2/auth-config.mjs --apply --project-ref yzqjvdfgefveprobvvyw \
  --set external_anonymous_users_enabled=true
```

`--capture` writes redacted JSON to `docs/staging-rebuild/evidence/`, so the two
projects can be diffed key by key and the remaining unresolved settings above can
be filled in from real data rather than guessed. Toggling Anonymous Sign-Ins in
the staging dashboard achieves the same single change if that is easier.

## Why `supabase config push` was not used

It would have worked mechanically — it targets the linked project, and the link
is verified against the guarded target. It was not used because it pushes the
*whole* local `[auth]` block, and this repository's `supabase/config.toml`
`[auth]` block exists only to make the local Docker shadow stack start. Its
`site_url` is `http://127.0.0.1:3000`. Pushing it would have overwritten
staging's real site URL and redirect allow-list with local-development values —
and since those values cannot be read back first, the damage would not have been
detectable, let alone reversible. Applying an unreadable setting blind is exactly
what "do not guess" rules out.

## Staging-native cryptographic configuration

Staging keeps its own project-generated JWT secret, anon/publishable keys and
service-role key. No production credential was copied. Verified: the staging
anon key's `ref` claim decodes to `yzqjvdfgefveprobvvyw`.

## Verdict

    Manifest created:              Yes
    Production settings captured:  Partial — provider/confirmation posture only
    Staging settings applied:      None (no readable target state to match)
    Pending settings:              anonymous sign-ins (known gap, action stated);
                                   password policy, JWT expiry, refresh rotation,
                                   rate limits, CAPTCHA, site URL, redirect URLs,
                                   deep-link schemes, email templates (unreadable)
    Parity verdict:                PENDING — must be resolved before the emulator funnel
