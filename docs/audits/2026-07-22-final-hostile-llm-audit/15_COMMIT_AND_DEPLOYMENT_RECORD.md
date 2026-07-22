# Commit and deployment record

## Application repository

| Purpose | Commit / merge | Pushed | Deployment effect |
| --- | --- | --- | --- |
| Render tombstone source | `260219c…` / `d1bb36ec…` (PR 21) | Yes | Public route observed 410; exact Render deployment ID unknown |
| Legacy surface tombstones | `2009dce…` | Yes | Canonical source repair |
| Scanner/TextScan reconciliation | `50a3038…` | Yes | Later deployed as Scanner v131 line |
| Elise quota/refund authority | `54991fd…` | Yes | Later deployed as StyleChat v72 line |
| Dormant outfit routing | `0394c96…` | Yes | Source only; not deployed |
| PR 22 integration | `300ea878…` | Yes | Canonical migration baseline |
| Quota ambiguity fixes | `8f249a2…`, `dea1326…` / `c8dc27a…` (PR 23) | Yes | Forward migrations applied |
| Safe telemetry | `72a6fab…` | Yes | Scanner v131, StyleChat v72 |
| Telemetry privilege hardening | `721e76c…` / `301afa1…` (PR 24) | Yes | Migration applied |
| Enable gallery preparation | `fe14d94…` / `2257c85…` (PR 25) | Yes | Mobile source; local QA APK only |
| Allow metadata-sanitized analysis | `ea01c71…` / `ffd25753…` (PR 26) | Yes | Mobile source; local QA APK only |
| Meta demo safe default | `489bde…` / `32a63a…` | Yes | Vercel `dpl_5Y7H5…` |

Temporary fault-injection commits `ce66998…` and `1dfba03…` were used only on an isolated branch and were never merged. The temporary secret was removed.

## Supabase deployments

| Function | Final version | JWT | Source commit | Smoke |
| --- | ---: | --- | --- | --- |
| `scan-identify` | 131 | true | telemetry/function tree at `72a6fab…` | Scanner and TextScan authenticated PASS |
| `stylechat-generate` | 72 | true | telemetry/function tree at `72a6fab…` | Elise authenticated PASS |

## Database migrations applied

- `20260722004639_stylechat_request_quota_events`
- `20260722022830_lock_down_stylechat_quota_refunds`
- `20260722024920_fix_stylechat_quota_rpc_ambiguity`
- `20260722030304_create_llm_routing_events`
- `20260722031812_limit_llm_routing_event_privileges`

All database changes were committed and pushed before application. Already-applied migrations were not edited.

## Mobile restriction

No Play Store, App Store, TestFlight, AAB, IPA, or production release-version operation occurred. Only a local debug APK was installed on the QA emulator.
