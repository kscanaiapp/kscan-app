# Build 35 Speech Production migration plan

Owner authorization: continuation directive dated 2026-10-12. Protected human Production approval remains mandatory.

## Exact scope

- Project: `wyyuqfdxucjksghsmhry`.
- Version: `20261011222213`.
- File: `supabase/migrations/20261011222213_build35_speech_operational_cost_controls.sql`.
- Mode: migration-only (`function_name=none`); no Scanner replacement.
- Objects: three additive tables (`speech_provider_control`, `speech_request_reservations`, `speech_daily_cost`), two reservation indexes, service-only `reserve_speech_request(uuid,text,integer)` and `finish_speech_request(uuid,uuid,boolean)` RPCs.
- Data impact: insert one operational singleton; no customer backfill, no existing-row updates, no destructive SQL or consent reset.
- Defaults: provider disabled, daily character allocation zero. Applying SQL sends no provider request and does not authorize paid activation.
- Compatibility: additive schema; existing clients and quota/entitlement RPCs unchanged. Core Elise stays Free under existing benefit contract; authenticated active-account and owned-reference authorization applies to Speech.

## Verified prerequisites and Staging

Staging and Production both carry the five October prerequisite migrations as of the 2026-10-12 read-only ledger inspection. Staging migration-only run [38257025966](https://github.com/kscanaiapp/kscan-app/actions/runs/38257025966) succeeded from integration `32b9c427352bd83980ad55a50e0d630d6c0796ba`.

Live Staging inspection confirms the exact migration ledger identity, three RLS tables, no anon/authenticated table access or RPC execution, service-role execution, postgres function ownership and empty search paths. Control disabled, budget zero, personal reservation count zero and actor-free cost count zero.

Disposable SQL checks: 21/21 actual migration checks. Speech Deno: 111/111, provider mocked. Deletion registry parity: 16/16. Migration-only/reconciliation/recovery governance: 92 checks, the one stale staging-declaration assertion corrected by recording the now-applied Staging migration; affected reconciliation rerun 50/50. Independent promotion review found no actionable defect.

## Approval and verification

Promote reviewed source into `rebuild/backend-authority-v2` only after required CI. Dispatch `production-controlled-deploy.yml` at the exact current authority SHA with `function_name=none`, `approved_migration_version=20261011222213`, `approve_migration=YES`, `allow_destructive_migration=NO`, and `confirm_production=DEPLOY TO PRODUCTION`.

Human reviewer approves the protected production environment after reading the plan. Workflow rechecks target, exact authority tip, live ledger, source hash, prerequisites and drift immediately before applying exactly one file. No blanket migration command is authorized.

After success, verify ledger, all columns/constraints/indexes, RLS, role privileges, function signatures/ownership/search path, disabled zero-budget denial and zero new usage records. Promote `stylist-speech` separately from migration execution after Staging function/source parity passes; retain JWT posture and private exact recovery. No paid calls or Production test actor creation.

## Operational rollback

Disable provider control first if necessary; retain the additive tables and personal records. Do not drop tables, reset counters or clear consent to manufacture a passing result. Function promotion uses captured exact prior bundle with governed automatic rollback.

Consent is enforced in the approved client before transmission and scoped to account/device/disclosure version. The server accepts only verified owned assistant-message references or allowlisted cues, never caller text. Physical playback/upgrade/push/purchase tests remain post-build; zero allocation stays in force until separately approved.
