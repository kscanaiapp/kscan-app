# Build 35 K+ offer-code redemption

This lane adds a server-authoritative redemption path. It does not deploy the
migration or Edge Function, create an offer, mint a code, or configure a secret.

## Runtime contract

- The mobile app sends only `{ "code": "..." }` to `kplus-offer-redeem` with
  the current authenticated bearer token. Actor identifiers in the body are
  rejected.
- The Edge Function verifies the user, canonicalizes the code with NFKC + trim
  + uppercase, and computes HMAC-SHA-256. Only the digest reaches Postgres.
- `redeem_kplus_offer_code(uuid, text)` is service-role only. It atomically
  enforces activation windows, audience rules, per-code/global/per-actor caps,
  replay behavior, and actor rate limits.
- A K+ offer calls the existing `grant_kplus_complimentary` authority with
  source `complimentary_code`. The client refreshes the canonical K+ snapshot
  after success; it never grants membership locally.
- Store-native offer metadata is typed and validated, but redemption returns
  `UNAVAILABLE` until a separately reviewed Apple/Google/RevenueCat launch path
  exists. No billing or provider verification is bypassed.

## Secret contract

`KPLUS_OFFER_CODE_HMAC_SECRET_B64` must be a base64-encoded random secret of at
least 32 bytes. Configure independent values in each target environment through
the normal Supabase secret-management process. Never put the value in Git,
application environment files, issue/PR text, shell history, logs, or test
fixtures. A missing, malformed, or short secret fails closed as `UNAVAILABLE`.

Rotating this secret invalidates every digest provisioned with the old key.
Rotation therefore requires an explicit code re-provisioning plan; do not rotate
it as an ordinary redeploy step.

## Provisioning contract

Offer setup is an operator action after the migration is reviewed and applied:

1. Insert one typed row in `kplus_offer_definitions`, initially inactive.
2. Generate high-entropy customer codes outside the database.
3. Canonicalize each code exactly as the Edge Function does and compute its
   HMAC-SHA-256 with the target environment's secret.
4. Insert only the lowercase 64-character digest into `kplus_offer_codes`.
5. Review limits, audience, dates, and action metadata before activating the
   offer. Preserve the raw codes only in the approved delivery system.

Do not pass raw codes through SQL consoles, migrations, database seed files, or
ordinary application logs. Neither authority table has a raw-code column.

## Privacy and deletion

Successful redemptions and attempts store the Auth actor UUID, bounded outcomes,
and keyed digests. Actor rows cascade on Auth deletion and are registered in the
account-deletion inventory. Offer definitions and code digests are operational
campaign records, not actor-owned data.

## Release gates

- Apply `20261004184118_kplus_offer_code_redemption_authority.sql` only through
  the repository's governed migration process.
- Configure the secret before deploying `kplus-offer-redeem`.
- Exercise invalid, expired, inactive, ineligible, already-used, concurrent,
  rate-limited, and successful cases in staging with disposable actors/codes.
- Confirm that success appears only after the canonical K+ reader refreshes.
- A store-native offer must remain inactive until its provider launch path has
  its own implementation and review.
