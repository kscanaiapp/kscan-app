# Build 35 Production security history reconciliation — 2026-10-13

The owner-approved `kplus-activate` deployment [run 38454471992](https://github.com/kscanaiapp/kscan-app/actions/runs/38454471992) stopped at its live remote preflight, before bundle capture or function replacement. The current backend authority at `bec1ed396e444e75b381835712f4b40990ae5c15` did not declare three legitimate October 12 Production-only security ledger rows. The gate correctly refused this unexplained drift; health, synthetic and rollback steps were skipped because deployment never ran.

This change records only those three verified rows in Production's existing `remoteOnly` section. `PRODUCTION_ONLY_HISTORICAL` means intended existing history, never executable migration permission. No SQL file is added, no ledger is rewritten, no migration is applied, and no gate or security grant is changed. Staging authority is untouched.

Read-only evidence from Production `wyyuqfdxucjksghsmhry`:

| Ledger version / name | Verified intended effect | SHA256 of recorded statements joined with LF |
| --- | --- | --- |
| 20261012203811 / build35_reaction_counts_share_token_functional_parity | `pg_get_functiondef` confirms anonymous counts require the exact active, unrevoked, unexpired room share token; owner/member access remains scoped; the unsafe `uuid[]` overload is absent. | 866c6c38e28f73dcbe1c5f16d8c48b5541748159aa3d827516218b9365f87c16 |
| 20261012203929 / build35_revoke_trigger_only_client_execute_grants | `has_function_privilege` reports anon=false, authenticated=false, service_role=true for `set_provider_request_limits_updated_at()`. | 5fd592b94ba71a3b181f4a9e729e53f216ca47b264208f544ea4115102d5574f |
| 20261012204354 / build35_contain_unauthorized_kplus_early_access_grants | `has_function_privilege` reports anon=false, authenticated=false, service_role=false for `grant_kplus_early_access(uuid)`. Paid canonical RevenueCat transitions remain separate. | a3e8c3e25ba4d73b21abb019f62546ddcc554084ca24fec0cf8f26dd880eb519 |

The ledger's recorded SQL was inspected directly, alongside live routine definition and privileges. Versions are environment-specific, not a reason to duplicate these migrations into Staging or replay Production history. The single approved-function deployment still requires a current governed tip, exact scoped preflight, protected Production review, complete private rollback capture and successful post-deploy health/negative-auth checks. This manifest repair grants no deployment approval.

Validation must compare the actual failing live report with the repaired authority, retain zero unexplained drift, and demonstrate that a fourth unknown remote row still fails. Existing migration selection/recovery tests must pass. After merge, redispatch the same `kplus-activate`-only scope against the new governed tip and review its new Production preflight before approval. Runtime capability certification remains separate and requires a normal Supabase Auth session belonging to a dedicated legitimately entitled Production actor; no service-role customer session or complimentary grant is permitted.

Local validation passed: 92 existing migration selection/recovery/bundle rollback tests, zero failures/skips. A fresh read-only 152-row Production ledger comparison returned zero unexplained local or remote drift, 31 unchanged known-pending records and zero selected migrations. A fourth unknown remote row was rejected. Naming each of these three already-applied historical versions selected zero SQL and failed the static migration execution precheck because no governed local migration exists. This is gate verification, not a Production deployment or runtime certificate.
