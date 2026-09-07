# RP-106 — VTO non-billable attempt release: production promotion record

**Status: preparation only. The production promotion has NOT been performed.**

| Field | Value |
|---|---|
| Repair | `RP-106` (hostile-audit finding `VTO-MIG-001`) |
| Source migration | `supabase/migrations/20260902150000_vto_non_billable_attempt_release.sql` |
| Object | `public.release_vto_generation(uuid, text, text)` |
| Staging | **APPLIED + CERTIFIED** (`yzqjvdfgefveprobvvyw`, K Scan AI Staging) |
| Production | **PENDING — FROZEN DURING APPLE REVIEW** (`wyyuqfdxucjksghsmhry`) |
| Production action required later | Apply the already-certified migration through normal migration governance |
| New mobile binary required for this migration | **NO** |

## Why this migration exists

`reserve_vto_generation` runs *before* the provider, which is what makes a
double tap collapse into one paid job. Every outcome after it settled through
`complete_vto_generation`, which never gives the attempt back — so a user's
daily VTO cap was charged for failures where K Scan provably never bought
anything: RapidAPI 401/403/429, upstream 5xx, and any failure before the
submit was sent. `release_vto_generation` hands back exactly one attempt in
those cases and nothing else; everything from a successful submit onwards
(poll timeout, generation_failed, invalid_output, moderation, vendor-rejected
input) stays counted, because the money is spent whether or not K Scan liked
the answer.

## Staging verification (2026-09-07)

Structural:

- `pg_proc` — `release_vto_generation(p_user_id uuid, p_idempotency_key text, p_provider text)` present, `SECURITY DEFINER`, owner `postgres`.
- `pg_get_functiondef` is **byte-identical** to the source migration body, including its inline comments.
- `obj_description` matches the source `comment on function` text verbatim.
- Execute grants: `postgres`, `service_role`. No `anon`, no `authenticated`, no `public` — matching the migration's `revoke all … from public, anon, authenticated`.
- `supabase_migrations.schema_migrations` carries version `20260902150000`, name `vto_non_billable_attempt_release`.
- Companion functions `reserve_vto_generation` and `complete_vto_generation` remain intact and unchanged.

Behavioural — zero-spend certification run `kscan-vto-rp106-cert-01`, driving
the **deployed** staging `vto-generate` with the shipping harness's controls
(`scripts/vto-e2e/lib/{provision,dryrun,cleanup,persistence}.mjs`):

| # | Control | Result |
|---|---|---|
| 1 | ACTIVE K+ reaches reservation (non-billable pre-submit failure) | PASS |
| 2 | Non-billable pre-submit failure → quota released exactly once | PASS (`rows=0`) |
| 3 | Second release → no second refund | PASS (returns `false`) |
| 4 | Retry after valid release → may reserve again | PASS (not `rate_limited`/`duplicate`) |
| 5 | Retry attempt also released cleanly | PASS (`rows=0`) |
| 6 | Foreign actor cannot release another actor's reservation | PASS (returns `false`) |
| 7 | Rightful actor release still succeeds afterwards | PASS (returns `true`) |
| 8 | NEVER_ENTITLED denied before provider work | PASS |
| 9 | NEVER_ENTITLED: no reservation row created | PASS |
| 10 | EXPIRED K+ denied before provider work | PASS |
| 11 | EXPIRED_KPLUS: no reservation row created | PASS |
| 12 | Rapid duplicate: one reservation authority, duplicate suppressed | PASS |
| 13 | Unsafe initial garment URL rejected before network access | PASS |

- Provider submits: **0**
- Paid requests: **0**
- Residual test state after cleanup: **0** (independently re-queried: 0 synthetic users, 0 synthetic entitlements, 0 `vto_generation_requests` rows)
- Persistence diff for the active actor: no auto Closet write, no auto Dressing Room write, no auto saved-scan write.

## Production promotion instructions (do not run during the freeze)

1. Confirm the Apple review freeze has lifted.
2. Promote through normal migration governance against `wyyuqfdxucjksghsmhry`, approving exactly this version:
   - `APPROVED_MIGRATION_VERSION=20260902150000`
3. Re-verify on production the same three structural facts certified on staging: function present, `pg_get_functiondef` matches source, execute grants are `service_role` only.
4. No client release is coupled to this. The mobile binary calls nothing new —
   `supabase/functions/vto-generate/vtoReservation.ts` already invokes
   `rpc('release_vto_generation', …)`, and until the function exists that call
   simply fails soft and the attempt stays counted, which is exactly today's
   production behaviour.

## Known state note

The migration was applied to staging **before** this repair pass began. The
authority manifest's `GENUINELY_UNAPPLIED` declaration for this version was
captured on 2026-09-03 and had gone stale by 2026-09-07; it is corrected in
`config/migration-authority-manifest.json`. That declaration is descriptive
only — no gate consumes `genuinelyUnapplied` for a blocking decision (the
preflight's `validateReconciliation` reads `reconciled`) — so the staleness
misreported state without ever gating on it.
