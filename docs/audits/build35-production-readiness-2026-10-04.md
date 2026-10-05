# Build 35 production readiness — 2026-10-04

## Verdict

Database preparation is complete for the merged Build 35 scope. Full application testing is **not yet certified**: Edge Function promotion, RevenueCat configuration, and a correctly flagged mobile artifact remain required. No staging changes, paid provider requests, store configuration changes, secret creation, or EAS builds were performed in this readiness pass.

Production: KScan App Production, `wyyuqfdxucjksghsmhry`, us-east-2, ACTIVE_HEALTHY, PostgreSQL 17.6.1.104. Source reviewed: integration/build35-v1-convergence @ 8595317b. Production deployment authority remains rebuild/backend-authority-v2; this repair branch must be merged there before deployment. PRs #499, #455, and #457 were not merged and their unmerged offer-code functionality was not deployed.

## Production migrations actually applied

The initial production ledger had 143 entries, last 20261001204903 (canonical Closet owned-look support). It now has 147. The three merged migrations were applied in dependency order followed by one corrective migration:

| Version | Migration | Result |
| --- | --- | --- |
| 20261002010000 | kplus_paid_lifetime_entitlement_foundation | Applied |
| 20261003195716 | kplus_provider_pull_reconciliation | Applied |
| 20261004221500 | closet_purchase_import_origin | Applied |
| 20261004231628 | fix_kplus_reconciliation_uuid_selection | Applied and runtime-tested |

The management tool initially assigned execution timestamps; only those four new ledger identities were reconciled to their exact repository versions afterward. SQL was not replayed. Original Build 34 history, historical renumbering, and HOLD/EXCLUDE decisions were preserved. The checked-in ledger snapshot is evidence of this observation, not a replacement for deployment-time live ledger validation.

Before/after row counts and digests were unchanged: legacy entitlement rows 1, canonical grants 0, Closet items 5. No synthetic real user or paid entitlement was created.

## P0–P3 repair ledger

### B35-PROD-001 — P1 / DATA_INTEGRITY

LOCATION: supabase/migrations/20261003195716_kplus_provider_pull_reconciliation.sql, subscription and lifetime reconciliation function candidate-selection queries.

ROOT_CAUSE: both functions aggregate UUID grant IDs with `min(uuid)`, which does not exist on this production PostgreSQL instance. The SQL can be installed successfully but fails when reconciliation reaches that statement.

IMPACT: paid subscription/lifetime reconciliation cannot reliably commit canonical K+ transitions.

REPAIR: forward corrective migration replaces only the two candidate selectors with deterministic `(array_agg(g.id order by g.id))[1]`; function contracts, locking and privileges remain unchanged.

FILES_CHANGED: supabase/migrations/20261004231628_fix_kplus_reconciliation_uuid_selection.sql; supabase/tests/build35_reconciliation_uuid_readiness_test.sql; __tests__/build35ProductionReadiness.test.js.

TEST_EVIDENCE: rollback-only production SQL smoke passed both function calls through candidate selection using unknown synthetic actors and returned unknown_user without granting access. Original min(uuid) negative control raised undefined_function. Static regression requires two corrected functions and no defective selector. Nonempty candidate ownership/race coverage remains in the existing reconciliation suites; the production smoke deliberately does not seed paid grants.

STATUS: FIXED (source and production database).

### B35-PROD-002 — P1 / BACKEND_WIRING

LOCATION: production Edge Functions, canonical backend authority source and function manifest.

ROOT_CAUSE: merged Build 35 runtime changes had not been promoted into the canonical backend deployment tree or production bundles. New kplus-revenuecat-webhook, kplus-revenuecat-pull-reconcile, and purchase-import-extract endpoints return 404. Existing VTO, K+ activation and Elise functions retain older implementations.

IMPACT: applying schema alone cannot enable paid lifecycle/receipt flows or newer backend behavior.

REPAIR: selectively port merged integration runtime and shared dependencies into the canonical backend descendant; register three functions (28 governed total), add already-applied canonical Closet migration source, preserve canonical scan-identify unchanged. Include privacy export/deletion resource dependencies so provider-control data is not omitted.

FILES_CHANGED: supabase/functions/_shared/**; supabase/functions/{kplus-activate,kplus-reconcile-revenuecat,kplus-revenuecat-webhook,kplus-revenuecat-pull-reconcile,purchase-import-extract,vto-generate,stylechat-generate,style-outfit-generate}/**; supabase/config.toml; scripts/edge-function-manifest-lib.js; config/{backend-authority,edge-function-manifest}.json; five Build 35 migration files including existing Closet support; readiness tests and evidence.

TEST_EVIDENCE: 689 Deno tests passed across RevenueCat, K+, VTO, Elise, outfit generation and receipt extraction. Function parity passes for 28 functions. Production ledger comparison has zero unexplained local/remote drift and selects no migration for replay; undeclared-row negative control still fails closed. Scanner bundle SHA-256 remains a033bc303f9ac7edb607793eda2eec617d0691c8cc0009cc3e4941d13b541cdb.

STATUS: SOURCE_REPAIR_COMPLETE_EXTERNAL_ACTION_REQUIRED. Merge this backend promotion PR into rebuild/backend-authority-v2, then use the required-reviewer production-controlled-deploy workflow. Do not substitute an unmerged branch or bypass the gate. Existing functions require exact live-bundle rollback capture before replacement.

Release-validation dependency: the canonical backend branch also lacked the already-merged #498 dependency reachability repair. Its exact gate, approved evidence manifest and regression tests were ported from the merged integration source (scripts/check-dependency-reachability.js, config/dependency-reachability-exceptions.json, __tests__/dependencyReachabilityGate.test.js). All 22 tests pass; a fresh npm audit-backed gate passes with 28 narrowly classified high findings, zero critical and no unapproved high findings. No new exception or package upgrade was invented.

### B35-PROD-003 — P1 / CONFIGURATION

LOCATION: production function secrets; services/kplus/revenueCatConfig.ts; RevenueCat provider/store configuration.

ROOT_CAUSE: production lacks KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION, KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION, REVENUECAT_RECONCILE_SECRET_API_KEY, and KPLUS_REVENUECAT_RECONCILE_ENVIRONMENT. EAS profile files do not declare public platform SDK keys; remote EAS values were not established in this audit.

IMPACT: paid purchase/restore lifecycle testing cannot be certified even after functions deploy.

REPAIR: existing handlers fail closed with bounded configuration errors; approved product classification and appropriate scoped provider credentials must be supplied by the owner. Existing REVENUECAT_SECRET_API_KEY is not silently reused as the read-only reconciliation credential.

TEST_EVIDENCE: missing-configuration and malformed-policy rejection covered by RevenueCat tests. Secret inventory inspected by names/digests only; secret values not disclosed.

STATUS: SOURCE_REPAIR_COMPLETE_EXTERNAL_ACTION_REQUIRED. Configure approved production RevenueCat webhook authorization, product mapping, read-only reconciliation credential and environment; verify Android/iOS public SDK keys in the actual build environment and provider dashboard webhook routing. Receipt extraction additionally requires deliberate PURCHASE_IMPORT_EXTRACT_ENABLED enablement (currently absent/off).

Totals for this readiness pass: P0_FOUND=0/P0_FIXED=0; P1_FOUND=3/P1_FIXED=1; P2_FOUND=0/P2_FIXED=0; P3_FOUND=0/P3_FIXED=0; UNRESOLVED_P0_P3=2 (external release/configuration actions). These are not counts for the earlier whole VTO audit.

## P4–P10 defect ledger

### B35-PROD-004 — P4 / CONFIGURATION

LOCATION: Supabase production Auth password settings.

DESCRIPTION/EVIDENCE: security advisor reports leaked-password protection disabled; this predates the migrations. No new ERROR-level security advisory was introduced. The new provider-control/product-cache tables deliberately have RLS and no client grants; policy-free server-only tables are not a reason to grant client access.

IMPACT: compromised passwords are not rejected by that optional control.

SUGGESTED_FIX: owner evaluates enabling leaked-password protection in production Auth after confirming plan eligibility and UX handling. See [Supabase password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

SUGGESTED_TEST: known leaked-password rejection in a controlled test account plus normal login regression.

DEPENDENCIES: production Auth setting approval and plan availability. FUTURE_LANE: Auth hardening. STATUS: DOCUMENTED_NOT_REPAIRED.

### B35-PROD-005 — P4 / UX

LOCATION: services/kplus/kplusActivationCatalog.ts, KPLUS_CAPABILITY_SERVER_ENABLEMENT.

DESCRIPTION/EVIDENCE: Concierge/Packing advertisement remains unconfirmed using a September 24 snapshot. Production flags are now enabled, but no authenticated member end-to-end generation was performed, so the catalog's required runtime proof is still absent.

IMPACT: under-advertises capabilities; it does not grant unauthorized access.

SUGGESTED_FIX: after governed runtime promotion and a K+ member flow proves both features, update dated enablement evidence and advertising-truth tests. Do not claim confirmation from secret presence alone.

SUGGESTED_TEST: canonical K+ member Concierge/Packing success; unavailable/nonmember cases still fail closed.

DEPENDENCIES: deployment and approved member test. FUTURE_LANE: Build 35 device certification. STATUS: DOCUMENTED_NOT_REPAIRED.

### B35-PROD-006 — P8 / TEST_COVERAGE

LOCATION: __tests__/staging/productionFunctionBundleRollback.test.js and productionWorkflowCaptureIsolation.test.js.

DESCRIPTION/EVIDENCE: comment assertions assumed LF; the pipeline fixture launched Windows WSL Bash rather than Git Bash and used an invalid native-path ESM import; pipeline startup ordering also made its race reproduction nondeterministic.

IMPACT: release regression validation fails on this Windows workspace without a backend behavior regression.

SUGGESTED_FIX / REPAIR: tolerate CRLF, use file URLs and the Git-matched shell, assert successful process execution, deterministically observe tee's capture creation before testing the real clean-tree gate, and use bounded temporary-fixture cleanup retries.

SUGGESTED_TEST / RESULT: actual inside/outside pipeline negative control and rollback checks; 157 production-governance/migration/readiness tests now PASS.

DEPENDENCIES: native Git/Node. FUTURE_LANE: release test portability. STATUS: FIXED_BY_VALIDATION_EXCEPTION. Required because this defect prevented regression validation of B35-PROD-002; no production guards were weakened.

P4_FOUND=2; P5_FOUND=0; P6_FOUND=0; P7_FOUND=0; P8_FOUND=1; P9_FOUND=0; P10_FOUND=0; P4_P10_REPAIRED_BY_EXCEPTION=1; P4_P10_DOCUMENTED_ONLY=2.

## Verification and limits

- Production rollback-only reconciliation SQL smoke: PASS.
- RLS and privilege queries: new server-only tables deny anon/authenticated SELECT; reconciliation writers deny client EXECUTE; canonical reader allows authenticated, not anon; lifetime/purchase-import constraints present; no unsafe min(uuid) selector in corrected live functions.
- Production Auth settings endpoint: HTTP 200, email/Google/Apple enabled. No credentials-based login or OAuth device flow was performed.
- Existing VTO/Elise/scan reject unauthenticated calls with 401. New endpoints currently 404, pending deployment.
- 689 backend Deno tests: PASS.
- 67 merged migration/provider/receipt Node checks: PASS.
- 52 canonical mobile/lifecycle Node checks: PASS; 27 disposable-database tests SKIPPED, not certified.
- New readiness regression: 2 PASS, including undeclared-ledger drift negative control.
- Production governance/migration/readiness regression fence: 157 PASS after fixing the Windows test harness; internal Build 35 APK profile check: 1 PASS.
- Dependency reachability regression: 22 PASS; fresh audit-backed reachability gate: PASS.
- TestSprite CLI/auth available. The only listed project is the staging Build 29 backend suite; it is not evidence for these undeployed production bundles. Build 35 runtime TestSprite validation remains unverified-because-undeployed. Do not run the staging suite and label it production certification.

## Remaining testing handoff

1. Merge reviewed backend promotion and deploy exact functions through the production environment reviewer gate, preserving JWT settings. Deploy new RevenueCat/receipt endpoints plus changed kplus-activate, kplus-reconcile-revenuecat, vto-generate, stylechat-generate, style-outfit-generate, process-account-deletions and privacy-data-export as their actual dependency bundles require. Do not deploy all functions blindly or replace the scanner.
2. Supply approved RevenueCat/receipt configuration. Keep paid/receipt features fail closed until configured.
3. Produce a Build 35 test artifact from the intended current source. production-certification includes the K+ feature flags missing from a plain production/locally bundled artifact; local bundling must explicitly inherit those settings. The installed older debug artifact is not a new Build 35 certification build. The new build35-testing profile prepares an internal Android APK with those inherited flags, but creates no EAS build.
4. Manually verify production login, account switch/canonical K+, purchase/restore, free-core isolation, member VTO consent/quotas, Concierge/Packing, receipt review and deletion/export. Paid provider calls and store changes require the separate permissions retained in the audit instructions.
