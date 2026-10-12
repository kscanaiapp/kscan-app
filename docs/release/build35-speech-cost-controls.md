# Build 35 Speech operational controls

Source implementation; no environment deployment or paid transaction is claimed.

## Authority and defaults

The Speech handler validates the bearer actor, rejects anonymous users, requires
an explicit active profile, verifies
owned session/message references or the existing cue allowlist, and obtains a
service-only database reservation before ElevenLabs dispatch. The reservation
rechecks active-account authority. Core Elise remains Free; this repair does not
introduce a new K+ paywall. Database errors, malformed
leases, missing credentials and missing configuration deny dispatch.

The additive migration creates `speech_provider_control`,
`speech_request_reservations` and `speech_daily_cost`. All have RLS enabled;
anonymous and authenticated clients have no table access or mutation RPC grants.
Only the protected server uses the reservation/finalization RPCs. Existing auth,
Storage policies, provider quota RPCs and entitlement grants are unchanged.

The governed cross-path privilege inventory records Speech's service-role and
RPC footprint explicitly. Its allowlist confines the credential to
`stylist-speech/index.ts`, where the privileged client calls only
`reserve_speech_request` and `finish_speech_request`. Content/account reads use
the authenticated actor client; Speech has no direct table-write, Auth-admin or
Storage authority. The inventory checks both the full deployed footprint and
the exact privileged RPC pair.

`enabled=false` and `daily_character_limit=0` are the migration defaults.
The owner’s zero-allocation restriction remains in force. Enabling the operational
control or assigning a nonzero character allocation requires a separately
authorized operational decision; applying this migration alone sends no paid call.
The release feature flag and operational allocation are distinct controls.

## Limits and failure handling

A transaction advisory lock serializes the fleet budget check and reservation.
The lock is released before the network provider request. Limits include one
active reservation per actor, at most 10 attempts per minute and 50 per UTC day,
up to 1,000 UTF-16 text units per request, and an operator-controlled UTC daily
character ceiling with a hard configuration maximum of 200,000. These maximums
are source bounds, not newly authorized live quotas.

Attempts count even when the provider response fails or reservation finalization
cannot be saved, because work may already be billed. A failed finalization leaves
the 45-second lease to expire; it does not retry a paid call. The daily budget is
an aggregate counter without actor or content data, so account deletion cannot
refund it. Personal reservation rows cascade on Auth deletion and are registered
in both deletion registries for residual verification. The ledger contains actor
IDs, reference-only SHA-256 digests, timing, bounded character counts and status;
it stores no conversation text, raw audio, tokens or provider credentials.

Operator shutdown sets `enabled=false`; new reservations then fail closed.
Already dispatched provider requests may finish. Written replies remain available.
Rollback should first disable the operational control; retain the additive tables
and captured evidence rather than destructively dropping customer records.

## Evidence and remaining verification

- 111 Speech Deno tests pass, including provider-free negative dispatch cases.
- Actual data-access adapter tests verify actor/server client boundaries and
  rejection of missing or invalid authority.
- `node scripts/speech/test-cost-controls.mjs` executes the actual migration in
  pinned PGlite 0.5.8, with external Auth/profile fixtures. It verifies
  role grants, RLS, constraints, account gates, fleet budget, failure accounting,
  and deletion without budget refund. CI runs this local SQL check without live
  credentials or paid providers.

This local fixture does not certify live multi-session concurrency, the entire
entitlement resolver, Staging migration replay or Production execution. Those
remain separate governed verification steps. No Production migration, operational
enablement, provider transaction or signed artifact occurred in this source pass.

The owner-approved consent implementation is documented in
`build35-speech-disclosure.md`. Physical-device playback and privacy behavior
remain post-build requirements.
