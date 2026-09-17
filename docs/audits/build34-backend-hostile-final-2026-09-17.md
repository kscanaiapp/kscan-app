# Build 34 backend hostile audit — final staging certification record

Campaign date: 2026-09-17  
Environment: staging only (`yzqjvdfgefveprobvvyw`, `us-west-1`)  
Final audit branch: `codex/build34-backend-hostile-audit-20260917`  
Final audit SHA: `2314d29bb868f643fde2db52bf939643c7ee4eea`

## Executive result

```text
EXECUTIVE_STATUS=BUILD34_BACKEND_PRE_MIGRATION_NOT_CERTIFIED
READY_FOR_PRODUCTION_MIGRATION=NO
FULL_BACKEND_SURFACE_EXHAUSTED=NO
AUDIT_INTRODUCED_DEFECTS=0
```

The campaign repaired and staging-verified the two P1 defects and both proven
backend P2 defects, reconciled the active watchlist source drift, and deployed
the safe orphan-media reconciler. Certification is intentionally withheld:
the reconciler has no staging secret or scheduler/invoker, two active privacy
function bundles could not be read back through the Management API, four
ungoverned wearable functions remain outside this authority, and the shared
public-room client still omits the backend's required reaction share token.

```text
PR431_DISPOSITION=open-draft-unmerged; evidence re-proven, not merged
P0_P3_REPAIRS=scan-identify auth boundary; deletion-worker fail-closed mode;
  Vinted account-state spend gate; watchlist authority reconciliation;
  orphan-media reconciler deployment
STAGING_DEPLOYMENTS=scan-identify v73; process-account-deletions v68;
  search-vinted-secondhand v58; reconcile-orphan-media v1
STAGING_RUNTIME_PROOFS=401 auth boundaries; 503 orphan secret gate;
  exact source readbacks; 22 migration gates; 60 orphan/deletion tests
P4_P10_DEBT_LEDGER=advisor/performance debt and retired/ungoverned surfaces;
  no formal P4-P10 campaign severity opened
KNOWN_UNKNOWNS=privacy-controls/public-sale-share-opt-out source readback;
  four wearable functions and their external authority; production state;
  production-scale p99/load behavior
BUILD34_BACKEND_MIGRATION_BASELINE=source authority SHA 2314d29b plus
  staging ledger 171, migration authority 28, edge manifest PASS, and the
  explicit remote-only classification for 20260916234025
```

## Authority and freeze

```text
BASELINE_RELEASE_SHA=c6ee31adb0932d4d476cc218c1a7bff434b10bc8
BASELINE_BACKEND_SHA=d24d4afd214b55ae10f9f360d82b83e8c29be0b9
FINAL_RELEASE_SHA=c6ee31adb0932d4d476cc218c1a7bff434b10bc8
FINAL_BACKEND_SHA=2314d29bb868f643fde2db52bf939643c7ee4eea
RELEASE_AUTHORITY=origin/release/kscan-pre-freeze-v1
BACKEND_AUTHORITY=origin/rebuild/backend-authority-v2
STAGING_PROJECT=yzqjvdfgefveprobvvyw
```

Production was never selected as a target, queried, or mutated. Repository
configuration containing a production ref was treated as static source text
only.

```text
PRODUCTION_ACCESSED=NO
PRODUCTION_QUERIED=NO
PRODUCTION_CHANGED=NO
```

PR #431 remains open, draft, unmerged, base `release/kscan-pre-freeze-v1`,
head `claude/relaxed-noether-zqp4rl` @ `ccb1dd0f2d4b1e26f04285a12243abc7dc591a19`.
Its reaction/JWT work was re-proven against staging; it was not merged or used
as an authority input. PRs #434, #435, and #436 remain separate test,
convergence, and deployment-path lanes.

## Surface inventory

```text
SHIPPING_EDGE_FUNCTIONS=25 governed; 34 active staging slugs total at baseline,
  including 10 ungoverned/retired surfaces and the newly deployed reconciler
SHIPPING_TABLES=83 public tables + 8 storage tables; RLS 91/91
SHIPPING_RPCS=130 public functions; 3 anon-executable, 50 authenticated-executable,
  106 service-role-executable (role sets overlap)
SECURITY_DEFINERS=116; all audited definitions pin search_path and none grants PUBLIC
STORAGE_BUCKETS=5; 30 style-library-images orphan-owner objects retained
WORKERS=process-account-deletions, commerce-watch-refresh, reconcile-orphan-media;
  cron jobs 0 and database webhook triggers 0
EXTERNAL_PROVIDERS=Apify/Vinted, AI Lab Tools, RapidAPI/Nike/KicksCrew,
  RevenueCat, Apple credential/revocation surfaces; wearable provider surface is
  active but outside this authority
```

## Severity ledger

```text
P0_TOTAL=0
P0_OPEN=0
P1_TOTAL=2
P1_OPEN=0
P2_TOTAL=3 (2 backend, 1 frontend blocker)
P2_OPEN=0 backend; 1 frontend blocker remains
P3_TOTAL=1
P3_OPEN=1 operationally (secret + scheduler/invoker not configured)
P4_TOTAL=0 formal campaign findings
P5_TOTAL=0
P6_TOTAL=0
P7_TOTAL=0
P8_TOTAL=0
P9_TOTAL=0
P10_TOTAL=0
```

## P0–P3 repairs and staging proofs

| Finding | Repair | Staging proof | Commit / version |
| --- | --- | --- | --- |
| B34-BE-SEC-001, P1 — MODE B paid-provider boundary | Enforced authenticated, non-anonymous custom bearer validation, durable quota, and canonical mode before parsing/provider work; added mutation negative control and corrected stale contract tests. | Missing and malformed JWT probes return HTTP 401; health remains HTTP 200; readback bundle matched all 42 manifest files. | `c83e7e05`; `scan-identify` v72 → v73, `ezbr_sha256=8cd1a91c1dbe8438353daf51bd4963c9e96dbfa3a7452f7690412bdc2cf6ea07` |
| B34-BE-LIFE-001, P1 — deletion worker fail-open flags | Fail-safe worker-mode parser, K+ resource registry, RevenueCat cleanup ordering/retry, and malformed/missing/read-error controls. | 92 lifecycle/deletion tests pass; no-secret probe returns HTTP 401; readback matched all 6 manifest files. | `ebf80464` / `c83e7e05`; `process-account-deletions` v67 → v68, `ezbr_sha256=06007e3e7fe76e4fa4d73fad53f13d6b5c251308246e10230af2a4ed64aaf14b` |
| B34-BE-COST-001, P2 — Vinted account-state spend gate | Account-state gate precedes the paid provider call; deactivated, pending, locked, and unreadable states make zero upstream calls. | 23 direct module/fetch-spy tests pass; missing/malformed JWT probes return HTTP 401; readback matched all 3 manifest files. | `9a95e6d0`; `search-vinted-secondhand` v57 → v58, `ezbr_sha256=0e70e57fa79e3d322b4fb08df6094c554a82717e2c49a6ce596c4a0fc246d63b` |
| B34-BE-GOV-001, P2 governance — watchlist live source ahead of authority | Reconciled four byte-identical release/live receipt-processing and observability files into backend authority; did not redeploy an older bundle. | Watchlist/notification suites: 98 + 89 pass; source parity and backend-authority gates pass; staging v12 was already the reconciled implementation. | `c8574398`; no staging mutation |
| B34-BE-STO-001, P3 — orphan media operations | Deployed canonical secret-gated, dry-run-default, fail-closed reconciler; no storage object was deleted. | `reconcile-orphan-media` absent → v1; exact source readback (`74b250df…b2f2d`); unauthenticated runtime returns HTTP 503 `Sweep secret not configured`. | deployed from `2314d29b`; bundle `fcdec6f0…103c1`, tree `9ca75698…a38f` |

No diagnostic, temporary, reduced, or mock handler replaced a shipping slug.

## Database and migration baseline

```text
APPLIED_STAGING_LEDGER_ROWS=171
SOURCE_MIGRATION_FILES=171
MIGRATION_AUTHORITY_ENTRIES=28
MIGRATION_AUTHORITY_GATE=PASS
MIGRATION_PROVENANCE_GATE=PASS
MIGRATION_VERSION_COLLISION_GUARD=PASS
```

Staging-only ledger reconciliation:

- `20260916233708_reaction_counts_bind_anonymous_share_token` is now an exact
  source migration with an MD5/length match to the read-only staging statement;
  it defines `get_item_reaction_counts(uuid[], text)` and binds anonymous reads
  to the exact live share token.
- `20260916235651_dressing_room_items_dedupe_key_idempotency` is now an exact
  source migration with an MD5/length match to staging; the partial dedupe-key
  index exists and is inert while the feature flag is off.
- `20260916234025_dressing_room_items_source_idempotency` is explicitly
  `OBSOLETE_REMOTE_ONLY`: its ledger row exists but its effective index is
  absent, and its “same product once per room” invariant is not the approved
  mutation-idempotency contract. It is not replayed or added to source.

Effective staging postcondition: `dressing_room_items_dedupe_key_key` exists,
`dressing_room_items_source_identity_key` is absent, the token-bound reaction
RPC exists, and the legacy one-argument RPC does not.

Function deployments do not alter the schema. The pre/post staging schema and
ledger signatures remained unchanged (171 rows); no production migration
manifest was executed or inferred.

## Runtime and validation

```text
LOCAL_BACKEND_AUTHORITY_TESTS=1,065/1,065 before repair lanes
MIGRATION_GOVERNANCE_TESTS=22/22
ORPHAN/DELETION LIFECYCLE TESTS=60/60
SCAN MODE-B + QUOTA TESTS=35 Deno + 70 Node
VINTED ACCOUNT-STATE TESTS=23/23
WATCHLIST/NOTIFICATION TESTS=98 + 89
EDGE_FUNCTION_MANIFEST=PASS
EDGE_FUNCTION_SOURCE_PARITY=PASS
BACKEND_AUTHORITY_VERIFY=PASS (25/25 governed/source; clean tree)
```

TestSprite preflight succeeded (`0.5.0`, authenticated, staging backend
project found), but the six-test batch could not run: the account had 0.2
credits and the run requires 0.2 credits. No TestSprite result is represented
as a pass.

Release `npm run test:all` remains non-green from the captured baseline (27
failures: established fixture/path failures plus PostHog fixture/loader
failures). No test was weakened to hide a backend defect. Staging data is too
small for a defensible production p99 claim; query and advisor debt remains
listed below.

## Contract status

```text
SOURCE_STAGING_PARITY=PASS for the 25 governed/source surfaces that were
  downloadable and read back; UNKNOWN for privacy-controls and
  public-sale-share-opt-out Management API bundles (HTTP 500); NOT CERTIFIED
  globally because active ungoverned wearable surfaces remain outside authority
SECURITY_STATUS=PASS for the audited staging catalog; 91/91 RLS-enabled, 116/116
  SECURITY DEFINER search_path controlled, no PUBLIC EXECUTE
DATABASE_INTEGRITY_STATUS=PASS; schema/ledger signatures unchanged by deployments
TRANSACTIONAL_INTEGRITY_STATUS=PASS for audited mutation paths
IDEMPOTENCY_STATUS=PASS for deletion/provider controls; dedupe primitive staged,
  source-identity proposal rejected
CONCURRENCY_STATUS=PARTIAL; hostile unit/concurrency controls pass, no load claim
STORAGE_STATUS=PARTIAL; safe reconciler deployed, 30 historical orphans retained,
  secret and scheduler/invoker still absent
EDGE_FUNCTION_STATUS=PASS for governed readback surfaces; global status partial
PROVIDER_STATUS=PASS for audited paid-provider gates; full wearable provider
  authority is unknown
AI_STATUS=PARTIAL; governed source contracts audited, no paid live provider calls
KPLUS_ENTITLEMENT_STATUS=PASS for worker/resource/revenue recognition controls
WORKER_STATUS=PARTIAL; deletion/watch refresh verified, orphan sweep not operational
WEBHOOK_STATUS=PARTIAL; no DB webhook triggers and vendor webhook runtime not load-tested
OBSERVABILITY_STATUS=PASS for sanitized worker logs and non-destructive probing
TIMEOUT_STATUS=PARTIAL; bounded retries/contracts proven, no production-scale load
PERFORMANCE_STATUS=NOT_COMPLETE; p99 and advisor cleanup are deferred
PRIVACY_STATUS=PASS for effective RLS/grants and adversarial actor isolation;
  two source bundle readbacks remain unknown
ACCOUNT_LIFECYCLE_STATUS=PASS for deletion/revocation/retention contracts; orphan ops open
CROSS_PLATFORM_STATUS=PASS for iOS/Android backend contract accounting
BUILD33_COMPATIBILITY_STATUS=PASS except the documented reaction-token sequencing blocker
CROSS_FEATURE_STATUS=PARTIAL; frontend token sequencing and wearable authority remain open
```

## Frontend blockers and debt ledger

`B34-FE-DR-001` is a shared iOS/Android blocker: the public Dressing Room
route calls `get_item_reaction_counts` with only `p_item_ids`, while staging's
secure anonymous contract requires the route's live `p_share_token`. The client
must be repaired in the next campaign; weakening the backend is prohibited.

Deferred P4–P10 / known debt: 22 unindexed-FK advisor findings (25 including
storage internals), 102 auth-RLS init-plan advisories, 74 unused indexes, six
multiple-permissive-policy advisories, small-data performance uncertainty,
retired diagnostic residue, and active ungoverned wearable/website surfaces.
These are recorded as debt/unknowns, not claimed as green certification.

## Environment migration manifest

```text
SOURCE_BASELINE=origin/rebuild/backend-authority-v2 @ d24d4afd214b55ae10f9f360d82b83e8c29be0b9
RELEASE_BASELINE=origin/release/kscan-pre-freeze-v1 @ c6ee31adb0932d4d476cc218c1a7bff434b10bc8
STAGING_LEDGER=171 rows; all active source versions accounted for by the
  authority manifest or explicit remote-only classifications
STAGING_FUNCTIONS_REPAIRED=scan-identify:v73, process-account-deletions:v68,
  search-vinted-secondhand:v58, reconcile-orphan-media:v1
STAGING_FUNCTIONS_RECONCILED_WITHOUT_DEPLOY=commerce-watch-refresh:v12
PRODUCTION_MIGRATION=NOT RUN; production remains a frozen future target
```

`config/migration-authority-manifest.json` and
`config/edge-function-manifest.json` are the reproducible inputs for the next,
separate production migration campaign. The next campaign must re-verify
remote production state before any action; this report is not production
approval.

## Required final assertions

```text
FRONTEND_BLOCKERS_DOCUMENTED=YES
MIGRATION_MANIFEST_COMPLETE=YES for source/staging reconciliation
ALL_RLS_AUDITED=YES
ALL_SECURITY_DEFINER_AUDITED=YES
ALL_RPC_GRANTS_AUDITED=YES
ALL_EDGE_FUNCTIONS_AUDITED=NO (two readback unknowns + ungoverned surfaces)
ALL_STORAGE_AUDITED=YES (no destructive mutation)
ALL_WORKERS_AUDITED=YES for governed source contracts; orphan operations incomplete
ALL_PROVIDERS_AUDITED=NO globally because wearable authority is external/ungoverned
ALL_CUSTOMER_MUTATIONS_AUDITED=YES for audited governed paths
IOS_ANDROID_CONTRACTS_ACCOUNTED_FOR=YES
BUILD33_COMPATIBILITY_ACCOUNTED_FOR=YES
PERFORMANCE_PHASE_COMPLETE=NO
PRIVACY_PHASE_COMPLETE=YES for effective catalog; source readback unknowns remain
CROSS_FEATURE_PHASE_COMPLETE=NO
```

```text
NEXT_OWNER_ACTION=
1. Configure ORPHAN_MEDIA_SWEEP_SECRET in staging through the approved secret
   manager and add a separately governed scheduler/invoker; prove dry-run with
   zero deletions before enabling any live sweep.
2. Repair the public-room client to pass p_share_token and add wrong/revoked/
   expired-token regression coverage.
3. Bring privacy-controls/public-sale-share-opt-out and wearable functions under
   a reviewed backend authority, then repeat source readback and hostile runtime
   coverage. Only after those gates and performance closure may a separate owner-
   authorized campaign construct the production migration plan.
```
